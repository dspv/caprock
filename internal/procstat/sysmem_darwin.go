package procstat

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

// host_statistics64's flavor and count for struct vm_statistics64
// (mach/host_info.h): HOST_VM_INFO64, and the struct's size in 32-bit words.
const (
	hostVMInfo64      = 4
	hostVMInfo64Count = uint32(unsafe.Sizeof(vmStatistics64{}) / 4)
)

var (
	machOnce     sync.Once
	machHost     uint32
	hostStats64  func(host uint32, flavor int32, info unsafe.Pointer, count unsafe.Pointer) int32
	machHostSelf func() uint32
)

// loadMach binds mach_host_self and host_statistics64 once and takes the
// host port once: every call to mach_host_self adds a reference to it.
func loadMach() {
	machOnce.Do(func() {
		lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		if _, err := purego.Dlsym(lib, "host_statistics64"); err != nil {
			return
		}
		if _, err := purego.Dlsym(lib, "mach_host_self"); err != nil {
			return
		}
		purego.RegisterLibFunc(&hostStats64, lib, "host_statistics64")
		purego.RegisterLibFunc(&machHostSelf, lib, "mach_host_self")
		machHost = machHostSelf()
	})
}

// sysMemory: hw.memsize, host_statistics64 for what is used, vm.swapusage
// and kern.memorystatus_vm_pressure_level — the figures Activity Monitor's
// Memory tab shows, and the pressure its graph is coloured by.
func sysMemory() (SysMem, error) {
	var m SysMem
	total, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return m, err
	}
	m.Total = total
	loadMach()
	if hostStats64 == nil || machHost == 0 {
		return m, errors.New("host_statistics64 is not available")
	}
	var vm vmStatistics64
	count := hostVMInfo64Count
	if kr := hostStats64(machHost, hostVMInfo64, unsafe.Pointer(&vm), unsafe.Pointer(&count)); kr != 0 {
		return m, errors.New("host_statistics64 failed")
	}
	m.Used = darwinUsed(vm, uint64(unix.Getpagesize()), total)
	if raw, err := unix.SysctlRaw("vm.swapusage"); err == nil {
		if t, u, ok := parseSwapUsage(raw); ok {
			m.SwapTotal, m.SwapUsed, m.HasSwap = t, u, true
		}
	}
	if lvl, err := unix.SysctlUint32("kern.memorystatus_vm_pressure_level"); err == nil {
		m.Pressure = darwinPressure(lvl)
	}
	return m, nil
}
