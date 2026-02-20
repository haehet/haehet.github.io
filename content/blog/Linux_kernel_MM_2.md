+++
date = '2026-02-09T17:53:51+09:00'
draft = false
title = '메모리 관리 2: Page Allocator (PCP & Buddy System)'
categories = ['Linux kernel']
tags = ['Memory Management']
hideSummary = true
+++

이번 글에서는 slub allocator에 대해 공부하기 전에 리눅스의 메모리 관리 시스템 중에서도 페이지 단위 물리 메모리 할당을 담당하는 Page Allocator를 먼저 정리해보겠다. (궁금한 내용을 인터넷에 돌아다니며 정리한 것이므로 틀린 내용이 있을 수도 있습니다.)

## 1. NUMA(Non-Uniform Memory Access)와 Zones, Free Lists

  NUMA란 **멀티 프로세서 환경에서 적용되는 메모리 접근 방식**이다. 멀티 프로세서 환경에서는 단일 버스를 공유하기 때문에 여러개의 CPU가 하나의 메모리에 접근 하게 되면 한개의 cpu를 제외하고 전부 block상태가 되어서 메모리 처리가 늦어지는 **병목현상**이 발생한다. NUMA는 이런 단점을 해결하였다. NUMA 시스템에서는 CPU를 몇개의 그룹으로 나누고 각 그룹에게 별도의 지역 메모리를 할당해준다. NUMA 환경에서 각각의 **NUMA node**의 메모리 설계는 다음과 같이 **pglist_data**구조체로 표현된다.

```c
typedef struct pglist_data {
	/*
	 * node_zones contains just the zones for THIS node. Not all of the
	 * zones may be populated, but it is the full list. It is referenced by
	 * this node's node_zonelists as well as other node's node_zonelists.
	 */
	struct zone node_zones[MAX_NR_ZONES];
	/*
	 * node_zonelists contains references to all zones in all nodes.
	 * Generally the first zones will be references to this node's
	 * node_zones.
	 */
	struct zonelist node_zonelists[MAX_ZONELISTS];
	// ...
}
```

각 **node**의 memory는 여러개의 **zone**으로 나뉜다. 각각의 **zone**은 메모리의 다음 영역을 나타낸다.

(예전 글에서 설명 한 적 있지만 다시 넣음)

 **ZONE_DMA, ZONE_DMA32:** DMA 주소 폭 제약(16MiB/4GiB) 때문에 커널이 장치가 접근 가능한 저주소 RAM에서만 DMA 버퍼를 할당하도록 분리해 둔 메모리 존이다.

 **ZONE_NORMAL:** 커널이 항상 직접 접근 할 수 있는 메모리이다.

 **ZONE_HIGHMEM:** 커널이 직접 가상 주소로 매핑하지 않는 물리 메모리이다. (일부 32-bit에서만 활성화 된다.)

각각의 **memory zone**은 다음과 같이 **zone 구조체**로 묘사된다.

```c
struct zone {
	// ...
	struct per_cpu_pages	__percpu *per_cpu_pageset;
	// ...
	struct free_area	free_area[NR_PAGE_ORDERS];
	// ...
}
```

**Per-CPU** **area:** 이 영역은 **per_cpu_pages**구조체에 의해 나타내지며 **setup_zone_pages()** 함수에 의해 초기화 된다.

> **per_cpu_area**는 주로 cpu의 요청을 빨리 만족시키기 위한 **page cache**로 사용된다.

**Buddy free area:** 만약 **Per-CPU lists**가 page 요구를 만족시키지 못하거나 요구된 order가 PAGE_ALLOC_COSTLR_ORDER보다 크다면 이 영역에 있는 페이지들이 사용된다.

```c
struct per_cpu_pages {
	spinlock_t lock;	    /* Protects lists field */
	int count;		    /* number of pages in the list */
	int high;		    /* high watermark, emptying needed */
	int batch;		    /* chunk size for buddy add/remove */
	// ...
	struct list_head lists[NR_PCP_LISTS];
}
```

per_cpu_pages 구조체에서 page들은 list[] array에 있는 여러개의 lists들로 조직된다.

```c
struct free_area {
	struct list_head	free_list[MIGRATE_TYPES];
	unsigned long		nr_free;
};
```

