//go:build !darwin && !linux

package procstat

// HasTTY is false where there are no controlling terminals to read
// (Windows: a console is not one); the field is never set there.
func HasTTY(p Proc) bool { return p.tty }
