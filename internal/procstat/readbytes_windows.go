package procstat

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetProcessIoCounters = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetProcessIoCounters")

// SelfReadBytes is the bytes this process has read, for a caller that asks
// often (internal/diskio asks around every statement and file read):
// GetProcessIoCounters' ReadTransferCount on this process's own handle, the
// figure SelfDiskIO reports — reads the file cache answered included. 0 when
// it cannot be read.
func SelfReadBytes() uint64 {
	if procGetProcessIoCounters.Find() != nil {
		return 0
	}
	var c windows.IO_COUNTERS
	if r, _, _ := procGetProcessIoCounters.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&c))); r == 0 {
		return 0
	}
	return c.ReadTransferCount
}
