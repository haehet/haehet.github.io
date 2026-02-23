

이번 글에서는 linux kernel의 인터럽트 처리에 대해 정리해보겠다.


## 1. Interrupt란?

`interrupt`란 소프트웨어나 하드웨어로 인해 발생하는 CPU의 참여를 필요로 하는 `event`이다.  주로 다음 세 가지로 구분할 수 있다.

>**Exception**: 현재 실행 중인 명령이 원인이 되어 _동기적으로_ 발생한다.
>
>**Hardware Interrupt**: 외부 장치/APIC가 발생 시키는 _비동기_ 이벤트다. 
>
>**Software interrupt**: 소프트웨어가 의도적으로 kernel 진입을 요청한다. 

Hardware interrupt는 device가 interrupt line을 통해 CPU에게 요청을 보내면 발생한다.
이때 interrupts는 CPU에 직접적으로 전달되지 않는다. 오래된 기계에서는 `PIC(Programmable Interrupt Controller)`라는 별도의 칩을 통해 처리했다. 요즘 기계에서는 `APIC(Advanced Programmable Interrupt Controller)`가 처리한다.

![](Pasted%20image%2020260223171958.png)

`APIC`는 위 그림과 같이 Local APIC와 I/O APIC로 나뉜다. 


## 2. IDT(Interrupt Descriptor Table)

모든 인터럽트와 예외에는 `vector number`(0~255)라고 하는 고유 번호가 할당된다. CPU는 `IDT(Interrupt Descriptor Table)`에서 `vector number`를 인덱스로 사용해서 `Interrupt handler`를 호출한다. `IDT`는 `GDT`와 마찬가지로 특수한 레지스터인 `IDTR`에 저장되어 있다.

![](Pasted%20image%2020260223155043.png)
_IDTR 레지스터_

IDTR은 다음과 같이 `IDT base` 주소와 그 limit를 저장하고 있다. 각 IDT의 Entry는 다음과 같은 구성을 가진다.

![](Pasted%20image%2020260223155208.png)
_IDT_

`IST(Interrupt Stack Table)`는 x86_64에서 새로 도입된 메커니즘이다. 인터럽트 또는 예외가 발생하면 새로운 `ss` 셀렉터는 강제로 NULL이 되며 `ss` 셀렉터의 rpl 필드는 새로운 cpl로 설정된다. 오래된 `ss`, `rsp`, 레지스터 플래그, `cs`, `rip`는 새로운 스택에 푸시된다. 64비트 모드에서는 인터럽트 스택 프레임에서 push되는 크기가 8바이트로 고정되어 있으므로 다음과 같은 스택을 얻게 된다:

```
+---------------+
|               |
|      SS       | 40
|      RSP      | 32
|     RFLAGS    | 24
|      CS       | 16
|      RIP      | 8
|   Error code  | 0
|               |
+---------------+
```

인터럽트 게이트의 IST 필드가 0이 아니면 IST 포인터를 `rsp`로 읽어온다. 인터럽트 벡터 번호가 에러 코드를 동반하는 경우에는 `error code`를 스택에 푸시한다. 인터럽트 벡터 번호가 `error code`를 갖지 않는 경우에는 `dummy error code`를 스택에 push한다. 핸들러의 실행이 끝나면 `iret` 명령으로 중단되었던 프로세스에 제어를 되돌려야 한다. `iret` 명령은 cpl 변화와 무관하게 스택 포인터(`ss:rsp`)를 무조건 꺼내서 인터럽트에 의해 중단된 프로세스의 스택을 복구한다.


위 과정을 정리하면 Cpu는 다음과 같은 과정을 통해 인터럽트를 처리한다.

* 1. Flag register, `CS` 및 명령어 포인터를 스택에 저장한다.
* 2. 인터럽트가 에러 코드를 유발하면 CPU는 스택의 명령 포인터 다음에 에러를 저장한다.
* 3.  인터럽트 핸들러가 실행된 후에는, 다시 돌아오기 위해 `iret` 명령을 사용한다.

> [!NOTE]
> 이 글에서는 IDT의 초기화 부분은 다루지 않겠습니다. 궁금하신 분은 아래 reference를 참고해주세요.


## 3. IRQ 

`IRQ`(Interrupt request)란 processor에게 현재 프로세스를 멈추고 interrupt handler를 실행하게 하는 hardware signal을 말한다. 커널은 `IRQ`를 `irq_desc` 구조체로 관리한다. (irq_desc 구조체는 `early_irq_init` 함수에 의해 초기화된다.)

