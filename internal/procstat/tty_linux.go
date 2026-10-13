package procstat

import (
	"os"
	"strconv"
)

// HasTTY is whether p has a controlling terminal: tty_nr, the seventh field
// of /proc/<pid>/stat, is not zero. A process that cannot be read says no.
func HasTTY(p Proc) bool {
	if p.tty { // never set from the Linux table; kept for one shape on every OS
		return true
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(int(p.PID)) + "/stat")
	if err != nil {
		return false
	}
	return statTTY(string(b))
}
