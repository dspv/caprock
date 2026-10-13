package procstat

import (
	"errors"
	"os"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/shirou/gopsutil/v4/process"
)

// rusageInfoV2 is Darwin's struct rusage_info_v2 (sys/resource.h).
type rusageInfoV2 struct {
	UUID           [16]byte
	UserTime       uint64
	SystemTime     uint64
	PkgIdleWkups   uint64
	InterruptWkups uint64
	Pageins        uint64
	WiredSize      uint64
	ResidentSize   uint64
	PhysFootprint  uint64
	_              [8]uint64 // start/exit times, the children's figures
	// DiskioBytesRead and DiskioBytesWritten are the bytes the process has
	// read from and written to storage over its life (ri_diskio_bytesread,
	// ri_diskio_byteswritten): real I/O, not reads the page cache answered.
	DiskioBytesRead    uint64
	DiskioBytesWritten uint64
}

const rusageInfoV2Flavor = 2

var (
	rusageOnce sync.Once
	pidRusage  func(pid int32, flavor int32, buf unsafe.Pointer) int32
	// responsibleFor is responsibility_get_pid_responsible_for_pid: the
	// process macOS holds responsible for another — the app behind the XPC
	// services it uses. Nil when the symbol cannot be found.
	responsibleFor func(pid int32) int32
)

// loadLibSystem binds the libSystem functions this file calls, once. A
// function that cannot be found stays nil and its caller falls back.
func loadLibSystem() {
	rusageOnce.Do(func() {
		lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		if _, err := purego.Dlsym(lib, "proc_pid_rusage"); err == nil {
			purego.RegisterLibFunc(&pidRusage, lib, "proc_pid_rusage")
		}
		if _, err := purego.Dlsym(lib, "responsibility_get_pid_responsible_for_pid"); err == nil {
			purego.RegisterLibFunc(&responsibleFor, lib, "responsibility_get_pid_responsible_for_pid")
		}
	})
}

// ResponsiblePID is the process macOS holds responsible for pid: for a
// WebKit helper (com.apple.WebKit.WebContent, .GPU, .Networking), the app
// whose web view it serves. Those helpers are launchd's children, not the
// app's, so the process tree alone cannot say whose they are. 0 when it
// cannot be told.
func ResponsiblePID(pid int32) int32 {
	loadLibSystem()
	if responsibleFor == nil {
		return 0
	}
	if r := responsibleFor(pid); r > 0 {
		return r
	}
	return 0
}

// SelfDiskIO is the bytes this process has read from and written to storage
// since it started.
func SelfDiskIO() (read, written uint64, err error) {
	loadLibSystem()
	if pidRusage == nil {
		return 0, 0, errors.New("proc_pid_rusage is not available")
	}
	var ri rusageInfoV2
	if pidRusage(int32(os.Getpid()), rusageInfoV2Flavor, unsafe.Pointer(&ri)) != 0 {
		return 0, 0, errors.New("proc_pid_rusage failed")
	}
	return ri.DiskioBytesRead, ri.DiskioBytesWritten, nil
}

// ownMemory is the physical footprint — Activity Monitor's Memory column:
// the process's dirty and compressed pages, without the clean file pages it
// maps. Falls back to the resident set when libproc cannot be reached.
func ownMemory(p *process.Process) (uint64, error) {
	loadLibSystem()
	if pidRusage != nil {
		var ri rusageInfoV2
		if pidRusage(p.Pid, rusageInfoV2Flavor, unsafe.Pointer(&ri)) == 0 && ri.PhysFootprint > 0 {
			return ri.PhysFootprint, nil
		}
	}
	m, err := p.MemoryInfo()
	if err != nil {
		return 0, err
	}
	if m.RSS == 0 {
		return 0, errors.New("no memory reading")
	}
	return m.RSS, nil
}
