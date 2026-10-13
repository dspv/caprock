package procstat

import (
	"bufio"
	"errors"
	"os"
	"strconv"
	"strings"
)

// SelfDiskIO is the bytes this process has caused to be read from and
// written to storage since it started (read_bytes and write_bytes in
// /proc/self/io): real I/O, not reads the page cache answered.
func SelfDiskIO() (read, written uint64, err error) {
	f, err := os.Open("/proc/self/io")
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = f.Close() }()
	var gotR, gotW bool
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		n, perr := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		if perr != nil {
			continue
		}
		switch k {
		case "read_bytes":
			read, gotR = n, true
		case "write_bytes":
			written, gotW = n, true
		}
	}
	if !gotR || !gotW {
		return 0, 0, errors.New("/proc/self/io has no read_bytes or write_bytes")
	}
	return read, written, nil
}

// ResponsiblePID is macOS only; elsewhere a web view's processes are the
// app's own children and the process tree says whose they are.
func ResponsiblePID(int32) int32 { return 0 }
