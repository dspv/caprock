package tcc

import (
	"golang.org/x/sys/unix"

	"github.com/dspv/caprock/internal/disclaim"
)

// responsibleExe is the executable of the process macOS holds responsible
// for pid: responsibility_get_pid_responsible_for_pid (read-only, through
// internal/disclaim), then that process's executable path from
// kern.procargs2 (a 4-byte argc, then the path the kernel executed).
func responsibleExe(pid int) string {
	r := disclaim.ResponsibleFor(pid)
	if r <= 0 {
		return ""
	}
	b, err := unix.SysctlRaw("kern.procargs2", r)
	if err != nil || len(b) < 5 {
		return ""
	}
	b = b[4:]
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return ""
}
