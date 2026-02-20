+++
date = '2026-02-20T22:39:17+09:00'
draft = false
title = 'Linux kernel Booting'
categories = ['Linux kernel']
tags = ['Boot']
hideSummary = true
+++


이번 글에서는 리눅스 커널의 부팅과정과 `Real mode`에서 `Long mode`까지 전환되는 과정에 대해서 알아보겠다.


## 1. Boot loader

Boot loader는 시스템을 기본 수준으로 초기화 시킨다. 그리고 커널에게 하드웨어 구성 정보를 담고 있는 구조체 포인터와 커널의 command line을 전달한다. 
(Boot loader에는 BIOS/UEFI, GRUB 등 다양한 형태가 있지만 이 글에서는 Boot loader 자체보다는 **커널의 모드 전환(Real → Protected → Long)** 에 초점을 맞춘다.)


## 2. Real mode

 Boot loader가 커널에 제어권을 넘겨주면 기본적으로 `Real mode`로 실행이 된다. `Real mode`란 `intel 8086` 아키텍쳐에서 사용한 프로세스 동작 모드이다. 당시 `8086` 프로세서는 20 bit의 주소 버스(0-0xFFFFF)를 가지고 있었다. 하지만 사용 가능한 레지스터는 16 bit까지만 지원이 되었기 때문에 `segmentation` 방식을 통해 이를 극복했다.

```
Physical Adress = Segment Selctor * 16 + Offset
```

이 방식에서는 직접 접근 가능한 주소 공간이 기본적으로 **1MB**로 제한되고 **권한 분리/메모리 보호가 사실상 없다**.  
그래서 더 큰 메모리 공간과 보호를 제공하기 위해 다음 단계인 **Protected mode(32-bit)** 로 전환한다.

![Real mode를 나타낸 그림](Pasted%20image%2020260220212955.png)
*Real mode에서의 주소 변환을 나타낸 그림*

## 3. Protected mode

보호 모드에서는 `segmentation` 방식을 재구성하였다. 각 segment의 크기와 위치를 세그먼트 디스크립터(Segment Descriptor)라는 자료구조에 기록했다. 세그먼트 디스크립터는 **`Global Descriptor Table` (GDT)** 라고 불리는 자료구조에 저장된다.

![](descriptor.png)

*세그먼트 디스크립터*


GDT의 주소는 메모리 내에 고정되어 있지 않아서 `GDTR` 레지스터에 저장된다. 다음과 같은 명령어를 통해 GDTR에 GDT를 load한다

```
lgdt gdt
```


Real mode와 다르게 Protected mode에서는 세그먼트 레지스터가 80비트로 확장되고 **세그먼트 셀렉터( segment selector )레지스터**와 **세그먼트 디스크립터( segment descriptor ) 레지스터로** 
나뉜다. 

![](Pasted%20image%2020260220220552.png)
*세그먼트 레지스터의 구조*

![](Pasted%20image%2020260220220611.png)
*세그먼트 셀렉터*

>* **index**: GDT 내부에 있는 디스크립터의 인덱스 번호를 저장한다.
>* **TI(Table Indicator)**: 디스크립터를 찾을 위치를 나타낸다.
>* **RPL**: 요청자의 권한 수준이 들어있다.

Protected mode에서 Physical Adress를 얻는 과정은 다음 그림을 통해 나타낼 수 있다.

![](Pasted%20image%2020260220221020.png)

Real mode에서 Protected mode로 전환하기 위해서는 다음 과정이 필요하다.

>* interrupt 비활성화
>* `lgdt`에 따라 `GDT`를 설정하고 load
>* `CR0(Control Register 0)`에서 `PE(Protection Enable)` bit 설정
>* Protected mode code로 점프

## 4. Long mode

long mode는 `x86_64` 프로세스의 기본 모드이다. `64 bit` 모드로 전환되기 위해서는 다음 과정이 필요하다.

>* `Physical Adress Extension` 활성화
>* Page table을 설정하고 최상위 page table을 CR3 레지스터에 load
>* `EFER.LME` 활성화
>* paging 활성화
>* Long mode 코드로 점프
>




Reference: 
https://www.eeeguide.com/operating-modes-of-80386-microprocessor/
https://0xax.gitbooks.io/linux-insides/content/Booting/
https://comb.tistory.com/21

