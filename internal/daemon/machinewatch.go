package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/peers"
)

// One list across computers (ADR-067, Phase 2). While someone at this
// machine is looking — a dashboard or the app holds /v1/live from loopback —
// this daemon holds one /v1/live on each computer it reaches, through the
// channel it already has, asking only for notify and permission frames
// (?types=, so the relay carries a prompt, not every event). What arrives is
// re-published here, local only (bus.Frame.LocalOnly):
//
//   - a notify frame, with the computer's id and name, so the app tells of a
//     session there that needs its owner as it tells of one here;
//   - a machines frame {id, why}, so the sidebar and Now read GET
//     /v1/machines/sessions again, and the kept list of that computer is
//     dropped (api.Server.MachineChanged).
//
// Nobody looking for machineWatchLinger, the sockets close and the channels
// idle out 90 s later (ADR-067, connected on demand). Nothing here is dialled
// before the user pasted a computer's link (rule 4): with no machines.json
// the loop only stats the file.

const (
	// machineWatchEvery is how often the loop looks at who is watching and
	// which computers there are.
	machineWatchEvery = 3 * time.Second
	// machineWatchLinger is how long the sockets stay open after the last
	// local client left: a reload or a window switch does not re-dial.
	machineWatchLinger = 90 * time.Second
	// machineWatchRetryMin and Max bound the wait after a socket failed:
	// asleep or off is waited out, not hammered.
	machineWatchRetryMin = 2 * time.Second
	machineWatchRetryMax = 60 * time.Second
	// machineWatchStable is how long a socket has to stay up to count as a
	// connection rather than a refusal: one that drops sooner backs off as a
	// failed one does, so a computer that accepts and hangs up at once is
	// not re-dialled, and its lists re-read, every 2 s.
	machineWatchStable = 10 * time.Second
	// machineWatchTypes are the frames asked of another computer.
	machineWatchTypes = "notify,permission"
)

// watchPace is how long watchMachine waits between attempts; a test passes
// shorter ones.
type watchPace struct{ min, max, stable time.Duration }

var machineWatchPace = watchPace{min: machineWatchRetryMin, max: machineWatchRetryMax, stable: machineWatchStable}

// watchedMachines is what the watch needs of the computers this machine
// reaches: api.Machines, narrowed, so a test can stand in for the channels.
type watchedMachines interface {
	List() []peers.Status
	Get(id string) (peers.Status, error)
	Check(ctx context.Context, id string) (peers.Status, error)
	OpenWS(ctx context.Context, id, path string, protocols []string) (api.MachineSocket, error)
}

// MachineNotification is a notify frame from another computer: its own
// fields, and which computer said it.
type MachineNotification struct {
	alerts.Notification
	Machine     string `json:"machine"`
	MachineName string `json:"machine_name"`
}

// machineWatch holds the sockets, one per computer.
type machineWatch struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
	looked  time.Time
}

func (d *Daemon) machineWatchLoop(ctx context.Context) {
	w := &machineWatch{running: map[string]context.CancelFunc{}}
	t := time.NewTicker(machineWatchEvery)
	defer t.Stop()
	defer w.stopAll()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.machineWatchTick(ctx, w)
		}
	}
}

func (w *machineWatch) stopAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for id, cancel := range w.running {
		cancel()
		delete(w.running, id)
	}
}

