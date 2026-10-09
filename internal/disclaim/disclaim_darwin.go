package disclaim

import (
	"syscall"
	"unsafe"
)

// libSystem is called the way golang.org/x/sys/unix calls it: dynamic imports,
// assembly trampolines and the runtime's libc call path. No cgo, so the build
// stays CGO_ENABLED=0 (06-engineering-rules: pure Go only).

//go:cgo_import_dynamic libc_posix_spawn posix_spawn "/usr/lib/libSystem.B.dylib"
//go:cgo_import_dynamic libc_posix_spawnattr_init posix_spawnattr_init "/usr/lib/libSystem.B.dylib"
//go:cgo_import_dynamic libc_posix_spawnattr_setflags posix_spawnattr_setflags "/usr/lib/libSystem.B.dylib"
//go:cgo_import_dynamic libc_posix_spawnattr_setsigmask posix_spawnattr_setsigmask "/usr/lib/libSystem.B.dylib"
//go:cgo_import_dynamic libc_posix_spawnattr_setsigdefault posix_spawnattr_setsigdefault "/usr/lib/libSystem.B.dylib"
//go:cgo_import_dynamic libc_dlsym dlsym "/usr/lib/libSystem.B.dylib"

var (
	libc_posix_spawn_trampoline_addr                   uintptr
	libc_posix_spawnattr_init_trampoline_addr          uintptr
	libc_posix_spawnattr_setflags_trampoline_addr      uintptr
	libc_posix_spawnattr_setsigmask_trampoline_addr    uintptr
	libc_posix_spawnattr_setsigdefault_trampoline_addr uintptr
	libc_dlsym_trampoline_addr                         uintptr
)

//go:linkname syscall_syscall6 syscall.syscall6
func syscall_syscall6(fn, a1, a2, a3, a4, a5, a6 uintptr) (r1, r2 uintptr, err syscall.Errno)

const supported = true

// From <sys/spawn.h>.
const (
	spawnSetSigDef  = 0x0004
	spawnSetSigMask = 0x0008
	spawnSetExec    = 0x0040
)

// rtldDefault is RTLD_DEFAULT, ((void *) -2).
const rtldDefault = ^uintptr(1)

// setdisclaim looks up responsibility_spawnattrs_setdisclaim at run time: it
// is private API (macOS 10.14+), and a static import of a symbol that is gone
// would stop the whole binary from loading.
func setdisclaim() uintptr {
	name := []byte("responsibility_spawnattrs_setdisclaim\x00")
	fn, _, _ := syscall_syscall6(libc_dlsym_trampoline_addr, rtldDefault, uintptr(unsafe.Pointer(&name[0])), 0, 0, 0, 0)
	return fn
}

// Available reports whether this macOS offers the disclaim attribute.
func Available() bool { return setdisclaim() != 0 }

// execDisclaimed replaces this process with path, like execve, but with the
// responsibility for it disclaimed. Signals start at their defaults and
// unblocked, as after os/exec. It returns only when the program could not be
// started; without the attribute it falls back to a plain exec.
func execDisclaimed(path string, argv, env []string) error {
	pathp, err := syscall.BytePtrFromString(path)
	if err != nil {
		return err
	}
	argvp, err := syscall.SlicePtrFromStrings(argv)
	if err != nil {
		return err
	}
	envp, err := syscall.SlicePtrFromStrings(env)
	if err != nil {
		return err
	}
	disclaim := setdisclaim()
	if disclaim == 0 {
		return syscall.Exec(path, argv, env)
	}
	attr := new(uintptr) // posix_spawnattr_t, an opaque pointer
	if r, _, _ := syscall_syscall6(libc_posix_spawnattr_init_trampoline_addr, uintptr(unsafe.Pointer(attr)), 0, 0, 0, 0, 0); r != 0 {
		return syscall.Exec(path, argv, env)
	}
	empty, full := new(uint32), new(uint32)
	*full = ^uint32(0)
	// posix_spawn reports failure in its return value, not errno: each r is
	// the error number, 0 on success. Any failure setting up the attribute
	// falls back to a plain exec, which still runs the program.
	flags := uintptr(spawnSetExec | spawnSetSigDef | spawnSetSigMask)
	for _, call := range [][2]uintptr{
		{libc_posix_spawnattr_setsigmask_trampoline_addr, uintptr(unsafe.Pointer(empty))},
		{libc_posix_spawnattr_setsigdefault_trampoline_addr, uintptr(unsafe.Pointer(full))},
		{libc_posix_spawnattr_setflags_trampoline_addr, flags},
	} {
		if r, _, _ := syscall_syscall6(call[0], uintptr(unsafe.Pointer(attr)), call[1], 0, 0, 0, 0); r != 0 {
			return syscall.Exec(path, argv, env)
		}
	}
	if r, _, _ := syscall_syscall6(disclaim, uintptr(unsafe.Pointer(attr)), 1, 0, 0, 0, 0); r != 0 {
		return syscall.Exec(path, argv, env)
	}
	pid := new(int32)
	r, _, _ := syscall_syscall6(libc_posix_spawn_trampoline_addr,
		uintptr(unsafe.Pointer(pid)),
		uintptr(unsafe.Pointer(pathp)),
		0, // no file actions: every descriptor without close-on-exec stays
		uintptr(unsafe.Pointer(attr)),
		uintptr(unsafe.Pointer(&argvp[0])),
		uintptr(unsafe.Pointer(&envp[0])))
	// With POSIX_SPAWN_SETEXEC, posix_spawn returns only on failure.
	return syscall.Errno(r)
}
