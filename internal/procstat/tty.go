package procstat

import (
	"strconv"
	"strings"
)

// statTTY reads tty_nr out of a Linux /proc/<pid>/stat line. The command
// name (field 2) is in parentheses and may hold spaces and parentheses
// itself, so the fields are counted after its last ")". Kept free of build
// tags so it is tested on every OS.
func statTTY(line string) bool {
	i := strings.LastIndexByte(line, ')')
	if i < 0 {
		return false
	}
	f := strings.Fields(line[i+1:])
	// f[0] is the state (field 3); tty_nr is field 7.
	if len(f) < 5 {
		return false
	}
	n, err := strconv.ParseInt(f[4], 10, 64)
	return err == nil && n != 0
}