```c
struct irq_desc {
	struct irq_common_data	irq_common_data;
	struct irq_data		irq_data;
	unsigned int __percpu	*kstat_irqs;
	irq_flow_handler_t	handle_irq;
#ifdef CONFIG_IRQ_PREFLOW_FASTEOI
	irq_preflow_handler_t	preflow_handler;
#endif
	struct irqaction	*action;	/* IRQ action list */
	unsigned int		status_use_accessors;
	unsigned int		core_internal_state__do_not_mess_with_it;
	unsigned int		depth;		/* nested irq disables */
	unsigned int		wake_depth;	/* nested wake enables */
	unsigned int		irq_count;	/* For detecting broken IRQs */
	unsigned long		last_unhandled;	/* Aging timer for unhandled count */
	unsigned int		irqs_unhandled;
	atomic_t		threads_handled;
	int			threads_handled_last;
	raw_spinlock_t		lock;
	struct cpumask		*percpu_enabled;
	const struct cpumask	*percpu_affinity;
#ifdef CONFIG_SMP
	const struct cpumask	*affinity_hint;
	struct irq_affinity_notify *affinity_notify;
#ifdef CONFIG_GENERIC_PENDING_IRQ
	cpumask_var_t		pending_mask;
#endif
#endif
	unsigned long		threads_oneshot;
	atomic_t		threads_active;
	wait_queue_head_t       wait_for_threads;
#ifdef CONFIG_PM_SLEEP
	unsigned int		nr_actions;
	unsigned int		no_suspend_depth;
	unsigned int		cond_suspend_depth;
	unsigned int		force_resume_depth;
#endif
#ifdef CONFIG_PROC_FS
	struct proc_dir_entry	*dir;
#endif
#ifdef CONFIG_GENERIC_IRQ_DEBUGFS
	struct dentry		*debugfs_file;
#endif
#ifdef CONFIG_SPARSE_IRQ
	struct rcu_head		rcu;
	struct kobject		kobj;
#endif
	struct mutex		request_mutex;
	int			parent_irq;
	struct module		*owner;
	const char		*name;
} ____cacheline_internodealigned_in_smp;

```

구조체의 각 필드의 의미는 다음과 같다.

- `   irq_common_data` - chip 함수로 전달된 각각의 chip 데이터와 irq;
- 
- `kstat_irqs` - 각 cpu의 irq 통계;
    
- `handle_irq` - 하이레벨 irq-events 핸들러;
    
- `action` - [IRQ](https://en.wikipedia.org/wiki/Interrupt_request_%28PC_architecture%29)가 발생할 때 호출 될 인터럽트 서비스 루틴을 식별;
    
- `irq_count` - IRQ 라인에서의 인터럽트 발생 카운터;
    
- `depth` - IRQ 라인이 활성화 된 경우 '0', 적어도 한 번 비활성화 된 경우 양수 값;
    
- `last_unhandled` - 처리되지 않은 카운트를 위한 aging 타이머;
    
- `irqs_unhandled` - 처리되지 않은 인터럽트의 수;
    
- `lock` - IRQ 디스크립터에 대한 액세스를 직렬화하는 데 사용되는 스핀 잠금;
    
- `pending_mask` - 보류중인 재조정 인터럽트;
    
- `owner` - 인터럽트 디스크립터의 소유자. 인터럽트 디스크립터는 모듈에서 할당 될 수 있음. 이 필드는 인터럽트를 제공하는 모듈에 대한 참조 횟수를 증명해야함.

또한 irq_desc는 아래와 같이 배열 형태로 처리된다. 
![](Pasted%20image%2020260223185429.png)
각 `IRQ`의 `vector number`는 `init_IRQ` 함수를 통해 `vector_irq precpu` 배열로 초기화 된다.

```c
void __init init_IRQ(void)
{
    int i;

    for (i = 0; i < nr_legacy_irqs(); i++)
        per_cpu(vector_irq, 0)[IRQ0_VECTOR + i] = i;
...
}
```


## 4. Top half와 Bottom half

인터럽트 핸들러는 프로세스를 멈추고 실행되기 때문에 빠르게 실행되어야 한다. 하지만 때때로 많은 양의 작업을 수행해야 할 수도 있다. 이 두 특성을 전부 만족 시키는 것은 불가능하므로 인터럽트 처리를 전반부(Top half)와 후반부(bottom half)로 나누었다. 

![](Pasted%20image%2020260223202936.png)
_top half와 bottom half_

인터럽트를 처리하는 방법은 다음 세가지 유형으로 구분된다.

* `softirqs`
* `tasklets`
* `workqueues`


인터럽트 요청이 오면 Top Half가 수행되고, 큰 작업이 필요할 때는 Top-Half에서 soft irq bit을 세팅한다.
![](Pasted%20image%2020260223203305.png)


다음과 같이 `do_softirq()` 함수에서는 `softirq_pending[]`의 비트를 확인하고 1이라면 `softirq_vec`에서 `Softirq handler`를 호출한다.

![](Pasted%20image%2020260223203337.png)

각각의 bottom half는 다음 특성을 가진다
![](Pasted%20image%2020260223204353.png)


다음 표를 보고 골라 쓰자 

![](Pasted%20image%2020260223204433.png)

>[!CAUTION]
>위 글에는 틀린 내용이 있을 수 있으니 주의 바랍니당
>


reference: 
https://0xax.gitbooks.io/linux-insides/content/
https://codemachine.com/articles/interrupt_dispatching.html
https://olc.kr/course/course_online_view.jsp?cid=51&id=35