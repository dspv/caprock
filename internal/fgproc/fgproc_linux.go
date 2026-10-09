package fgproc

import (
	"os"
	"strconv"
	"strings"
)

func foreground(shellPID int) string {
	pgid, tpgid, ok := stat(shellPID)
	if !ok || tpgid <= 0 || tpgid == shellPID || tpgid == pgid {
		return ""
	}
	if n := nameOf(tpgid); n != "" {
		return n
	}
	return Unnamed
}

// stat reads a process's group and its terminal's foreground group from
// /proc/<pid>/stat. The name field is in parentheses and may hold spaces, so
// the fields are counted from the last ')'.
func stat(pid int) (pgid, tpgid int, ok bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, 0, false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, 0, false
	}
	// After the name: state ppid pgrp session tty_nr tpgid ...
	f := strings.Fields(s[i+1:])
	if len(f) < 6 {
		return 0, 0, false
	}
	pgid, err1 := strconv.Atoi(f[2])
	tpgid, err2 := strconv.Atoi(f[5])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return pgid, tpgid, true
}

// nameOf is a running process's name from its argv[0], else its kernel name;
// "" when it is gone.
func nameOf(pid int) string {
	dir := "/proc/" + strconv.Itoa(pid) + "/"
	comm, err := os.ReadFile(dir + "comm")
	if err != nil {
		return ""
	}
	cmdline, _ := os.ReadFile(dir + "cmdline")
	return progName(firstArg(cmdline), strings.TrimSpace(string(comm)))
}
