+++
date = '2026-02-09T17:43:26+09:00'
draft = false
title = '메모리 관리 1편: TLB와 Page Table Walk: Multi Level paging 동작 원리'
categories = ['Linux kernel']
tags = ['Memory Management']
hideSummary = true
+++

이번 글에서는 뒤에서 공부할  buddy system이나 slub allocator에 앞서 리눅스 메모리 관리 이론 및 기본적인 것들을 정리해보겠다.

## 1. Multi level paging

 **Multi level paging**이란 단일 페이지 테이블의 크기가 너무 커지는 문제를  해결하기 위해 페이지 테이블을 여러 단계로 나누어 관리하는 기술이다. x86-64에서 가상주소는 멀티레벨 페이지 테이블을 통해 물리주소로 변환된다. CPU는 **CR3** 레지스터에 저장된 최상위 페이지 테이블을 시작으로 **PML4 → PDPT → PD → PT** 순서로 내려가며 엔트리를 따라간다. 마지막 단계에서 얻는 정보(페이지 프레임 주소 + 권한 비트)를 이용해 최종 물리주소를 계산한다. CPU의 **MMU(Memory Management Unit)**는 이 페이지 테이블을 참조하여 주소 변환을 수행한다.

![](https://blog.kakaocdn.net/dna/061nu/dJMcabJGhTQ/AAAAAAAAAAAAAAAAAAAAAObIcNI6UPRaDCEXhUcaPtpix3cJsBJFWf0Q092vMYBJ/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=j1CuSYzeuVIfKjJibXsw4kluezU%3D)


![](https://blog.kakaocdn.net/dna/GNgYb/dJMcai9OafZ/AAAAAAAAAAAAAAAAAAAAACmnP10vea_7rb3z7RLwbrYHj-qmFtmgBnEEyxVNQjhq/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=Jf3f0S0GptedHrEKkuDlK781UzQ%3D)


> 이 글에서는 multi level paging에 대한 이론적인 이야기(도입 이유, 다른 paging 기법과의 비교 등)를 많이 적지 않겠다. 만약 궁금하면 운영체제 아주 쉬운 세가지 이야기 혹은 공룡책 같은 운영체제 원서를 사서 읽는 것을 추천한다.

&nbsp;
## 2. TLB(Translation Lookaside Buffer)와 Page Table Walk

 멀티레벨 페이징은 페이지 테이블의 **메모리 낭비를 줄이는 대신** 주소 변환 과정이 길어질 수 있다. 만약 매 메모리 접근마다 PML4 → PDPT → PD → PT를 타고 내려가며 엔트리를 읽어야 한다면 주소 변환만으로도 메모리 접근이 여러 번 추가되어 성능이 크게 떨어진다. 이를 해결하기 위해 CPU는 **TLB(Translation Lookaside Buffer)**라는 캐시를 둔다. TLB에는 최근에 사용한 **가상주소 → 물리주소 변환 결과**가 저장된다. 따라서 대부분의 메모리 접근은 **TLB hit**로 처리되어 페이지 테이블을 실제로 탐색하지 않고도 빠르게 물리주소를 얻는다. **TLB miss**가 발생하면 MMU가 CR3에 저장된 최상위 테이블부터 시작해 자동으로 page table walk를 수행한다. 만약 유효한 매핑이 없으면 page fault가 발생하고 커널이 이를 처리한다.  
리눅스는 이러한 구조를 기반으로 프로세스별 주소 공간을 mm_struct로 관리하며, 문맥 전환 시 CR3를 새로 갱신해 독립된 가상 메모리 공간을 유지한다.

![](https://blog.kakaocdn.net/dna/bV1suH/dJMcadUXQyX/AAAAAAAAAAAAAAAAAAAAAPqka9JzmUpcoyRMPrBGwMiZ8lh5E1nfW-NsqpeUo_kS/img.png?credential=yqXZFxpELC7KVnFOS48ylbz2pIh7yKj8&expires=1772290799&allow_ip=&allow_referer=&signature=rScGos5NQt%2BUoUf1vjWA4c3eVfQ%3D)
&nbsp;
## 3. mm_struct와 vm_area_struct

리눅스 커널은 각 프로세스의 주소 공간을 mm_struct 구조체로 관리한다. 다음과 같이 task_struct 구조체이 있는 것을 볼 수 있다.

```c
struct task_struct {
    ...
    struct mm_struct        *mm;        /* user space memory descriptor */
    struct mm_struct        *active_mm; /* for kernel threads */
    ...
};
```

이 구조체는 프로세스 전체 주소 공간을 추상화한 상위 개념이며, 내부에는 여러 개의 **vm_area_struct(VMA)** 리스트를 가지고 있다. 각 VMA는 실제로 연속된 가상 메모리 영역 하나(예: 코드, 힙, 스택, mmap 영역 등)를 나타낸다.

```c
struct vm_area_struct {
    unsigned long vm_start;       /* start address of the memory region */
    unsigned long vm_end;         /* end address (exclusive) of the memory region */
    struct mm_struct *vm_mm;      /* pointer to the owning memory descriptor (address space) */

    unsigned long vm_flags;       /* flags describing permissions and attributes (R/W/X, shared/private) */

    struct vm_area_struct *vm_next; /* next VMA in the linked list */


    struct file *vm_file;         /* file pointer if this is a file-backed mapping */
    unsigned long vm_pgoff;       /* offset in file (page granularity) for file-backed mappings */

    const struct vm_operations_struct *vm_ops;
                                 /* operations specific to this VMA (fault, open, close, etc.) */
};
```

이번 글에서는 리눅스 메모리 관리 이론의 기본적인 것들에 대해 알아보았다. 다음 글에서는 이 주소 변환/주소 공간 구조 위에서 실제 물리 메모리를 관리하는 Buddy system과 Slub allocator의 동작을 정리해보겠다.

reference:
[https://ko.wikipedia.org/wiki/%EB%B3%80%ED%99%98_%EC%83%89%EC%9D%B8_%EB%B2%84%ED%8D%BC](https://ko.wikipedia.org/wiki/%EB%B3%80%ED%99%98_%EC%83%89%EC%9D%B8_%EB%B2%84%ED%8D%BC)

[https://elixir.bootlin.com/linux/v6.18.3/source/include/linux/sched.h#L830](https://elixir.bootlin.com/linux/v6.18.3/source/include/linux/sched.h#L830)

[https://github.com/torvalds/linux/blob/master/include/linux/mm_types.h](https://github.com/torvalds/linux/blob/master/include/linux/mm_types.h)