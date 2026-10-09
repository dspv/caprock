// Trampolines to libSystem, as in golang.org/x/sys/unix: the same text
// assembles for amd64 and arm64.

#include "textflag.h"

TEXT libc_posix_spawn_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_posix_spawn(SB)
GLOBL	·libc_posix_spawn_trampoline_addr(SB), RODATA, $8
DATA	·libc_posix_spawn_trampoline_addr(SB)/8, $libc_posix_spawn_trampoline<>(SB)

TEXT libc_posix_spawnattr_init_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_posix_spawnattr_init(SB)
GLOBL	·libc_posix_spawnattr_init_trampoline_addr(SB), RODATA, $8
DATA	·libc_posix_spawnattr_init_trampoline_addr(SB)/8, $libc_posix_spawnattr_init_trampoline<>(SB)

TEXT libc_posix_spawnattr_setflags_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_posix_spawnattr_setflags(SB)
GLOBL	·libc_posix_spawnattr_setflags_trampoline_addr(SB), RODATA, $8
DATA	·libc_posix_spawnattr_setflags_trampoline_addr(SB)/8, $libc_posix_spawnattr_setflags_trampoline<>(SB)

TEXT libc_posix_spawnattr_setsigmask_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_posix_spawnattr_setsigmask(SB)
GLOBL	·libc_posix_spawnattr_setsigmask_trampoline_addr(SB), RODATA, $8
DATA	·libc_posix_spawnattr_setsigmask_trampoline_addr(SB)/8, $libc_posix_spawnattr_setsigmask_trampoline<>(SB)

TEXT libc_posix_spawnattr_setsigdefault_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_posix_spawnattr_setsigdefault(SB)
GLOBL	·libc_posix_spawnattr_setsigdefault_trampoline_addr(SB), RODATA, $8
DATA	·libc_posix_spawnattr_setsigdefault_trampoline_addr(SB)/8, $libc_posix_spawnattr_setsigdefault_trampoline<>(SB)

TEXT libc_dlsym_trampoline<>(SB),NOSPLIT,$0-0
	JMP	libc_dlsym(SB)
GLOBL	·libc_dlsym_trampoline_addr(SB), RODATA, $8
DATA	·libc_dlsym_trampoline_addr(SB)/8, $libc_dlsym_trampoline<>(SB)
