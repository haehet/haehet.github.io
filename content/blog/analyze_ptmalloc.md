+++
date = '2026-02-10T11:17:36+09:00'
draft = true
title = 'ptmalloc2 분석'
categories = ['Pwnable']
tags = ['Memory Management', 'Open source analyze']
hideSummary = true
+++


이번 글에서는 glibc 2.39의 `ptmalloc2`에 대해서 분석해보겠다. 이미 ptmalloc를 분석하는 글들이 많이 있지만 이 추상화 없이 코드 자체를 분석해보겠다. (다음 글은 ptmalloc에 대한 기본적인 지식이 없다면 조금 어려울 수도 있따.)


## 1. malloc 

우리가 코드에서 `malloc(..)`을 호출하면 내부에서 `__libc_malloc(...)` 함수가 호출된다. `__libc_malloc()` 함수의 호출 흐름을 따라가면서 분석을 해보자

```c
void *
__libc_malloc (size_t bytes)
{
  mstate ar_ptr;
  void *victim;

  _Static_assert (PTRDIFF_MAX <= SIZE_MAX / 2,
                  "PTRDIFF_MAX is not more than half of SIZE_MAX");

  if (!__malloc_initialized)
    ptmalloc_init ();

#if USE_TCACHE
  /* int_free also calls request2size, be careful to not pad twice.  */
  size_t tbytes = checked_request2size (bytes);
  if (tbytes == 0)
    {
      __set_errno (ENOMEM);
      return NULL;
    }

  size_t tc_idx = csize2tidx (tbytes);

  MAYBE_INIT_TCACHE ();

  DIAG_PUSH_NEEDS_COMMENT;
  if (tc_idx < mp_.tcache_bins
      && tcache != NULL
      && tcache->counts[tc_idx] > 0)
    {
      victim = tcache_get (tc_idx);
      return tag_new_usable (victim);
    }
  DIAG_POP_NEEDS_COMMENT;
#endif

  if (SINGLE_THREAD_P)
    {
      victim = tag_new_usable (_int_malloc (&main_arena, bytes));
      assert (!victim || chunk_is_mmapped (mem2chunk (victim)) ||
              &main_arena == arena_for_chunk (mem2chunk (victim)));
      return victim;
    }

  arena_get (ar_ptr, bytes);
  victim = _int_malloc (ar_ptr, bytes);

  /* Retry with another arena only if we were able to find a usable arena
     before.  */
  if (!victim && ar_ptr != NULL)
    {
      LIBC_PROBE (memory_malloc_retry, 1, bytes);
      ar_ptr = arena_get_retry (ar_ptr, bytes);
      victim = _int_malloc (ar_ptr, bytes);
    }

  if (ar_ptr != NULL)
    __libc_lock_unlock (ar_ptr->mutex);

  victim = tag_new_usable (victim);

  assert (!victim || chunk_is_mmapped (mem2chunk (victim)) ||
          ar_ptr == arena_for_chunk (mem2chunk (victim)));

  return victim;
}
```
> `line 11:` 만약 `ptmalloc`가 초기화가 안되어있다면  `ptmalloc_init()` 함수를 호출하여 초기화 시킨다.


> `line 13~43:` 만약 `tcache`를 사용한다면 `MAYBE_INIT_TCACHE()`를 통해 tcache를 초기화 하고 해당 `tcache idx`에 해당하는 tcache bin의 수를 확인 후 해당 bin에서 가져온다.


> `line 45~46:` tcache에 청크를 가져오지 못했다면 **_int_malloc** 함수를 호출하여 청크를 할당 받는다.

> `line 47~60:` 위에서도 할당에 실패했다면 다른 `arena`에서 한번 더 할당을 시도한다.  

&nbsp;

### 1.1 ptmalloc_init()
`ptmalloc_init`에서는 `tcache key`등을 초기화 한다.  
그리고 `malloc_init_state (&main_arena)`를 호출하여 main arena를 초기화 한다.

```c
static void
ptmalloc_init (void)
{
  if (__malloc_initialized)
    return;

  __malloc_initialized = true;

#if USE_TCACHE
  tcache_key_initialize ();
#endif
...

  thread_arena = &main_arena;
  malloc_init_state (&main_arena);
```
`malloc_init_state()`는 다음과 같이 bin을 초기화 하고 arena의 top 주소를 초기화한다.
```c
static void
malloc_init_state (mstate av)
{
  int i;
  mbinptr bin;

  /* Establish circular links for normal bins */
  for (i = 1; i < NBINS; ++i)
    {
      bin = bin_at (av, i);
      bin->fd = bin->bk = bin;
    }

#if MORECORE_CONTIGUOUS
  if (av != &main_arena)
#endif
  set_noncontiguous (av);
  if (av == &main_arena)
    set_max_fast (DEFAULT_MXFAST);
  atomic_store_relaxed (&av->have_fastchunks, false);

  av->top = initial_top (av);
}
```


`arena`란 멀티스레드 환경에서 메모리 할당(malloc) 시 발생하는 잠금 경쟁(Lock Contention)과 성능 저하를 방지하기 위해 스레드별로 독립적인 힙 메모리 영역을 관리하는 구조체이다.
`arena`를 정의하는 `malloc_state`구조체는 다음과 같다.

