package procstat

import (
	"errors"
	"os"
)

// sysMemory: /proc/meminfo, and /proc/pressure/memory where the kernel keeps
// PSI (4.20 and later, when built with it); without it Pressure is "".
func sysMemory() (SysMem, error) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return SysMem{}, err
	}
	m, ok := parseMeminfo(string(b))
	if !ok {
		return SysMem{}, errors.New("/proc/meminfo has no MemTotal")
	}
	if p, err := os.ReadFile("/proc/pressure/memory"); err == nil {
		if some, full, ok := parsePSI(string(p)); ok {
			m.Pressure = psiPressure(some, full)
		}
	}
	return m, nil
}
