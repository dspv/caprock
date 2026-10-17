//go:build !windows

package procstat

import (
	"context"

	"github.com/shirou/gopsutil/v4/load"
)

// load1 is the one-minute load average.
func load1(ctx context.Context) (float64, bool, error) {
	a, err := load.AvgWithContext(ctx)
	if err != nil {
		return 0, false, err
	}
	return a.Load1, true, nil
}
