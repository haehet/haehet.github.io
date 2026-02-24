+++
date = '2026-02-24T22:33:43+09:00'
draft = false
title = 'Linux kernel - System call'
categories = ['Linux kernel']
tags = ['vDSO']
hideSummary = true
+++

이번 글에서는 linux의 `system call`에 대해 정리해보겠다.

## 1. system call이란?

시스템 콜은 커널의 서비스를 제공 받기 위한 유저 스페이스의 요청이다. 시스템콜은 애플리케이션이 하드웨어와 직접적으로 상호작용 하는 것을 막아 시스템의 안정성과 보안을 보장한다. 

![](Pasted%20image%2020260224200424.png)
_system call의 호출을 나타낸 그림_


## 2. System call table

리눅스 커널은 시스템 콜이 발생하면 system call handler를 `system call table`에서 가져온다. 
```c
asmlinkage const sys_call_ptr_t sys_call_table[__NR_syscall_max+1] = {
    [0 ... __NR_syscall_max] = &sys_ni_syscall,
    #include <asm/syscalls_64.h>
};
```

위와 같이 system call table은 `__NR_syscall_max+1` 매크로(해당 아키텍처의 최대 syscall 개수) 크기의 배열이다.

초기의 system call table의 요소는 `sys_ni_syscall`로 전부 초기화 된다. 이는 구현되지 않은 syscall을 나타낸다.

```c
asmlinkage long sys_ni_syscall(void)
{
    return -ENOSYS;
}
```

그 후 system call table은 다음과 같이 syscall로 초기화 된다.

```c
asmlinkage const sys_call_ptr_t sys_call_table[__NR_syscall_max+1] = {
    [0 ... __NR_syscall_max] = &sys_ni_syscall,
    [0] = sys_read,
    [1] = sys_write,
    [2] = sys_open,
    ...
    ...
    ...
};
```

## 3. system call entry  Initialization

시스템에서 `syscall`이 실행되었을 때 어떤 일이 발생할까? 이는 [intel manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html)에서 알 수 있다.

```
SYSCALL invokes an OS system-call handler at privilege level 0.
It does so by loading RIP from the IA32_LSTAR MSR
```

즉 `IA32_LSTAR` 레지스터에서 `rip`를 가져온다.  해당 레지스터는 `syscall init`에서 설정된다. 

```asm
wrmsrl(MSR_STAR,  ((u64)__USER32_CS)<<48  | ((u64)__KERNEL_CS)<<32);
wrmsrl(MSR_LSTAR, entry_SYSCALL_64);
```

`MSR_STAR`는 `sysret`명령어를 위해 `segment register`를 저장한다. `MSR_LSTAR`에는 `entry_SYSCALL_64`를 넣는다.

>[!NOTE]
>syscall 말고 다른 system call 호출 명령을 위한 레지스터 세팅 부분도 있지만 여기서 다루지는 않겠다.

## 4. syscall 실행 과정

위에서 설명한 `entry_SYSCALL_64`는 다음과 같이 구현된다.

```asm
ENTRY(entry_SYSCALL_64)
	/*
	 * Interrupts are off on entry.
	 * We do not frame this tiny irq-off block with TRACE_IRQS_OFF/ON,
	 * it is too small to ever cause noticeable irq latency.
	 */
	SWAPGS_UNSAFE_STACK
	/*
	 * A hypervisor implementation might want to use a label
	 * after the swapgs, so that it can do the swapgs
	 * for the guest and jump here on syscall.
	 */
GLOBAL(entry_SYSCALL_64_after_swapgs)

	movq	%rsp, PER_CPU_VAR(rsp_scratch)
	movq	PER_CPU_VAR(cpu_current_top_of_stack), %rsp

	TRACE_IRQS_OFF

	/* Construct struct pt_regs on stack */
	pushq	$__USER_DS			/* pt_regs->ss */
	pushq	PER_CPU_VAR(rsp_scratch)	/* pt_regs->sp */
	pushq	%r11				/* pt_regs->flags */
	pushq	$__USER_CS			/* pt_regs->cs */
	pushq	%rcx				/* pt_regs->ip */
	pushq	%rax				/* pt_regs->orig_ax */
	pushq	%rdi				/* pt_regs->di */
	pushq	%rsi				/* pt_regs->si */
	pushq	%rdx				/* pt_regs->dx */
	pushq	%rcx				/* pt_regs->cx */
	pushq	$-ENOSYS			/* pt_regs->ax */
	pushq	%r8				/* pt_regs->r8 */
	pushq	%r9				/* pt_regs->r9 */
	pushq	%r10				/* pt_regs->r10 */
	pushq	%r11				/* pt_regs->r11 */
	sub	$(6*8), %rsp			/* pt_regs->bp, bx, r12-15 not saved */

	/*
	 * If we need to do entry work or if we guess we'll need to do
	 * exit work, go straight to the slow path.
	 */
	movq	PER_CPU_VAR(current_task), %r11
	testl	$_TIF_WORK_SYSCALL_ENTRY|_TIF_ALLWORK_MASK, TASK_TI_flags(%r11)
	jnz	entry_SYSCALL64_slow_path

entry_SYSCALL_64_fastpath:
	/*
	 * Easy case: enable interrupts and issue the syscall.  If the syscall
	 * needs pt_regs, we'll call a stub that disables interrupts again
	 * and jumps to the slow path.
	 */
	TRACE_IRQS_ON
	ENABLE_INTERRUPTS(CLBR_NONE)
#if __SYSCALL_MASK == ~0
	cmpq	$__NR_syscall_max, %rax
#else
	andl	$__SYSCALL_MASK, %eax
	cmpl	$__NR_syscall_max, %eax
#endif
	ja	1f				/* return -ENOSYS (already in pt_regs->ax) */
	movq	%r10, %rcx

	/*
	 * This call instruction is handled specially in stub_ptregs_64.
	 * It might end up jumping to the slow path.  If it jumps, RAX
	 * and all argument registers are clobbered.
	 */
	call	*sys_call_table(, %rax, 8)
```

