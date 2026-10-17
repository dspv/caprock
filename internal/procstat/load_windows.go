package procstat

import "context"

// load1: Windows keeps no load average. gopsutil emulates one with a
// goroutine sampling the processor queue every 5 s for the life of the
// process; a figure that costs a goroutine forever and reads zero for its
// first minute is not worth it here, so there is none.
func load1(context.Context) (float64, bool, error) { return 0, false, nil }
