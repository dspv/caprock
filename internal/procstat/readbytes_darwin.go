package procstat

import (
	"os"
	"unsafe"
)

// SelfReads is the bytes this process has caused to be read from storage
// and the page faults it has taken that had to read (ri_diskio_bytesread,
// ri_pageins), for a caller that asks often (internal/diskio asks around
// every statement and file read): one proc_pid_rusage call. Zeros when it
// cannot be read.
func SelfReads() (read, faults uint64) {
	loadLibSystem()
	if pidRusage == nil {
		return 0, 0
	}
	var ri rusageInfoV2
	if pidRusage(int32(os.Getpid()), rusageInfoV2Flavor, unsafe.Pointer(&ri)) != 0 {
		return 0, 0
	}
	return ri.DiskioBytesRead, ri.Pageins
}
