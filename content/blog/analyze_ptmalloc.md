+++
date = '2026-02-10T11:17:36+09:00'
draft = false
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

다음 구조체를 덮어서 우리가 원하는 주소로 조작할 수 있으면 원하는 주소에 할당을 받을 수 있다. 해당 방법을 [tcache_metadata_poisoning](https://github.com/shellphish/how2heap/blob/master/glibc_2.39/tcache_metadata_poisoning.c)이라고한다.

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

> tcache의 free된 chunk들은 `safe linking`이라는 보안기법이 걸려있다. 다음과 같이 `(pos >> 12) XOR ptr`를 저장한다.
```c
#define PROTECT_PTR(pos, ptr) \
  ((__typeof (ptr)) ((((size_t) pos) >> 12) ^ ((size_t) ptr)))
#define REVEAL_PTR(ptr)  PROTECT_PTR (&ptr, ptr)
```
&nbsp; 
### 1.4 _int_malloc()

`_int_malloc()` 함수를 분석하기 전에 먼저 각 chunk의 구조와 bin들에 대해 알아보자. 각각의 청크들은 `malloc_chunk` 구조체를 통해 정의된다.

```c
struct malloc_chunk {

  INTERNAL_SIZE_T      mchunk_prev_size;  /* Size of previous chunk (if free).  */
  INTERNAL_SIZE_T      mchunk_size;       /* Size in bytes, including overhead. */

  struct malloc_chunk* fd;         /* double links -- used only if free. */
  struct malloc_chunk* bk;

  /* Only used for large blocks: pointer to next larger size.  */
  struct malloc_chunk* fd_nextsize; /* double links -- used only if free. */
  struct malloc_chunk* bk_nextsize;
};
```
![chunk 구조를 나타낸 그림](/blog/analyze_ptmalloc/2026-02-10-17-31-51.png)

bin들은 위에서 설명한 `malloc_state` 구조체 내부에 구현되어 있다. 

```c
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
```

`mchunkptr bins`의 인덱싱은 다음과 같이 된다.
![asdf](/blog/analyze_ptmalloc/2026-02-10-17-57-11.png) 

이제 본격적으로 `_int_malloc()` 함수를 분석해보자. 먼저 이 함수에서 사용되는 변수들은 다음과 같이 선언된다.
```c
static void *
_int_malloc (mstate av, size_t bytes)
{
  INTERNAL_SIZE_T nb;               /* normalized request size */
  unsigned int idx;                 /* associated bin index */
  mbinptr bin;                      /* associated bin */

  mchunkptr victim;                 /* inspected/selected chunk */
  INTERNAL_SIZE_T size;             /* its size */
  int victim_index;                 /* its bin index */

  mchunkptr remainder;              /* remainder from a split */
  unsigned long remainder_size;     /* its size */

  unsigned int block;               /* bit map traverser */
  unsigned int bit;                 /* bit map traverser */
  unsigned int map;                 /* current word of binmap */

  mchunkptr fwd;                    /* misc temp for linking */
  mchunkptr bck;                    /* misc temp for linking */
```

먼저 `_int_malloc()`는 fastbin에 적합한 size인지 확인 후 청크를 가져온다. 또한 해당 `fastbin`에 있는 청크를 tcache로 가져온다. (`tcache stashing`)

```c
     If the size qualifies as a fastbin, first check corresponding bin.
     This code is safe to execute even if av is not yet initialized, so we
     can try it without checking, which saves some time on this fast path.
   */

#define REMOVE_FB(fb, victim, pp)			\
  do							\
    {							\
      victim = pp;					\
      if (victim == NULL)				\
	break;						\
      pp = REVEAL_PTR (victim->fd);                                     \
      if (__glibc_unlikely (pp != NULL && misaligned_chunk (pp)))       \
	malloc_printerr ("malloc(): unaligned fastbin chunk detected"); \
    }							\
  while ((pp = catomic_compare_and_exchange_val_acq (fb, pp, victim)) \
	 != victim);					\

  if ((unsigned long) (nb) <= (unsigned long) (get_max_fast ()))
    {
      idx = fastbin_index (nb);
      mfastbinptr *fb = &fastbin (av, idx);
      mchunkptr pp;
      victim = *fb;

      if (victim != NULL)
	{
	  if (__glibc_unlikely (misaligned_chunk (victim)))
	    malloc_printerr ("malloc(): unaligned fastbin chunk detected 2");

	  if (SINGLE_THREAD_P)
	    *fb = REVEAL_PTR (victim->fd);
	  else
	    REMOVE_FB (fb, pp, victim);
	  if (__glibc_likely (victim != NULL))
	    {
	      size_t victim_idx = fastbin_index (chunksize (victim));
	      if (__builtin_expect (victim_idx != idx, 0))
		malloc_printerr ("malloc(): memory corruption (fast)");
	      check_remalloced_chunk (av, victim, nb);
#if USE_TCACHE
	      /* While we're here, if we see other chunks of the same size,
		 stash them in the tcache.  */
	      size_t tc_idx = csize2tidx (nb);
	      if (tcache != NULL && tc_idx < mp_.tcache_bins)
		{
		  mchunkptr tc_victim;

		  /* While bin not empty and tcache not full, copy chunks.  */
		  while (tcache->counts[tc_idx] < mp_.tcache_count
			 && (tc_victim = *fb) != NULL)
		    {
		      if (__glibc_unlikely (misaligned_chunk (tc_victim)))
			malloc_printerr ("malloc(): unaligned fastbin chunk detected 3");
		      if (SINGLE_THREAD_P)
			*fb = REVEAL_PTR (tc_victim->fd);
		      else
			{
			  REMOVE_FB (fb, pp, tc_victim);
			  if (__glibc_unlikely (tc_victim == NULL))
			    break;
			}
		      tcache_put (tc_victim, tc_idx);
		    }
		}
#endif
	      void *p = chunk2mem (victim);
	      alloc_perturb (p, bytes);
	      return p;
	    }
	}
    }
```

`fastbin`에 맞지 않는다면 `small bin`에서 찾는다. 또한 `small bin`에 있는 청크를 `tcache`로 가져온다. 

여기서 주목해야 할 점은 `small bin`에서 `tcache`로 청크를 옮길 때 `small bin`의 환형 연결리스트의 구조를 검사하지 않는다. `small bin`은 `fast bin`과 다른게 `safe linking`이 적용되지 않기 때문에 이를 이용하면 `small bin`의 `bk`를 조작하여서 원하는 주소에 할당을 받을 수 있다. 이를 [tcache stashing unlink attack](https://github.com/shellphish/how2heap/blob/master/glibc_2.39/tcache_stashing_unlink_attack.c)이라고한다.
```c
  if (in_smallbin_range (nb))
    {
      idx = smallbin_index (nb);
      bin = bin_at (av, idx);

      if ((victim = last (bin)) != bin)
        {
          bck = victim->bk;
	  if (__glibc_unlikely (bck->fd != victim))
	    malloc_printerr ("malloc(): smallbin double linked list corrupted");
          set_inuse_bit_at_offset (victim, nb);
          bin->bk = bck;
          bck->fd = bin;

          if (av != &main_arena)
	    set_non_main_arena (victim);
          check_malloced_chunk (av, victim, nb);
#if USE_TCACHE
	  /* While we're here, if we see other chunks of the same size,
	     stash them in the tcache.  */
	  size_t tc_idx = csize2tidx (nb);
	  if (tcache != NULL && tc_idx < mp_.tcache_bins)
	    {
	      mchunkptr tc_victim;

	      /* While bin not empty and tcache not full, copy chunks over.  */
	      while (tcache->counts[tc_idx] < mp_.tcache_count
		     && (tc_victim = last (bin)) != bin)
		{
		  if (tc_victim != 0)
		    {
		      bck = tc_victim->bk;
		      set_inuse_bit_at_offset (tc_victim, nb);
		      if (av != &main_arena)
			set_non_main_arena (tc_victim);
		      bin->bk = bck;
		      bck->fd = bin;

		      tcache_put (tc_victim, tc_idx);
	            }
		}
	    }
#endif
          void *p = chunk2mem (victim);
          alloc_perturb (p, bytes);
          return p;
        }
    }
```

그 다음으로 `large bin` 이상의 크기가 들어오면 먼저 `외부 단편화` 문제를 해결하기 위해 `malloc_consolidate()` 함수를 호출한다. 

```c
  else
    {
      idx = largebin_index (nb);
      if (atomic_load_relaxed (&av->have_fastchunks))
        malloc_consolidate (av);
    }

```

`malloc_consolidate()`는 fastbin을 비우고 각 fastbin chunk를 꺼내면서 인접 free chunk들과 병합 한 뒤 결과를 unsorted bin(또는 top)으로 이동시킨다.

```c
static void malloc_consolidate(mstate av)
{
  mfastbinptr*    fb;                 /* current fastbin being consolidated */
  mfastbinptr*    maxfb;              /* last fastbin (for loop control) */
  mchunkptr       p;                  /* current chunk being consolidated */
  mchunkptr       nextp;              /* next chunk to consolidate */
  mchunkptr       unsorted_bin;       /* bin header */
  mchunkptr       first_unsorted;     /* chunk to link to */

  /* These have same use as in free() */
  mchunkptr       nextchunk;
  INTERNAL_SIZE_T size;
  INTERNAL_SIZE_T nextsize;
  INTERNAL_SIZE_T prevsize;
  int             nextinuse;

  atomic_store_relaxed (&av->have_fastchunks, false);

  unsorted_bin = unsorted_chunks(av);

  /*
    Remove each chunk from fast bin and consolidate it, placing it
    then in unsorted bin. Among other reasons for doing this,
    placing in unsorted bin avoids needing to calculate actual bins
    until malloc is sure that chunks aren't immediately going to be
    reused anyway.
  */

  maxfb = &fastbin (av, NFASTBINS - 1);
  fb = &fastbin (av, 0);
  do {
    p = atomic_exchange_acquire (fb, NULL);
    if (p != 0) {
      do {
	{
	  if (__glibc_unlikely (misaligned_chunk (p)))
	    malloc_printerr ("malloc_consolidate(): "
			     "unaligned fastbin chunk detected");

	  unsigned int idx = fastbin_index (chunksize (p));
	  if ((&fastbin (av, idx)) != fb)
	    malloc_printerr ("malloc_consolidate(): invalid chunk size");
	}

	check_inuse_chunk(av, p);
	nextp = REVEAL_PTR (p->fd);

	/* Slightly streamlined version of consolidation code in free() */
	size = chunksize (p);
	nextchunk = chunk_at_offset(p, size);
	nextsize = chunksize(nextchunk);

	if (!prev_inuse(p)) {
	  prevsize = prev_size (p);
	  size += prevsize;
	  p = chunk_at_offset(p, -((long) prevsize));
	  if (__glibc_unlikely (chunksize(p) != prevsize))
	    malloc_printerr ("corrupted size vs. prev_size in fastbins");
	  unlink_chunk (av, p);
	}

	if (nextchunk != av->top) {
	  nextinuse = inuse_bit_at_offset(nextchunk, nextsize);

	  if (!nextinuse) {
	    size += nextsize;
	    unlink_chunk (av, nextchunk);
	  } else
	    clear_inuse_bit_at_offset(nextchunk, 0);

	  first_unsorted = unsorted_bin->fd;
	  unsorted_bin->fd = p;
	  first_unsorted->bk = p;

	  if (!in_smallbin_range (size)) {
	    p->fd_nextsize = NULL;
	    p->bk_nextsize = NULL;
	  }

	  set_head(p, size | PREV_INUSE);
	  p->bk = unsorted_bin;
	  p->fd = first_unsorted;
	  set_foot(p, size);
	}

	else {
	  size += nextsize;
	  set_head(p, size | PREV_INUSE);
	  av->top = p;
	}

      } while ( (p = nextp) != 0);

    }
  } while (fb++ != maxfb);
}
```

그 후 `_int_malloc()`는 `unsorted bin`에서 청크를 찾는 로직을 수행한다. 먼저 `_int_malloc()`는 현재 청크의 범위가 `small bin`이고 `unsorted bin`에 1개의 chunk만 있을 때  `unsorted bin`에서의 분할을 시도한다.

```c
             /* If a small request, try to use last remainder if it is the
             only chunk in unsorted bin.  This helps promote locality for
             runs of consecutive small requests. This is the only
             exception to best-fit, and applies only when there is
             no exact fit for a small chunk.
           */

          if (in_smallbin_range (nb) &&
              bck == unsorted_chunks (av) &&
              victim == av->last_remainder &&
              (unsigned long) (size) > (unsigned long) (nb + MINSIZE))
            {
              /* split and reattach remainder */
              remainder_size = size - nb;
              remainder = chunk_at_offset (victim, nb);
              unsorted_chunks (av)->bk = unsorted_chunks (av)->fd = remainder;
              av->last_remainder = remainder;
              remainder->bk = remainder->fd = unsorted_chunks (av);
              if (!in_smallbin_range (remainder_size))
                {
                  remainder->fd_nextsize = NULL;
                  remainder->bk_nextsize = NULL;
                }

              set_head (victim, nb | PREV_INUSE |
                        (av != &main_arena ? NON_MAIN_ARENA : 0));
              set_head (remainder, remainder_size | PREV_INUSE);
              set_foot (remainder, remainder_size);

              check_malloced_chunk (av, victim, nb);
              void *p = chunk2mem (victim);
              alloc_perturb (p, bytes);
              return p;
            }

          /* remove from unsorted list */
          unsorted_chunks (av)->bk = bck;
          bck->fd = unsorted_chunks (av);

```

만약  `small bin 범위 size`에서 size가 완벽히 맞는 chunk를 찾으면 (exact fit) `tcache` 채우기를 시도 하고 실패하면 할당 해준다.
```c
          /* Take now instead of binning if exact fit */

          if (size == nb)
            {
              set_inuse_bit_at_offset (victim, size);
              if (av != &main_arena)
		set_non_main_arena (victim);
#if USE_TCACHE
	      /* Fill cache first, return to user only if cache fills.
		 We may return one of these chunks later.  */
	      if (tcache_nb > 0
		  && tcache->counts[tc_idx] < mp_.tcache_count)
		{
		  tcache_put (victim, tc_idx);
		  return_cached = 1;
		  continue;
		}
	      else
		{
#endif
              check_malloced_chunk (av, victim, nb);
              void *p = chunk2mem (victim);
              alloc_perturb (p, bytes);
              return p;
#if USE_TCACHE
		}
#endif
            }
```