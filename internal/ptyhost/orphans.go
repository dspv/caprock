package ptyhost

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// RegistryEnv is set in a holder's own environment (never its child's) to
// the registry directory it registered in. It is how a daemon tells a holder
// whose Caprock install was deleted from one that belongs to another daemon
// still running — both are absent from its own registry. Holders started
// before it existed are recognised by CAPROCK_DATA_DIR instead, when their
// daemon was started with it.
const RegistryEnv = "CAPROCK_PTYHOST_REGISTRY"

// OrphanAge is how old a holder must be before it can be judged at all: a
// holder starting up has, for a moment, neither its child nor its registry
// entry.
const OrphanAge = 2 * time.Minute

// HostProc is a running `caprock pty-host` process, as the process table
// shows it. The caller fills it; Classify only reads.
type HostProc struct {
	PID     int32
	StartMs int64
	// Env is the holder's own environment, nil when it cannot be read.
	Env []string
	// Children are the holder's child processes: at most one, the session's
	// agent or shell.
	Children []ChildProc
}

// ChildProc is a holder's child.
type ChildProc struct {
	PID  int32
	Name string
	// Busy is set when the child has children of its own: a shell running a
	// command, an agent running a tool.
	Busy bool
}

// Verdict is what Classify decided about one holder.
type Verdict struct {
	PID int32 `json:"pid"`
	// State is one of:
	//   - "registered": in this daemon's registry — one of its sessions.
	//   - "foreign": registered with another Caprock (another data
	//     directory) that still lists it, or a holder whose registry
	//     cannot be told. Not this daemon's to judge.
	//   - "young": too new to judge (OrphanAge).
	//   - "dead": its child has exited and it has not. Nothing runs in it.
	//   - "unreachable-idle": its registry entry is gone (or the whole data
	//     directory), so no daemon can ever attach to it, and its child is a
	//     shell running nothing.
	//   - "unreachable-busy": unreachable, but its child is an agent or a
	//     shell running a command. Never stopped: something is still running.
	State string `json:"state"`
	// Reap is true for "dead" and "unreachable-idle": the two a reap stops.
	Reap bool `json:"reap"`
	// Ours is set when the holder registered in this daemon's own registry
	// directory (whether or not it is still listed there).
	Ours bool `json:"ours"`
	// Abandoned is set when the registry directory the holder registered in
	// no longer exists: the Caprock that started it was deleted (a preview
	// or test stand in a temporary directory, a removed install), so no
	// daemon anywhere can attach to it.
	Abandoned bool `json:"abandoned"`
	// Child names the child, when there is one.
	Child string `json:"child,omitempty"`
}

// Orphan reports whether a verdict counts as an orphan: a holder no daemon
// will ever attach to again.
func (v Verdict) Orphan() bool {
	switch v.State {
	case "dead", "unreachable-idle", "unreachable-busy":
		return true
	}
	return false
}

// shells are the programs an idle terminal runs. A holder whose child is one
// of these, with nothing running under it, holds a prompt and nothing else.
var shells = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ksh": true, "tcsh": true,
	"csh": true, "nu": true, "pwsh": true, "powershell": true, "cmd": true, "elvish": true, "xonsh": true,
}

func isShell(name string) bool {
	n := strings.ToLower(filepath.Base(name))
	n = strings.TrimSuffix(n, ".exe")
	n = strings.TrimPrefix(n, "-") // a login shell's argv[0]
	return shells[n]
}

// Classify judges each holder against ownDir, this daemon's registry
// directory. now is the clock; the registry directories it reads are the
// holders' own (from RegistryEnv, or CAPROCK_DATA_DIR), never guessed from
// HOME: a daemon started with --data-dir leaves no trace of it in the
// environment, and a guessed directory that exists without the holder in it
// would make a running session look unreachable.
func Classify(hosts []HostProc, ownDir string, now time.Time) []Verdict {
	regs := map[string]map[int32]bool{} // registry dir → host pids listed there; nil = no such dir
	listed := func(dir string) (map[int32]bool, bool) {
		if m, ok := regs[dir]; ok {
			return m, m != nil
		}
		recs, _, err := readRecords(dir)
		if err != nil {
			regs[dir] = map[int32]bool{} // unreadable: treat as present, listing nothing known
			return regs[dir], true
		}
		if _, statErr := os.Stat(dir); statErr != nil {
			regs[dir] = nil
			return nil, false
		}
		m := map[int32]bool{}
		for _, r := range recs {
			m[int32(r.HostPID)] = true
		}
		regs[dir] = m
		return m, true
	}
	own, _ := listed(ownDir)
	out := make([]Verdict, 0, len(hosts))
	for _, h := range hosts {
		v := Verdict{PID: h.PID}
		if len(h.Children) > 0 {
			v.Child = filepath.Base(h.Children[0].Name)
		}
		dir := registryOf(h.Env)
		v.Ours = own[h.PID] || (dir != "" && samePath(dir, ownDir))
		switch {
		case own[h.PID]:
			v.State = "registered"
		case h.StartMs > 0 && now.Sub(time.UnixMilli(h.StartMs)) < OrphanAge:
			v.State = "young"
		case len(h.Children) == 0:
			// A holder exits when its child does; one still here without a
			// child serves nothing, whichever daemon started it.
			v.State, v.Reap = "dead", true
		default:
			if dir == "" {
				v.State = "foreign"
				break
			}
			if samePath(dir, ownDir) {
				// Our own directory, and not listed in it.
				v.State = unreachable(h.Children)
				break
			}
			m, exists := listed(dir)
			if exists && m[h.PID] {
				v.State = "foreign"
				break
			}
			v.Abandoned = !exists
			v.State = unreachable(h.Children)
		}
		v.Reap = v.State == "dead" || v.State == "unreachable-idle"
		out = append(out, v)
	}
	return out
}

func unreachable(children []ChildProc) string {
	for _, c := range children {
		if c.Busy || !isShell(c.Name) {
			return "unreachable-busy"
		}
	}
	return "unreachable-idle"
}

// registryOf reads a holder's registry directory out of its environment.
func registryOf(env []string) string {
	var dataDir string
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || v == "" {
			continue
		}
		if runtime.GOOS == "windows" {
			k = strings.ToUpper(k)
		}
		switch k {
		case RegistryEnv:
			return filepath.Clean(v)
		case "CAPROCK_DATA_DIR":
			dataDir = v
		}
	}
	if dataDir != "" {
		return Dir(filepath.Clean(dataDir))
	}
	return ""
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	ra, err1 := filepath.EvalSymlinks(a)
	rb, err2 := filepath.EvalSymlinks(b)
	return err1 == nil && err2 == nil && ra == rb
}