```c
struct malloc_state
{
  /* Serialize access.  */
  __libc_lock_define (, mutex);

  /* Flags (formerly in max_fast).  */
  int flags;

  /* Set if the fastbin chunks contain recently inserted free blocks.  */
  /* Note this is a bool but not all targets support atomics on booleans.  */
  int have_fastchunks;

  /* Fastbins */
  mfastbinptr fastbinsY[NFASTBINS];

  /* Base of the topmost chunk -- not otherwise kept in a bin */
  mchunkptr top;

  /* The remainder from the most recent split of a small request */
  mchunkptr last_remainder;

  /* Normal bins packed as described above */
  mchunkptr bins[NBINS * 2 - 2];

  /* Bitmap of bins */
  unsigned int binmap[BINMAPSIZE];

  /* Linked list */
  struct malloc_state *next;

  /* Linked list for free arenas.  Access to this field is serialized
     by free_list_lock in arena.c.  */
  struct malloc_state *next_free;

  /* Number of threads attached to this arena.  0 if the arena is on
     the free list.  Access to this field is serialized by
     free_list_lock in arena.c.  */
  INTERNAL_SIZE_T attached_threads;

  /* Memory allocated from the system in this arena.  */
  INTERNAL_SIZE_T system_mem;
  INTERNAL_SIZE_T max_system_mem;
};
```
`arena`의 구조를 시각화 해보면 다음과 같다.

![](/blog/analyze_ptmalloc/2026-02-10-13-32-39.png)

&nbsp;
### 1.2 tcache_init()

tcache는 스레드 별로 빠르게 할당을 해주기 위해 만들어진 목적에 맞게 malloc_state가 아닌 다른 구조체에서 관리된다. 그 구조체는 `tcache_perthread_struct`이다. 
```c
static __thread tcache_perthread_struct *tcache = NULL;
typedef struct tcache_perthread_struct
{
  uint16_t counts[TCACHE_MAX_BINS];
  tcache_entry *entries[TCACHE_MAX_BINS];
} tcache_perthread_struct;
```

다음과 같이 간단하게 tcache 별로 counts, entries pointer를 가지고 있다. 또한 이 구조체를 가리키는 `tcache` 변수는 fsbase(TLS) 근처에 저장되어 있다.
![](/blog/analyze_ptmalloc/2026-02-10-13-42-51.png)

위에서 설명한 `MAYBE_INIT_TCACHE()`은 `tcache` 변수가 초기화 되어있지 않으면 `tcache_init()`을 호출한다.

```c
#define MAYBE_INIT_TCACHE() \
  if (__glibc_unlikely (tcache == NULL)) \
    tcache_init();
```

`tcache_init()` 함수는 `tcache_perthread_struct` 구조체를 `_int_malloc()` 함수를 통해 할당한다. 보통 우리가 heap을 보았을 때 제일 위에 있는 `0x290`짜리 chunk가 `tcache_perthread_struct`이다.


```c
static void
tcache_init(void)
{
  mstate ar_ptr;
  void *victim = 0;
  const size_t bytes = sizeof (tcache_perthread_struct);

  if (tcache_shutting_down)
    return;

  arena_get (ar_ptr, bytes);
  victim = _int_malloc (ar_ptr, bytes);
  if (!victim && ar_ptr != NULL)
    {
      ar_ptr = arena_get_retry (ar_ptr, bytes);
      victim = _int_malloc (ar_ptr, bytes);
    }


  if (ar_ptr != NULL)
    __libc_lock_unlock (ar_ptr->mutex);

  /* In a low memory situation, we may not be able to allocate memory
     - in which case, we just keep trying later.  However, we
     typically do this very early, so either there is sufficient
     memory, or there isn't enough memory to do non-trivial
     allocations anyway.  */
  if (victim)
    {
      tcache = (tcache_perthread_struct *) victim;
      memset (tcache, 0, sizeof (tcache_perthread_struct));
    }

}
```
다음과 같이 `heap chunks`를 통해 tcache_perthread_struct의 모습을 볼 수 있다.
![](/blog/analyze_ptmalloc/2026-02-10-13-43-56.png)

이를 바탕으로 `tcache`의 구조를 정리하면, 각 `tc_idx`(tcache bin index)마다
- 해당 bin에 들어있는 청크 개수(`counts[tc_idx]`)
- 단일 연결 리스트의 head 포인터(`entries[tc_idx]`)
를 가지는 형태임을 알 수 있다.

![](/blog/analyze_ptmalloc/2026-02-10-13-50-08.png)


&nbsp;
### 1.3 tcache_get()
`tcache_get()` 함수는 tcache에서 bin을 가져온다. 내부에서는 `tcache_get_n()` 함수를 호출한다.
```c
/* Like the above, but removes from the head of the list.  */
static __always_inline void *
tcache_get (size_t tc_idx)
{
  return tcache_get_n (tc_idx, & tcache->entries[tc_idx]);
}
```

`tcache_get_n()`은 다음과 같이 `tcache entry`에서 청크를 가져온다.

```c
static __always_inline void *
tcache_get_n (size_t tc_idx, tcache_entry **ep)
{
  tcache_entry *e;
  if (ep == &(tcache->entries[tc_idx]))
    e = *ep;
  else
    e = REVEAL_PTR (*ep);

  if (__glibc_unlikely (!aligned_OK (e)))
    malloc_printerr ("malloc(): unaligned tcache chunk detected");

  if (ep == &(tcache->entries[tc_idx]))
      *ep = REVEAL_PTR (e->next);
  else
    *ep = PROTECT_PTR (ep, REVEAL_PTR (e->next));

  --(tcache->counts[tc_idx]);
  e->key = 0;
  return (void *) e;
}
```
&nbsp;

> tcache의 free된 chunk들은 `safe linking`이라는 보안기법이 걸려있다. 다음과 같이 `자기 자신의 주소 >> 12` ^ `다음 chunk`를 저장한다.
```c
#define PROTECT_PTR(pos, ptr) \
  ((__typeof (ptr)) ((((size_t) pos) >> 12) ^ ((size_t) ptr)))
#define REVEAL_PTR(ptr)  PROTECT_PTR (&ptr, ptr)
```


