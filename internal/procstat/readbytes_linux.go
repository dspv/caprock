package procstat

import "syscall"

// SelfReads is the bytes this process has caused to be read from storage
// and its major page faults (the ones that had to read), for a caller that
// asks often (internal/diskio asks around every statement and file read):
// getrusage's ru_inblock, which Linux keeps as the read_bytes /proc/self/io
// shows, in 512-byte units, and ru_majflt — one system call instead of
// opening and parsing a file. Zeros when it cannot be read.
func SelfReads() (read, faults uint64) {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil || ru.Inblock < 0 {
		return 0, 0
	}
	if ru.Majflt > 0 {
		faults = uint64(ru.Majflt)
	}
	return uint64(ru.Inblock) * 512, faults
}
