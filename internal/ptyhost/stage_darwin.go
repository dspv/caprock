package ptyhost

import (
	"bytes"

	"golang.org/x/sys/unix"
)

// cloneTree copies the bundle src to dst in one call, copy-on-write on APFS:
// no second copy of the bytes on disk, and every file, link, permission and
// extended attribute as it was.
func cloneTree(src, dst string) error {
	return unix.Clonefile(src, dst, unix.CLONE_NOFOLLOW)
}

// runningHolderExes lists the executables this user's running holders were
// started from: each process named as the holder-only binary is, by the path
// the kernel executed (kern.procargs2). It reads the process table and
// raises nothing.
func runningHolderExes() ([]string, error) {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	// The kernel keeps at most MAXCOMLEN (16) bytes of the name.
	name := []byte(BinaryName())
	if len(name) > 16 {
		name = name[:16]
	}
	var out []string
	for i := range procs {
		comm := procs[i].Proc.P_comm[:]
		if n := bytes.IndexByte(comm, 0); n >= 0 {
			comm = comm[:n]
		}
		if !bytes.Equal(comm, name) {
			continue
		}
		if exe := execPath(int(procs[i].Proc.P_pid)); exe != "" {
			out = append(out, exe)
		}
	}
	return out, nil
}

// execPath is the path pid was executed from: kern.procargs2 is a 4-byte
// argc, then that path. "" when it cannot be read (another user's process,
// one that is gone).
func execPath(pid int) string {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(b) < 5 {
		return ""
	}
	b = b[4:]
	if n := bytes.IndexByte(b, 0); n >= 0 {
		return string(b[:n])
	}
	return ""
}
