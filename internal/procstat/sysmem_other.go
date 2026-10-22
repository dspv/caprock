//go:build !darwin && !linux

package procstat

import "github.com/shirou/gopsutil/v4/mem"

// sysMemory: on Windows gopsutil's VirtualMemory is one GlobalMemoryStatusEx
// call (total and available physical memory). Windows keeps no pressure
// level, and its page file is not read: Pressure is "" and HasSwap false, so
// the level comes from how much is used.
func sysMemory() (SysMem, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return SysMem{}, err
	}
	return SysMem{Total: vm.Total, Used: windowsUsed(vm.Total, vm.Available)}, nil
}