위 코드를 분석해보면 다음과 같다.

* `GS` 레지스터를 교체한다. (`GS`레지스터는 커널의 `pre_cpu` 영역을 나타낸다.)
* 그 후 `RSP`를 `per_cpu`의 `rsp_scratch` 변수를 넣는다.
* 유저 레지스터를 `push`한다.
* `call *sys_call_table(, %rax, 8)`를 통해 `system call handler`를 호출한다.

시스템 콜이 종료가 되면 다음과 같이 반환 값인 `rax`를 스택에 넣는다.

`movq    %rax, RAX(%rsp)`

그리고 다음과 같이 유저랜드로 복귀한다.

```asm
RESTORE_C_REGS_EXCEPT_RCX_R11

movq    RIP(%rsp), %rcx
movq    EFLAGS(%rsp), %r11
movq    RSP(%rsp), %rsp

USERGS_SYSRET64
```

```c
#define USERGS_SYSRET64                \
    swapgs;                               \
    sysretq;
```



## 5. vDSO

system call 호출은 **비용이 많이 드는** 작업이다. 프로세서가 현재 실행 중인 작업을 중단하고 커널로의 컨텍스트 전환이 필요하기 때문이다. 따라서 특정 시스템 호출에 대한 속도를 높이기 위해 
`vDSO(virtual dynamic shared object`)이 만들어졌다.

>[!NOTE]
> 예전에는 vsyscall이라는 것을 통해 위 개념을 구현했지만, 현재는 Vdso를 이용한다. vsyscall과 Vdso의 차이점은 `vDSO`는 메모리 페이지를 공유 객체로 각 프로세스에 매핑하지만, `vsyscall`은 메모리에서 정적이며 매번 같은 주소를 갖는다는 것이다. `vDSO`의 특징을 이용하면 `vdso hijacking` 공격을 통해 LPE를 시도할 수 있다. 나중에 한번 다뤄보겠다. 

`vDSO`는 다음과 같이 `init_vdso` 함수에 의해 초기화 된다.

```c
static int __init init_vdso(void)
{
    init_vdso_image(&vdso_image_64);

#ifdef CONFIG_X86_X32_ABI
    init_vdso_image(&vdso_image_x32);
#endif
```

```c
void __init init_vdso_image(const struct vdso_image *image)
{
    int i;
    int npages = (image->size) / PAGE_SIZE;

    for (i = 0; i < npages; i++)
        image->text_mapping.pages[i] =
            virt_to_page(image->data + i*PAGE_SIZE);
    ...
    ...
    ...
}
```

그 후 바이너리를 메모리에 로드할 때 커널에 의해 매핑된다.

```c
int arch_setup_additional_pages(struct linux_binprm *bprm, int uses_interp)
{
    if (!vdso64_enabled)
        return 0;

    return map_vdso(&vdso_image_64, true);
}
```

`vDSO`는 다음 syscall들을 지원한다.

- `   __vdso_clock_gettime`;
- `__vdso_getcpu`;
- `__vdso_gettimeofday`;
- `__vdso_time`.

>[!TIP]
>`ROP` 가젯이 부족한 상황에서 `vDSO` 영역을 leak하고 해당 영역의 가젯을 쓸 수도 있다.
>이런 CTF문제를 풀어보고 싶다면 **LINE ctf 2021 pwnbox**를 추천한다.(`vDSO`는 커널 버전에 영향을 받기 때문에 `vDSO`영역을 dump해야한다.)




reference: 
https://0xax.gitbooks.io/linux-insides/content/
https://olc.kr/course/course_online_view.jsp?cid=51&id=35#self