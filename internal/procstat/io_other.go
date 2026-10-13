//go:build !darwin && !linux

package procstat

import (
	"os"

	"github.com/shirou/gopsutil/v4/process"
)

// SelfDiskIO is the bytes this process has read and written since it
// started. On Windows it is GetProcessIoCounters (ReadTransferCount and
// WriteTransferCount), which counts every read and write call — the ones the
// file cache answered included — so it reads higher than the macOS and Linux
// figures, which count storage only.
func SelfDiskIO() (read, written uint64, err error) {
	c, err := (&process.Process{Pid: int32(os.Getpid())}).IOCounters()
	if err != nil {
		return 0, 0, err
	}
	return c.ReadBytes, c.WriteBytes, nil
}

// ResponsiblePID is macOS only; elsewhere a web view's processes are the
// app's own children and the process tree says whose they are.
func ResponsiblePID(int32) int32 { return 0 }
