package procstat

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetProcessIoCounters = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessIoCounters")

// SelfReads is the bytes this process has read, for a caller that asks
// often (internal/diskio asks around every statement and file read):
// GetProcessIoCounters' ReadTransferCount on this process's own handle, the
// figure SelfDiskIO reports — reads the file cache answered included. No
// fault count (0: not known; Windows counts soft faults with the ones that
// read). Zeros when it cannot be read.
func SelfReads() (read, faults uint64) {
	if procGetProcessIoCounters.Find() != nil {
		return 0, 0
	}
	var c windows.IO_COUNTERS
	if r, _, _ := procGetProcessIoCounters.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&c))); r == 0 {
		return 0, 0
	}
	return c.ReadTransferCount, 0
}
