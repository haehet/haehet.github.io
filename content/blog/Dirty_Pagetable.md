+++
date = '2026-02-09T19:53:44+09:00'
draft = false
title = 'Dirty Pagetable'
categories = ['kernel exploit']
hideSummary = true
+++
이번 글에서는 kernel exploit을 할 때 강력한 primitive를 얻을 수 있는 Dirty Pagetable에 대해서 정리해보겠다.

## 1. page table이란? 

 멀티레벨페이징을 공부했다면 알겠지만 page table은 CPU가 가상주소(VA)를 물리주소(PA)로 변환할 때 쓰는 테이블이다. CR3레지스터를 통해 확인 가능하다. (여기서는 따로 이론적인 내용을 길게 설명 안하겠다.)

![](https://blog.kakaocdn.net/dna/WkIxV/dJMcajgHoMJ/AAAAAAAAAAAAAAAAAAAAAJsJCZBz-tG5Z8B3m0KrsJPytpKpkRXcVPUKhHKQ4xq0/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=UIP8xTVKWcwZnkXWei6oT06whSg%3D)


page table은 항상 미리 다 만들어져 있는 게 아니라 Linux는 대부분의 매핑을 **지연(lazy) 생성**한다. 즉 실제 페이지테이블 엔트리는 첫 접근(page fault)가 발생하면서 할당되는 경우가 많다. Dirty Pagetable 기법은 이를 이용한다.
&nbsp;
## 2. Dirty pagetable

Dirty pagetable이란 위에서 설명한 **Page table을 조작하는 기법**이다. Page table을 우리가 원하는 **물리 주소**로 조작가능하면 단순히 우리의 프로세스에서 특정 영역에 메모리 접근을 하는 것만으로도 kernel 영역의 메모리를 조작 가능하다. 또한 이 기법은 페이지의 권한까지 수정 가능하여 커널에 있는 **특정 함수를 우리가 원하는 셸코드**로 바꾸는 것도 가능하다. 

보통 Dirty pagetable은 Cross-Cache attack과 같이 사용된다. 공격 과정은 다음과 같다.

> **1. UAF 취약점이 있는 객체를 찾는다.** 
>
> **2. Cross-cache attack을 통해 UAF가 있는 객체를 해제 후 해당 슬랩 페이지를 버디 시스템에 반환한다.**
>
> **3. Page spray를 통해 Pate table을 heap에 뿌린다.**
>
>**4. UAF 취약점을 이용해 페이지 테이블을 조작 하고 AAR, AAW를 얻는다.**

page spray는 위에서 말했듯이 page fault를 일으켜 주면 된다. 다음과 같이 큰 메모리 영역을 만들어 두고 원할 때 접근을 하면 page fault가 일어난다.

```c
char pages[PAGE_SPRAY_COUNT][SPRAY_PAGE_SIZE] __attribute__((aligned(0x1000)));

// Spray pages
for (size_t page = 0; page < PAGE_SPRAY_COUNT; ++page)
    memset(pages[page], 'A', SPRAY_PAGE_SIZE);
```

 안정적인 exploit을 위해서는 **TLB(Translation Lookaside Buffer)**를 **Flush**해주는 과정이 필요하다. page table을 교체 했는데 CPU가 TLB에 있는 캐시 pte를 읽고 접근하면 원하는 메모리 접근이 안될 수 있기 때문이다. 다음과 같이 **mprotect로** 해당 메모리의 접근 권한을 바꾸는 것을 통해 TLB flushing을 할 수 있다. (만약 mprotect같은 syscall이 사용 불가능한 상황이면 메모리 접근에 딜레이를 넣어보자)

```c
/* Flushes the TLB by temporarily changing memory permissions */
void flush_tlb_and_print(void *ptr, size_t count) {
    uint64_t *addresses = (uint64_t *)ptr;
    if (mprotect(addresses, count, PROT_READ) == -1) {
        perror("mprotect (set PROT_READ)");
        exit(EXIT_FAILURE);
    }
    /* Restore original permissions */
    if (mprotect(addresses, count, PROT_READ | PROT_WRITE) == -1) {
        perror("mprotect (restore PROT_READ | PROT_WRITE)");
        exit(EXIT_FAILURE);
    }
    printf("[*] TLB flushed by changing memory permissions.\n");
    fflush(stdout);
}
```
&nbsp;
## 3. kernel base leak via phys

Diry pagetable 공격이 성공을 했어도 우리가 원하는 주소의 물리주소를 알지 못하면 의미가 없다. 먼저 physmap의 물리주소는 그냥 phsymap의 가상 주소의 **하위 3바이트**랑 동일하다.  하지만 kernel base의 물리주소는 커널이 부팅될 때마다 바뀐다. 우리는 이 물리 주소를 얻기 위해서 커널의 특정 고정된 물리주소를 이용한다. 다음과 같이 물리 주소 **0x9c000**에 접근 시 놀라운 점을 볼 수 있다.

![](https://blog.kakaocdn.net/dna/PLBy2/dJMcadHy88s/AAAAAAAAAAAAAAAAAAAAACGWRJQIbFyPC_e1z6etgHUHUCHmjVmEsma1jbHaLtPQ/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=td1AF0AMDL3O9EK%2FwYQn3fLdb98%3D)

다음과 같이 뭔가 수상한 숫자가 적혀있는데 이를 kbsae의 물리주소와 빼보면 **고정된 오프셋**이 나오는 것을 알 수 있다. 이 커널의 경우 0x2404000이다.

![](https://blog.kakaocdn.net/dna/dV1zM7/dJMcadOiznj/AAAAAAAAAAAAAAAAAAAAAKfoVZ1DavYa48JKdqTgDGCVil6q6RAHPZvR5Hoh1eHI/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=fyArGsuRe1qE0xjk0p52XR6inzw%3D)

![](https://blog.kakaocdn.net/dna/lwsj3/dJMcagRRYT6/AAAAAAAAAAAAAAAAAAAAAHZXSYYYu1sNjBI7hMBq4HKyUPc9t5z6Q-ARu6mHMjbP/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=IbOz86odIr6CcRt7j67cdLR5Sqc%3D)

해당 근처 영역의 메모리를 계속 조사해보면 커널 부팅과 관련한 곳으로 보인다. 아마 커널의 부팅과정을 고정된 물리주소 근처에서 하는 듯 하다. 이를 통해 kernel base의 물리 주소를 얻으면 kernel 모든 영역의 aar, aaw를 얻을 수 있다. 

reference:

[https://ptr-yudai.hatenablog.com/entry/2023/12/08/093606](https://ptr-yudai.hatenablog.com/entry/2023/12/08/093606)

[https://kuzey.rs/posts/Dirty_Page_Table/](https://kuzey.rs/posts/Dirty_Page_Table/)