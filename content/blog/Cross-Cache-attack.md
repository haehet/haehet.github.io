+++
date = '2026-02-09T19:18:49+09:00'
draft = false
title = 'Cross Cache Attack'
categories = ['Linux kernel']
tags = ['kernel exploit']
hideSummary = true
+++
이번 글에서는 커널 익스플로잇을 할 때 유용하게 쓰이는 Cross-cache attack에 대해 정리 해보겠다.

## 1. Cross-Cache attack이란?

 Cross-Cache attack이란 취약점이 발생한 object가 **전용 슬랩 캐시****(dedicated kmem_cache)**에 존재해서 exploit을 하기 어려울 때 우리가 공격하기 쉬운 캐시로 가져오는 것을 말한다. 

![](https://blog.kakaocdn.net/dna/bEIiL8/dJMb99LVF5V/AAAAAAAAAAAAAAAAAAAAAPh5sfy6DSIeI8SNGyxjdZsnzcq4YX8RA9T_KdL5I2Vw/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=TpWGLCcvs5FLuilEan%2BIa%2F5teh4%3D)


다음과 같이 **전용 슬랩 객체 A**에서 **UAF** 취약점이 발생했다고 하자. A 객체만으로는 exploit을 하기가 힘들다. 따라서 Cross-Cache attack을 통해 exploit 하기 쉬운 객체 **B**를 불러온다. 

이를 통해 다음과 같이 강력한 exploit primitive 불러 올 수 있다.

![](https://blog.kakaocdn.net/dna/dDhiUt/dJMcaajMl3B/AAAAAAAAAAAAAAAAAAAAAJWDjv1aX5iEYB8NfzZtZxEJGJRDfj_LZGqL2KIidA7i/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=AeDZAWjPq2hT57kQRzRNZzL9Hog%3D)

Cross-cache attack의 원리는 단순하다. 관리할 수 있는 free page가 가득 차면 buddy system으로 slab page를 반환 하는 것을 이용한다. buddy system에 반환 후 해당 물리 페이지가 우리가 exploit 하기 쉬운 객체 B의 slab page로 재사용 하게 하면 된다.

![](https://blog.kakaocdn.net/dna/bpWoEd/dJMcaac03O9/AAAAAAAAAAAAAAAAAAAAALdcZ4ZNsGnv3Torc5lpBnENaof5CLpSSXe0da6Bto_y/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=SOd5XeIh8gOh7PlUdST6erw3eG8%3D)

## 2. Cross-cache attack의 과정

먼저 설명에 앞서 용어를 정리하겠다. 


>**objs_per_slab:** 한개의 슬렙 페이지안에 들어가는 object의 수를 말한다.
>
> **order:** 한개의 슬렙 페이지의 order(차수)를 말한다.
>
> **cpu_partial:** percpu의 partial list에 들어갈 수 있는 slab 페이지의 최대 수를 말한다.

![](https://blog.kakaocdn.net/dna/bJj9VZ/dJMcahiUNpF/AAAAAAAAAAAAAAAAAAAAAJdjSF2YrTKpR88WdHnoPpqfE643J591alC3GVmPj73z/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=Cya5tvErcK7PNt%2FGSZxkQYWphuM%3D)

**1. Pin task to a single cpu**

슬랩 객체의 할당을 예측하기 쉽게 우리의 CPU를 고정해둔다. 다음과 같은 함수를 통해 할 수 있다.

```c
void pin_cpu(int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    if (sched_setaffinity(0, sizeof(cpu_set_t), &cpuset) == -1) {
        fatal("sched_setaffinity");
    }
}
```

**2. Defragmentation: to drain partially-free slabs of all their free objects**

부분적으로 free가 되어 있는 객체들을 전부 할당을 통해 채워준다.

**3. Allocate around objs_per_slab * (1+cpu_partial) objects**

objs_per_slab * (1 + cpu_partial) 정도의 객체를 할당해준다. 최소 **cpu_partial**개의 페이지를 전부 채울정도로 할당한다. 

![](https://blog.kakaocdn.net/dna/rQYNA/dJMcadHxAZ3/AAAAAAAAAAAAAAAAAAAAAAaksp4z5ttC4jUCbTSXlkJzHIzgat60JMVo0ZnwEMkm/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=WWpo9LHe5FziwxEC%2BbG5M3W5rfs%3D)

**4. Allocate objs_per_slab-1 objects as pre-alloc objects**

단계의 목적은 이후 할당이 **특정한 한 페이지**에서 나오도록 상태를 정렬하는 것이다.

**5. Allocate the victim object**

취약한 (UAF)객체를 할당해준다.

**6. Trigger the vulnerability(UAF) to release the victim object**

취약점을 trigger 해준다.

![](https://blog.kakaocdn.net/dna/bhYz2A/dJMcaiPBriE/AAAAAAAAAAAAAAAAAAAAAED3wP9jg-ib_dPNL0uLngXqp8JhT2NJKqYx9woQHpVG/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=eMYJKKMjdY3bwHwU8lCBB1vBe%2FA%3D)

**7. Allocate objs_per_slab+1 objects as post-alloc objects**

이 과정을 통해 victim page(victim 객체가 들어있는 슬랩 페이지)는 전부 채워진다. 또한 더 이상 현재 CPU가 계속 할당에 쓰는 **CPU slab**이 아니게 된다. (post-alloc)

![](https://blog.kakaocdn.net/dna/L8gJQ/dJMcahJZo0v/AAAAAAAAAAAAAAAAAAAAAAloXRCvfSBxfA2r4H6kqnSctn2cgr73cVXNG7bGm70t/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=%2BRNzcKP9alny0f%2FIK2xv5fXVBP4%3D)

**8. Release all the pre-alloc and post-alloc objects**

단계 4, 7에서 할당한 객체들을 전부 해제 해준다. 그러면 victim page는 빈 페이지(empty slab)가 된다. 하지만 곧바로 buddy로 반환되지는 않는다. 먼저 per-CPU partial list로 간다.

![](https://blog.kakaocdn.net/dna/bSz7DE/dJMcahpGrTD/AAAAAAAAAAAAAAAAAAAAALpRUDBIUVjB7JrJVnl_KlhCTaE7U_08XG09lTtQvUBL/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=1iDgQHrHO%2ByWGV9FaP7yxfAfGSA%3D)

**9. Free one object per slab from the allocations from Step3**

이제 Step 3에서 대량으로 할당해 둔 객체들에 대해 **각 페이지마다 객체를 1개씩 free** 한다. 이렇게 하면 그 객체가 속해 있던 **각 slab page** 가 free 객체를 포함하는 페이지가 되면서 해당 페이지들이 순차적으로 **percpu partial list** 로 들어가게 된다. 이 작업을 반복하면 percpu partial list에 페이지가 계속 쌓이는데 결국 리스트 길이가 **cpu_partial 한계**에 도달하면 SLUB은 더 이상 percpu partial에 유지할 수 없어서 **flush**를 수행한다. flush가 일어나면 페이지들은 상태에 따라 나뉜다. 

>  **in-use 객체가 남아 있는 페이지**  
→ SLUB의 **per-NUMA-node partial list** 로 내려간다.
>
>  **페이지 안의 모든 객체가 free인 페이지(empty slab)**  
→ **Buddy system으로 반환된다.**

![](https://blog.kakaocdn.net/dna/demyNS/dJMcabpsG1Y/AAAAAAAAAAAAAAAAAAAAAFENRltyI40WTtjBphB-Ptwy1pwUfID99swDUZ4mH-pu/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=bIVj5hUxpIagt85N3QfUAbvfSjE%3D)

**10. Heap spray with object B to occupy the victim slab, victim object A gets reallocated as object B**

우리가 원하는 객체(ex: cred)를 spray해준다.

![](https://blog.kakaocdn.net/dna/lEjz1/dJMcacIGfNb/AAAAAAAAAAAAAAAAAAAAABQcG4g6WXEwNq-HgkXVJ2WQq8bkl7C9O9MSYtDQ-Gmk/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=6DJD4I5HPWnb9qIjSB1bSYingeQ%3D)

## 3. SLAB_VIRTUAL

최근 커널에서는 Cross-cache attack을 구조적으로 차단하기 위한 방어 기법으로 **SLAB_VIRTUAL** 이라는 메커니즘이 도입되었다. 이는 슬랩을 더 이상 물리 페이지가 아닌 **전용 가상 메모리 영역**에 할당 하는 것이다. 만약 backing physical page가 buddy로 갔다가 다시 잡히더라도 가상 주소가 달라서 공격이 불가능하다.  (물론 시스템 성능은 보장 못한다 zz)

이번 글에서는 Cross-cache attack에 대해 정리해보았다. 대단한 기법이긴 하지만 제약 조건이 많다. 할당 예측이 어려울 수도 있고 또한 victim object가 spray 및 할당 해제가 어려운 경우도 존재한다. 해당 제약조건을 우회하기 위한 심화 exploit 방법 (SLUBStick 등)이 있으니까 더 공부해보도록 하자.

reference:

[https://i.blackhat.com/Asia-24/Presentations/Asia-24-Wu-Game-of-Cross-Cache.pdf](https://i.blackhat.com/Asia-24/Presentations/Asia-24-Wu-Game-of-Cross-Cache.pdf)

[https://dl.acm.org/doi/epdf/10.1145/3719027.3765152](https://dl.acm.org/doi/epdf/10.1145/3719027.3765152)

[https://projectzero.google/2021/10/how-simple-linux-kernel-memory.html](https://projectzero.google/2021/10/how-simple-linux-kernel-memory.html)

[https://github.com/thejh/linux/commit/bc52f973a53d0b525892088dfbd251bc934e3ac3](https://github.com/thejh/linux/commit/bc52f973a53d0b525892088dfbd251bc934e3ac3)