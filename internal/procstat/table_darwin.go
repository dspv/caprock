package procstat

import (
	"context"

	"golang.org/x/sys/unix"
)

// readProcs is one sysctl: every process with its parent, owner and start.
func readProcs(_ context.Context) (map[int32]Proc, error) {
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	out := make(map[int32]Proc, len(kps))
	for i := range kps {
		k := &kps[i]
		pid := k.Proc.P_pid
		if pid <= 0 {
			continue
		}
		out[pid] = Proc{
			PID:     pid,
			PPID:    k.Eproc.Ppid,
			Name:    cString(k.Proc.P_comm[:]),
			UID:     int64(k.Eproc.Ucred.Uid),
			StartMs: k.Proc.P_starttime.Sec*1000 + int64(k.Proc.P_starttime.Usec)/1000,
			// NODEV (-1) is no controlling terminal.
			tty: k.Eproc.Tdev != -1,
		}
	}
	return out, nil
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
