package daemon

// The plan-window stop's wiring: where its figures come from, where its state
// is kept, how it is announced and what the dashboard is told. The rules are
// in internal/cap/window.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cap"
	"github.com/dspv/caprock/internal/license"
	"github.com/dspv/caprock/internal/store"
)

// windowStopMetaKey is where the guard's state lives in the meta table: one
// JSON value, so no migration (03-contracts.md § Plan-window stop).
const windowStopMetaKey = "window_stop"

// windowStopTick is how often paused sessions are checked for a reset, and the
// windows re-read. A minute late on a five-hour window is not noticed.
const windowStopTick = 30 * time.Second

// startWindowStop builds the guard, restores what the last run left paused,
// and runs it for the daemon's lifetime.
func (d *Daemon) startWindowStop(ctx context.Context) {
	d.winStop = &cap.WindowGuard{
		Settings: func() cap.WindowSettings {
			c := d.config()
			return cap.WindowSettings{Pct: c.WindowStop(), Licensed: license.Parse(c.LicenseKey, time.Now()).Active}
		},
		Windows: d.planWindows,
		Sig:     d.mgr,
		Notify:  d.announceWindowStop,
		Save: func(ctx context.Context, st cap.WindowState) error {
			b, err := json.Marshal(st)
			if err != nil {
				return err
			}
			return d.store.SetMeta(ctx, windowStopMetaKey, string(b))
		},
		Now: time.Now,
		Log: d.log,
	}
	if v, err := d.store.GetMeta(ctx, windowStopMetaKey); err == nil && v != "" {
		var st cap.WindowState
		if json.Unmarshal([]byte(v), &st) == nil {
			d.winStop.Load(st)
		}
	}
	go d.winStop.Run(ctx, windowStopTick)
}

// planWindows is Claude Code's five-hour and weekly windows as the status line
// last reported them, with when.
func (d *Daemon) planWindows(ctx context.Context) ([]cap.Window, error) {
	var out []cap.Window
	for _, name := range []string{cap.WindowFiveHour, cap.WindowSevenDay} {
		snap, ok, err := store.LatestRateLimit(ctx, d.store.DB(), name)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		out = append(out, cap.Window{
			Name: name, UsedPct: snap.UsedPercentage,
			ResetsAt: time.Unix(snap.ResetsAt, 0), ObservedAt: time.UnixMilli(snap.Ts),
		})
	}
	return out, nil
}

// windowName is a window as a person says it.
func windowName(w string) string {
	if w == cap.WindowSevenDay {
		return "weekly"
	}
	return "5-hour"
}

// resetClock is when a window resets, in the daemon's local time: the clock
// alone today, the weekday beside it when it is further off.
func resetClock(at, now time.Time) string {
	at = at.Local()
	if at.Sub(now) < 20*time.Hour {
		return at.Format("15:04")
	}
	return at.Format("Mon 15:04")
}

// sessionLabel names a session the way the dashboard lists it.
func (d *Daemon) sessionLabel(ctx context.Context, id string) string {
	s, err := store.GetSession(ctx, d.store.DB(), id)
	if err != nil {
		return id[:min(8, len(id))]
	}
	name := s.Project
	if name == "" {
		name = id[:min(8, len(id))]
	}
	if s.Title != "" {
		name += " · " + s.Title
	}
	return name
}

// announceWindowStop puts a stop or a resume on /v1/live as a notify frame,
// which the desktop app shows as an OS notification; the dashboard reads the
// same state from GET /v1/window-stop.
func (d *Daemon) announceWindowStop(ctx context.Context, ev cap.WindowEvent) {
	names := make([]string, 0, len(ev.Sessions))
	for _, id := range ev.Sessions {
		names = append(names, d.sessionLabel(ctx, id))
	}
	n := alerts.Notification{ID: fmt.Sprintf("window-%s-%d", ev.Kind, ev.At), Kind: "window"}
	switch ev.Kind {
	case "paused":
		n.Title = fmt.Sprintf("Paused %s · Claude's %s limit at %d%%", plural(len(names), "session"), windowName(ev.Window), int(ev.UsedPct))
		n.Body = strings.Join(names, "\n") + fmt.Sprintf("\nThey resume after it resets at %s.", resetClock(time.Unix(ev.ResumeAt, 0), time.Now()))
	default:
		n.Title = fmt.Sprintf("Resumed %s · Claude's plan window reset", plural(len(names), "session"))
		n.Body = strings.Join(names, "\n")
	}
	d.bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: n})
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// windowStopFigure is one window as GET /v1/window-stop reports it.
type windowStopFigure struct {
	Window     string  `json:"window"`
	UsedPct    float64 `json:"used_percentage"`
	ResetsAt   int64   `json:"resets_at"`   // unix seconds
	ObservedAt int64   `json:"observed_at"` // unix ms
	Fresh      bool    `json:"fresh"`
	// Stale says why a figure will not be acted on; empty when Fresh.
	Stale string `json:"stale,omitempty"`
}

// windowStopPaused is one session the stop has paused and will resume.
type windowStopPaused struct {
	SessionID string `json:"session_id"`
	Project   string `json:"project"`
	Title     string `json:"title,omitempty"`
	Window    string `json:"window"`
	ResumeAt  int64  `json:"resume_at"` // unix seconds; resumed a minute after
	PausedAt  int64  `json:"paused_at"` // unix ms
}

// windowStopStatus is GET /v1/window-stop.
type windowStopStatus struct {
	Pct       int                `json:"pct"`
	Licensed  bool               `json:"licensed"`
	FreshForS int                `json:"fresh_for_s"`
	Windows   []windowStopFigure `json:"windows"`
	Paused    []windowStopPaused `json:"paused"`
	Last      *cap.WindowEvent   `json:"last,omitempty"`
}

func (d *Daemon) windowStopStatus(ctx context.Context) any {
	c := d.config()
	now := time.Now()
	out := windowStopStatus{
		Pct: c.WindowStop(), Licensed: license.Parse(c.LicenseKey, now).Active,
		FreshForS: int(cap.FreshFor / time.Second),
		Windows:   []windowStopFigure{}, Paused: []windowStopPaused{},
	}
	if ws, err := d.planWindows(ctx); err == nil {
		for _, w := range ws {
			fresh, why := cap.Fresh(w, now)
			out.Windows = append(out.Windows, windowStopFigure{
				Window: w.Name, UsedPct: w.UsedPct, ResetsAt: w.ResetsAt.Unix(),
				ObservedAt: w.ObservedAt.UnixMilli(), Fresh: fresh, Stale: why,
			})
		}
	}
	if d.winStop == nil {
		return out
	}
	st := d.winStop.State()
	out.Last = st.Last
	for _, p := range st.Paused {
		// Only what is still paused and still ours: a session that ended
		// while paused waits in the state for its resume to be dropped.
		a, ok := d.mgr.Get(p.SessionID)
		if !ok || !a.Paused() {
			continue
		}
		row := windowStopPaused{SessionID: p.SessionID, Window: p.Window, ResumeAt: p.ResumeAt, PausedAt: p.PausedAt}
		if s, err := store.GetSession(ctx, d.store.DB(), p.SessionID); err == nil {
			row.Project, row.Title = s.Project, s.Title
		}
		out.Paused = append(out.Paused, row)
	}
	return out
}

// releaseFromWindowStop is called when the user signals a session by hand: a
// session they resumed, paused again or ended is theirs from then on.
func (d *Daemon) releaseFromWindowStop(id string) {
	if d.winStop != nil {
		d.winStop.Release(context.Background(), id)
	}
}
