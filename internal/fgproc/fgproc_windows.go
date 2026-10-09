package fgproc

import (
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// foreground on Windows has no terminal foreground group to read; a console
// shell's running program is its child process. Console hosts are skipped:
// they belong to the console, not to what the user ran. Any error is "".
func foreground(shellPID int) string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ""
	}
	defer func() { _ = windows.CloseHandle(snap) }()
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ParentProcessID) != shellPID || int(e.ProcessID) == shellPID {
			continue
		}
		name := progName(windows.UTF16ToString(e.ExeFile[:]), "")
		switch strings.ToLower(name) {
		case "conhost", "openconsole":
			continue
		}
		return name
	}
	return ""
}
