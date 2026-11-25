//go:build !darwin && !linux && !windows

package procstat

// SelfReads is SelfDiskIO's read figure, and no fault count (0: not
// known). Zeros when it cannot be read.
func SelfReads() (read, faults uint64) {
	r, _, err := SelfDiskIO()
	if err != nil {
		return 0, 0
	}
	return r, 0
}