// machineWatchTick opens a socket on each computer while someone looks,
// and closes those of computers forgotten or no longer looked at.
func (d *Daemon) machineWatchTick(ctx context.Context, w *machineWatch) {
	if d.api == nil || d.machines == nil || d.opt.DataDir == "" {
		return
	}
	if _, err := os.Stat(filepath.Join(d.opt.DataDir, peers.File)); err != nil {
		w.stopAll() // never linked, or the last one forgotten
		return
	}
	now := time.Now()
	if d.api.LocalLiveClients() > 0 {
		w.looked = now
	}
	want := map[string]bool{}
	if !w.looked.IsZero() && now.Sub(w.looked) < machineWatchLinger {
		for _, m := range d.machines.List() {
			switch m.Status {
			case peers.StatusRevoked, "refused":
				// Its owner removed this machine, or it is another machine:
				// nothing to hear until the user pairs again.
			default:
				want[m.ID] = true
			}
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	for id, cancel := range w.running {
		if !want[id] {
			cancel()
			delete(w.running, id)
		}
	}
	for id := range want {
		if w.running[id] != nil {
			continue
		}
		mctx, cancel := context.WithCancel(ctx)
		w.running[id] = cancel
		go d.watchMachine(mctx, d.machines, id, machineWatchPace)
	}
}

// watchMachine keeps one /v1/live open on computer id until ctx ends,
// reopening it after a drop from the last frame it heard.
func (d *Daemon) watchMachine(ctx context.Context, m watchedMachines, id string, pace watchPace) {
	wait := pace.min
	var since uint64
	for ctx.Err() == nil {
		path := "/v1/live?types=" + machineWatchTypes
		if since > 0 {
			path += "&since=" + strconv.FormatUint(since, 10)
		}
		octx, cancel := context.WithTimeout(ctx, 30*time.Second)
		ws, err := m.OpenWS(octx, id, path, nil)
		cancel()
		if err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) && (ce.Code == 4401 || ce.Code == 4403) {
				// Not let in there (waiting for Allow, or removed): ask who
				// this machine is there, and wait long.
				cctx, ccancel := context.WithTimeout(ctx, 10*time.Second)
				_, _ = m.Check(cctx, id)
				ccancel()
				wait = pace.max
			}
			if !sleepCtx(ctx, wait) {
				return
			}
			wait = min(wait*2, pace.max)
			continue
		}
		opened := time.Now()
		d.machineChanged(id, "online")
		since = d.readMachineLive(ctx, m, id, ws, since)
		_ = ws.Close(websocket.StatusNormalClosure, "")
		if ctx.Err() != nil {
			return
		}
		d.machineChanged(id, "offline")
		if time.Since(opened) >= pace.stable {
			// It stood: a drop now is the network's, retried soon.
			wait = pace.min
		}
		if !sleepCtx(ctx, wait) {
			return
		}
		wait = min(wait*2, pace.max)
	}
}

// liveFrame is a frame from another computer's /v1/live.
type liveFrame struct {
	Type bus.FrameType   `json:"type"`
	Seq  uint64          `json:"seq"`
	Data json.RawMessage `json:"data"`
}

// readMachineLive re-publishes what computer id sends until its socket
// ends, and answers the seq it got to: the computer's own position, taken
// from every frame (hello, reset, ping and pong carry it too), never the
// highest ever heard. A computer that restarted counts from 1 again, and a
// since past its newest frame would earn a reset on every reconnect, losing
// what was said there while the socket was down.
func (d *Daemon) readMachineLive(ctx context.Context, m watchedMachines, id string, ws interface {
	Read(context.Context) (websocket.MessageType, []byte, error)
}, since uint64) uint64 {
	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return since
		}
		var f liveFrame
		if json.Unmarshal(msg, &f) != nil {
			continue
		}
		since = f.Seq
		switch f.Type {
		case bus.FrameNotify:
			var n alerts.Notification
			if json.Unmarshal(f.Data, &n) != nil || n.ID == "" {
				continue
			}
			name := id
			if st, err := m.Get(id); err == nil {
				name = st.Name
			}
			if d.api != nil {
				d.api.MachineChanged(id)
			}
			d.bus.Publish(bus.Frame{Type: bus.FrameNotify, LocalOnly: true, Data: MachineNotification{Notification: n, Machine: id, MachineName: name}})
			d.bus.Publish(bus.Frame{Type: bus.FrameMachines, LocalOnly: true, Data: machinesFrame{ID: id, Why: "notify", SessionID: n.SessionID}})
		case bus.FramePermission:
			var p struct {
				SessionID  string          `json:"session_id"`
				Permission json.RawMessage `json:"permission"`
			}
			if json.Unmarshal(f.Data, &p) != nil {
				continue
			}
			why := "permission"
			if len(p.Permission) == 0 || string(p.Permission) == "null" {
				why = "answered"
			}
			d.machineChangedFor(id, why, p.SessionID)
		case "reset":
			// The frames since the last one heard are gone there: what it
			// lists now is read again.
			d.machineChanged(id, "reset")
		}
	}
}

// machinesFrame is the machines frame's data.
type machinesFrame struct {
	ID        string `json:"id"`
	Why       string `json:"why"`
	SessionID string `json:"session_id,omitempty"`
}

func (d *Daemon) machineChanged(id, why string) { d.machineChangedFor(id, why, "") }

func (d *Daemon) machineChangedFor(id, why, session string) {
	if d.api != nil {
		d.api.MachineChanged(id)
	}
	d.bus.Publish(bus.Frame{Type: bus.FrameMachines, LocalOnly: true, Data: machinesFrame{ID: id, Why: why, SessionID: session}})
}

// sleepCtx waits d or until ctx ends; false when it ended.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