free_area 구조체는 **migrration type**으로 인덱싱된 free lists array를 가지고 있다.

 여기서 migration type이란 page를 이동가능성(**mobility**)를 기준으로 분류하는 것이다. 예를 들어 커널의 선형 매핑 구간( 1:1 선형 매핑, phys map)에서 가상 주소는 물리 주소에 어떤 상수를 더해서 계산된다. 만약 이 물리 페이지의 내용을 옮긴다면(move) 그에 대응 하는 가상주소를 바꿔야 한다. 그런데 이렇게 되면 그 가상주소를 참조하고 있던 모든 코드가 **유효하지 않은 메모리 접근**이 발생할 수 있다. 이런 곳은 이동이 불가능하다.

![](https://blog.kakaocdn.net/dna/KWD2M/dJMcagYuTwu/AAAAAAAAAAAAAAAAAAAAAEyzZpet8zOd1GT1F-h-_J9Mevdl4QySpe2KGuX6sVmI/img.webp?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=xu6Q5vgogUh%2BYBpqyxZaf2GISHE%3D)

free area의 구조
&nbsp;
## 2. Buddy system의 동작

리눅스의 page allocator는 내부적으로 Buddy 메모리 할당 기법을 사용한다. 메모리는 **4KB**를  기본 단위로 하며 그보다 큰 블록은 이 단위를 2의 거듭제곱 단위(2ⁿ)로 묶어서 관리한다. 이때 지수 n을 **order**라고 부른다. 각 블록의 첫 페이지 구조체(struct page)의 page->private 필드에 order 값이 저장된다.

**할당 과정:** 필요한 order의 블록이 없을 때는 **더 큰 블록을 찾아서 반으로 쪼갠다(split)**. 예를 들어 order 2가 필요하지만 없으면 order 3 블록을 가져와 두 개의 order 2 블록으로 나누고 그중 하나를 사용한다. 나머지 하나는 free list에 반환된다. 이 과정을 반복해 최종적으로 원하는 크기의 페이지를 얻는다.

**해제 과정:** 반대로 페이지를 해제할 때, **짝(buddy) 블록이 비어 있다면 둘을 합쳐(coalesce)** 더 큰 order 블록으로 만든다.  
이 과정 **더 이상 합칠 수 없거나 MAX_ORDER(10)** 에 도달할 때까지 반복된다.
&nbsp;
## 3. __alloc_pages  분석 & fastpath와 slowpath

 먼저 분석을 시작하기에 앞서 kmalloc-cg-192 slab(CPU-partial slabs 포함)이 가득차서 커널이 새 슬랩을 만들기 위해 **__alloc_pages**를 호출하는 상황을 가정해보자. 이때 함수 호출은 다음과 같은 순서로 일어난다.

```c
    kzalloc()
        ... // All slabs full, allocate new one
        __kmem_cache_alloc_node()
            ...
            __slab_alloc() // Request order 0 page for kmalloc-cg-192
                allocate_slab()
                    alloc_slab_page()
                        ...
                        __alloc_pages() // Prepare the allocation context and attempt to get a page from freelists, else fallback to slowpath (__alloc_pages_slowpath())
                            get_page_from_freelist() // Try to get a page from the freelists of the preferred zone
                                rmqueue() // Order <= 3, use per-CPU lists else fallback to buddy
                                    rmqueue_pcplist() // Get PCP list by order and migration type
                                        __rmqueue_pcplist() // PCP empty? Fallback to buddy, else return page
                                            rmqueue_bulk() // Request multiple order 0 pages to populate PCP list
                                                __rmqueue() // Try to find a page for the designated order and migration type else fallback and steal page from other migration types (steal_suitable_fallback())
                                                    __rmqueue_smallest() // Iterate over 11 page orders, from 0 to 10 to find a free page
                                                        get_page_from_free_area() // Order N page found
                                                        del_page_from_free_list() // Unlink the page from the original freelist
                                                        expand() // Split into lower order pages if needed until order is 0
                                                            __add_to_free_list() // Add to new list
                                                            set_buddy_order() // Update page order
```

`__alloc_pages()`는 SLUB allocator 영역을 벗어난 첫 단계다. 이 함수는 요청된 order, 선호 node ID, GFP 플래그 등을 기반으로 **allocation context**를 준비한다. 이후 freelist에서 페이지를 시도(get_page_from_freelist()), 실패 시 **slowpath** (__alloc_pages_slowpath())로 전환한다.

```c
struct page *__alloc_pages(gfp_t gfp, unsigned int order, int preferred_nid,
							nodemask_t *nodemask)
{
	struct page *page;
	unsigned int alloc_flags = ALLOC_WMARK_LOW;
	gfp_t alloc_gfp; /* The gfp_t that was actually used for allocation */
	struct alloc_context ac = { };

	if (WARN_ON_ONCE_GFP(order > MAX_PAGE_ORDER, gfp))
		return NULL;

	gfp &= gfp_allowed_mask;
	gfp = current_gfp_context(gfp);
	alloc_gfp = gfp;
	if (!prepare_alloc_pages(gfp, order, preferred_nid, nodemask, &ac,
			&alloc_gfp, &alloc_flags))
		return NULL;

	alloc_flags |= alloc_flags_nofragment(zonelist_zone(ac.preferred_zoneref), gfp);

	page = get_page_from_freelist(alloc_gfp, order, alloc_flags, &ac);
	if (likely(page))
		goto out;

	// ...

	page = __alloc_pages_slowpath(alloc_gfp, order, &ac);

	// ...

	return page;
}
```

`get_page_from_freelist()`는 **zonelist를 순회**하면서 free page가 충분한 zone을 찾는다. `__alloc_pages()`에 의해 준비 되었던 allocation context가 여기에 사용된다. 적합한 zone을 찾으면 `rmqueue()`를 호출해 실제로 페이지를 가져온다.

```c
static struct page *
get_page_from_freelist(gfp_t gfp_mask, unsigned int order, int alloc_flags,
						const struct alloc_context *ac)
{
	struct zoneref *z;
	struct zone *zone;
	struct pglist_data *last_pgdat = NULL;
	bool last_pgdat_dirty_ok = false;
	bool no_fallback;

retry:
	/*
	 * Scan zonelist, looking for a zone with enough free.
	 * See also cpuset_node_allowed() comment in kernel/cgroup/cpuset.c.
	 */
	no_fallback = alloc_flags & ALLOC_NOFRAGMENT;
	z = ac->preferred_zoneref;
	for_next_zone_zonelist_nodemask(zone, z, ac->highest_zoneidx,
					ac->nodemask) {
		// ... scan the zonelist ...

try_this_zone:
		page = rmqueue(zonelist_zone(ac->preferred_zoneref), zone, order,
				gfp_mask, alloc_flags, ac->migratetype);
		
		// ...
	}

	if (no_fallback) {
		alloc_flags &= ~ALLOC_NOFRAGMENT;
		goto retry;
	}

	return NULL;
}
```

`rmqueue()`는 order 값이 PAGE_ALLOC_COSTLY_ORDER  이하이면 `PCP(per-CPU page list)`를 사용하고 그보다 크면 **바로 buddy allocator**를 사용한다.

```c
struct page *rmqueue(...)
{
	if (likely(pcp_allowed_order(order))) {
		page = rmqueue_pcplist(...);
		if (likely(page))
			goto out;
	}
	page = rmqueue_buddy(...);
}
```

`rmqueue_pcplist()`는 `order_to_pindex(migratetype, order)`를 이용해 **PCP 리스트 인덱스를 계산**하고 그 리스트에서 페이지를 꺼내려 시도한다. 

```c
struct page *rmqueue(...)
{
	if (likely(pcp_allowed_order(order))) {
		page = rmqueue_pcplist(...);
		if (likely(page))
			goto out;
	}
	page = rmqueue_buddy(...);
}
```

만약 지정된 oder page가 pcp 리스트에 없으면 다음 함수를 호출해 **buddy**에서 page를 가져와 PCP를 채운다.

```c
list = &pcp->lists[order_to_pindex(migratetype, order)];
page = __rmqueue_pcplist(zone, order, migratetype, alloc_flags, pcp, list);
```

`rmqueue_bulk()`는  `__rmqueue()`를 여러번 호출하여 페이지를 가져오고, 가져온 페이지를 PCP리스트에 추가한다.

`__rmqueue()`는 __rmqueue_smallest()를 통해 buddy allocator의 free_area 배열을 탐색한다. 해당 migration type에서 적합한 페이지를 찾지 못하면 __rmqueue_fallback()으로 넘어가 다른 migration type의 페이지를 **훔친다**.

`__rmqueue_smallest()`는 order N부터 NR_PAGE_ORDERS-1까지 순회하면서, zone->free_area[N].free_list[migratetype]에서 페이지를 찾는다. 찾으면 freelist에서 제거하고(del_page_from_free_list()), 필요하면 expand()로 나눈다.

```c
static __always_inline
struct page *__rmqueue_smallest(struct zone *zone, unsigned int order,
						int migratetype)
{
	unsigned int current_order;
	struct free_area *area;
	struct page *page;

	/* Find a page of the appropriate size in the preferred list */
	for (current_order = order; current_order < NR_PAGE_ORDERS; ++current_order) {
		area = &(zone->free_area[current_order]);
		page = get_page_from_free_area(area, migratetype);
		if (!page)
			continue;
		del_page_from_free_list(page, zone, current_order);
		expand(zone, page, order, current_order, migratetype);
		set_pcppage_migratetype(page, migratetype);
		trace_mm_page_alloc_zone_locked(page, order, migratetype,
				pcp_allowed_order(order) &&
				migratetype < MIGRATE_PCPTYPES);
		return page;
	}

	return NULL;
}
```


`expand()`는 큰 order 페이지를 더 작은 페이지들로 분할한다. 예를 들어 order 0이 필요하지만 order 1만 있다면 order 1 페이지를 두 개의 order 0 buddy로 쪼갠다. 하나는 반환, 다른 하나는 **freelist**에 되돌린다.

 만약 fastpath 할당이 실패한 경우 **slowpath**단계를 진행하게 된다. **slowpath**에서는 (길게 설명 안하겠다.) 요청 옵션에 따라 다음 회수 동작들을 수행한다. 

 **OOM killing:** 페이지 할당 시 요청한 order의 페이지가 부족하여 최종적으로 OOM killing을 통해 특정 태스크를 종료시키므로 확보한 페이지들로 할당한다.

 **kswapd:** 백그라운드에서 페이지 회수(reclaim) 매커니즘을 동작시켜 Dirty 된 파일 캐시들을 기록하고, Clean된 파일 캐시를 비우고, swap 시스템에 페이지들을 옮기는 등으로 free 페이지들을 확보한다.
&nbsp;
## 4. 구조 요약

지금까지의 구조를 그림으로 요약하면 다음과 같다. 

![](https://blog.kakaocdn.net/dna/umu8R/dJMcacaJ6Jt/AAAAAAAAAAAAAAAAAAAAACLViORkQq1ZDV-gxr7NIG7f0eOVx3d8w7mvV4FuXUqQ/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=oo%2BPpoipW7Sp%2FzN7OgE7CERVhNU%3D)

출쳐: https://www.slideshare.net/slideshow/physical-memory-managementpdf/252219128

 이번 글에서는 리눅스의 페이지 단위 물리메모리 관리에 대해 정리 해보았다. 새롭게 알게 된 내용도 정말 많고 아직 모르는 부분도 정말 많은 듯 하다. 다음 글에서는 slub allocator에 대해 정리 해보겠다.

reference:

[https://ghdwlsgur.github.io/docs/Linux/devops_se_ch_6](https://ghdwlsgur.github.io/docs/Linux/devops_se_ch_6)

[https://syst3mfailure.io/linux-page-allocator/](https://syst3mfailure.io/linux-page-allocator/)

[https://jeongzero.oopy.io/94ef3e61-c27c-4fba-b8b9-2b9b8aac933a](https://jeongzero.oopy.io/94ef3e61-c27c-4fba-b8b9-2b9b8aac933a)

[https://jeongzero.oopy.io/5ab007c6-ae0a-4a26-a0cc-b88a8fcfd732](https://jeongzero.oopy.io/5ab007c6-ae0a-4a26-a0cc-b88a8fcfd732)

[http://jake.dothome.co.kr/zonned-allocator-alloc-pages-fastpath/](http://jake.dothome.co.kr/zonned-allocator-alloc-pages-fastpath/)

[https://elixir.bootlin.com/linux/v6.6.84/source/include/linux](https://elixir.bootlin.com/linux/v6.6.84/source/include/linux)

[https://www.slideshare.net/slideshow/physical-memory-managementpdf/252219128](https://www.slideshare.net/slideshow/physical-memory-managementpdf/252219128)