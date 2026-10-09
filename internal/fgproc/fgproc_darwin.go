package fgproc

import (
	"encoding/binary"

	"golang.org/x/sys/unix"
)

func foreground(shellPID int) string {
	k, err := unix.SysctlKinfoProc("kern.proc.pid", shellPID)
	if err != nil || k.Proc.P_pid != int32(shellPID) {
		return ""
	}
	tpgid := int(k.Eproc.Tpgid)
	if tpgid <= 0 || tpgid == shellPID || tpgid == int(k.Eproc.Pgid) {
		return ""
	}
	if name := nameOf(tpgid); name != "" {
		return name
	}
	// The group's leader is gone but the group is not: any member names it.
	if ps, err := unix.SysctlKinfoProcSlice("kern.proc.pgrp", tpgid); err == nil {
		for i := range ps {
			if n := nameOf(int(ps[i].Proc.P_pid)); n != "" {
				return n
			}
		}
	}
	return Unnamed
}

// nameOf is a running process's name from its argv[0], else its kernel name;
// "" when it is gone.
func nameOf(pid int) string {
	k, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || k.Proc.P_pid != int32(pid) {
		return ""
	}
	return progName(argv0(pid), unix.ByteSliceToString(k.Proc.P_comm[:]))
}

// argv0 reads kern.procargs2: a 4-byte argc, the executable's path, NUL
// padding, then argv.
func argv0(pid int) string {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(b) < 4 || binary.LittleEndian.Uint32(b[:4]) == 0 {
		return ""
	}
	b = b[4:]
	i := 0
	for i < len(b) && b[i] != 0 { // the executable's path
		i++
	}
	for i < len(b) && b[i] == 0 {
		i++
	}
	if i >= len(b) {
		return ""
	}
	return firstArg(b[i:])
}
