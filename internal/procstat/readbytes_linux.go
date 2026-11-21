package procstat

import "syscall"

// SelfReadBytes is the bytes this process has caused to be read from
// storage, for a caller that asks often (internal/diskio asks around every
// statement and file read): getrusage's ru_inblock, which Linux keeps as the
// read_bytes /proc/self/io shows, in 512-byte units — one system call instead
// of opening and parsing a file. 0 when it cannot be read.
func SelfReadBytes() uint64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil || ru.Inblock < 0 {
		return 0
	}
	return uint64(ru.Inblock) * 512
}
