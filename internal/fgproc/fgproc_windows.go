package fgproc

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// foreground on Windows has no terminal foreground group to read; a console
// shell's running program is its child process. Any error is "".
//
// A process entry's parent pid is only a number recorded at creation: Windows
// never clears it when the parent exits, and it reuses pids. So csrss, whose
// parent smss.exe exits at boot, claims to be a child of whatever process
// later draws that pid. A child is therefore only a process created after the
// shell; one whose start time cannot be read is not counted.
func foreground(shellPID int) string {
	shellStart, ok := startTime(shellPID)
	if !ok {
		return ""
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ""
	}
	defer func() { _ = windows.CloseHandle(snap) }()
	var procs []proc
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if int(e.ParentProcessID) != shellPID || int(e.ProcessID) == shellPID {
			continue
		}
		start, ok := startTime(int(e.ProcessID))
		if !ok {
			continue
		}
		procs = append(procs, proc{
			pid: int(e.ProcessID), ppid: int(e.ParentProcessID),
			exe: windows.UTF16ToString(e.ExeFile[:]), start: start,
		})
	}
	return childName(shellPID, shellStart, procs)
}

// startTime is a process's creation time in 100ns ticks since 1601.
func startTime(pid int) (int64, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return 0, false
	}
	return int64(created.HighDateTime)<<32 | int64(created.LowDateTime), true
}
