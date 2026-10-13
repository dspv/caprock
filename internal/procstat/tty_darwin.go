package procstat

// HasTTY is whether p has a controlling terminal: on macOS the table says.
func HasTTY(p Proc) bool { return p.tty }
