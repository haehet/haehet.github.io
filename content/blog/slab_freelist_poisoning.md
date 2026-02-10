+++
date = '2026-02-09T19:09:35+09:00'
draft = false
title = 'Slab free list poisoning'
categories = ['Linux kernel']
tags = ['kernel exploit']
hideSummary = true
+++


이번 글에서는 aaw primitive가 얻기 힘든상황에서 사용하기 좋은 slab free list poisoning에 대해서 정리해보겠다.

## 1. slab free list의 구조 

 보통 ptmalloc 같은 userland의 free chunk 구조를 보면 청크 앞부분에 다음 freelist를 저장한다. 커널은 특이하게 중간 부분에 next pointer를 저장한다. 이는 작은 overflow로 캐시의 freelist가 조작되는 것을 막기 위함이다. 해당 내용은 **calculate_sizes** 함수에서 확인 가능하다.

```c
	if ((flags & (SLAB_TYPESAFE_BY_RCU | SLAB_POISON)) || s->ctor ||
	    ((flags & SLAB_RED_ZONE) &&
	     (s->object_size < sizeof(void *) || slub_debug_orig_size(s)))) {
		/*
		 * Relocate free pointer after the object if it is not
		 * permitted to overwrite the first word of the object on
		 * kmem_cache_free.
		 *
		 * This is the case if we do RCU, have a constructor or
		 * destructor, are poisoning the objects, or are
		 * redzoning an object smaller than sizeof(void *) or are
		 * redzoning an object with slub_debug_orig_size() enabled,
		 * in which case the right redzone may be extended.
		 *
		 * The assumption that s->offset >= s->inuse means free
		 * pointer is outside of the object is used in the
		 * freeptr_outside_object() function. If that is no
		 * longer true, the function needs to be modified.
		 */
		s->offset = size;
		size += sizeof(void *);
	} else {
		/*
		 * Store freelist pointer near middle of object to keep
		 * it away from the edges of the object to avoid small
		 * sized over/underflows from neighboring allocations.
		 */
		s->offset = ALIGN_DOWN(s->object_size / 2, sizeof(void *));
	}
```

다음과 같이 **s->offset**을 object의 **중간에** 두는 것을 확인 할 수 있다. 그 후 **get_freepointer**함수에서 그걸 다시 참조한다.

```c
static inline void *get_freepointer(struct kmem_cache *s, void *object)
{
	unsigned long ptr_addr;
	freeptr_t p;

	object = kasan_reset_tag(object);
	ptr_addr = (unsigned long)object + s->offset;
	p = *(freeptr_t *)(ptr_addr);
	return freelist_ptr_decode(s, p, ptr_addr);
}
```

공격자는 간단히 해당 next pointer를 조작함으로써 원하는 곳에 할당을 받을 수 있다. 물론 커널에도 해당 기법을 막기 위한 보안 설정이 있다. 예전 글에서 설명한 적 있지만 더 자세히 설명 해보겠다.
&nbsp;
## 2.  Freelist randomization

config_slab_freelist_random으로 활성화 하는 보안 기법이다. 다음과 같은 호출 흐름을 따른다.

```c
kmem_cache_init -> init_freelist_randomization -> init_cache_random_seq
```

```c
#ifdef CONFIG_SLAB_FREELIST_RANDOM
/* Pre-initialize the random sequence cache */
static int init_cache_random_seq(struct kmem_cache *s)
{
	unsigned int count = oo_objects(s->oo);
	int err;

	/* Bailout if already initialised */
	if (s->random_seq)
		return 0;

	err = cache_random_seq_create(s, count, GFP_KERNEL);
	if (err) {
		pr_err("SLUB: Unable to initialize free list for %s\n",
			s->name);
		return err;
	}

	/* Transform to an offset on the set of pages */
	if (s->random_seq) {
		unsigned int i;

		for (i = 0; i < count; i++)
			s->random_seq[i] *= s->size;
	}
	return 0;
}
```

다음과 같이 각 kmem_cache가 가지는 s->random_seq 값에 따라 freelist를 랜덤화 한다. 공격자가 힙의 할당을 예상하기 어렵게 만들긴 하지만, 많은 heap spraying을 통해 bypass할 수 있다.
&nbsp;
## 3. Slab freelist hardened

직접적으로  free list poisoning을 막는 보안기법이다.

```c
set_freepointer -> freelist_ptr_encode
```

다음과 같이 config_slab_freelist_hardended가 켜져있으면 next를 암호화한다.

```c
/*
 * Returns freelist pointer (ptr). With hardening, this is obfuscated
 * with an XOR of the address where the pointer is held and a per-cache
 * random number.
 */
static inline freeptr_t freelist_ptr_encode(const struct kmem_cache *s,
					    void *ptr, unsigned long ptr_addr)
{
	unsigned long encoded;

#ifdef CONFIG_SLAB_FREELIST_HARDENED
	encoded = (unsigned long)ptr ^ s->random ^ swab(ptr_addr);
#else
	encoded = (unsigned long)ptr;
#endif
	return (freeptr_t){.v = encoded};
}
```

bypass는 생각보다 간단하다. **Freelist**의 마지막 청크는 **next ptr**로 NULL을 가지므로 **encoded**는 NULL ^ s->random ^ swab(ptr_addr)이다. NULL은 xor연산에서 무시 되므로 두개의 encoded pointer를 얻으면 힙 주소를 얻을 수 있다.

```c
encoded1 = NULL ^ s->random ^ swab(encode1_addr)
encoded2 = encoed1_addr ^ s->random ^ swab(encode2_addr)

encode1 ^ encode2 = swab(encode1_addr) ^ encoed1_addr ^ swab(encode2_addr)
```

그 후 약간의 주소 보정을 하면(힙 주소가 나오게 마스킹해주면 된다.) 완전한 heap 주소를 leak 할 수 있다.

reference:

[https://spinlock.io/posts/heap-havoc/](https://spinlock.io/posts/heap-havoc/)

[https://elixir.bootlin.com/linux/v6.11.4/source/mm/slub.c](https://elixir.bootlin.com/linux/v6.11.4/source/mm/slub.c)

[https://velog.io/@dandb3/Linux-Kernel-kernel-heap-hardening](https://velog.io/@dandb3/Linux-Kernel-kernel-heap-hardening)