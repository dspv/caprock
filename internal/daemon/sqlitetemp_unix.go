//go:build unix

package daemon

import (
	"os"
	"strconv"
	"syscall"
)

// sqliteTempBytes is the size of the largest file this process holds open
// that has no name: SQLite creates its temporary files and unlinks them at
// once, so during a VACUUM that is the packed copy it is building. Read
// through the open descriptors (/dev/fd; on Linux a link to /proc/self/fd).
// On a copy of the owner's database the file grew steadily to the packed
// size over the first half of the VACUUM, while nothing else was written
// (2026-11-07).
func sqliteTempBytes() (int64, bool) {
	ents, err := os.ReadDir("/dev/fd")
	if err != nil {
		return 0, false
	}
	var largest int64
	for _, e := range ents {
		fd, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil {
			continue
		}
		if st.Mode&syscall.S_IFMT == syscall.S_IFREG && st.Nlink == 0 && st.Size > largest {
			largest = st.Size
		}
	}
	return largest, true
}
