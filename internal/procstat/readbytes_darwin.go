package procstat

// SelfReadBytes is SelfDiskIO's read figure alone, for a caller that asks
// often (internal/diskio asks around every statement and file read): one
// proc_pid_rusage call. 0 when it cannot be read.
func SelfReadBytes() uint64 {
	r, _, err := SelfDiskIO()
	if err != nil {
		return 0
	}
	return r
}
