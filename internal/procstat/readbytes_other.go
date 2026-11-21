//go:build !darwin && !linux && !windows

package procstat

// SelfReadBytes is SelfDiskIO's read figure alone. 0 when it cannot be read.
func SelfReadBytes() uint64 {
	r, _, err := SelfDiskIO()
	if err != nil {
		return 0
	}
	return r
}
