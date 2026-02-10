+++
date = '2026-02-10T11:17:36+09:00'
draft = true
title = 'ptmalloc2 분석'
categories = ['Pwnable']
tags = ['Memory Management', 'Open source analyze']
hideSummary = true
+++


이번 글에서는 glibc 2.39의 `ptmalloc2`에 대해서 분석해보겠다. 이미 ptmalloc를 분석하는 글들이 많이 있지만 이 추상화 없이 코드 자체를 분석해보겠다.


## 1. malloc 

우리가 코드에서 `malloc(..)`을 호출하면 내부에서 `__libc_malloc(...)` 함수가 호출된다. 

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
> `line 11:` 만약 `ptmmalloc`가 초기화가 안되어있다면  `ptmalloc_init()` 함수를 호출하여 초기화 시킨다.


> `line 13~43:` 만약 `tcache`를 사용한다면 `MAYBE_INIT_TCACHE()`를 통해 tcache를 초기화 하고 해당 `tcache idx`에 해당하는 tcache bin의 수를 확인 후 해당 bin에서 가져온다.


> `line 45~46:` tcache에 청크를 가져오지 못했다면 **_int_malloc** 함수를 호출하여 청크를 할당 받는다.

> `line 47~60:` 위에서도 할당을 받는데 실패했더면 다른 `arena`에서 한번 더 할당을 시도한다.  

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