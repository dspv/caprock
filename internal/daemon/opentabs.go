package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
)

// The tabs each dashboard has open (03-contracts.md § Open tabs). Tabs live
// in the browser (localStorage), so the daemon knows a session has one only
// because the dashboard says so: PUT /v1/tabs with the whole list, on every
// change and every few minutes while it is open. The idle end
// (endidle.go) never ends a session in any viewer's list.
//
// Each viewer's last list is kept in a file, so a restarted daemon still
// knows, and so does a daemon whose app was closed for the night: its tabs
// are still open, they are only not on screen. A viewer that has not said
// anything for tabReportTTL (a browser not opened for a week, a phone that
// was paired once) no longer counts.
//
// Each list is in tab-strip order, and the phone home mirrors one of them
// (GET /v1/tabs, latest): its Continue shows the computer's tabs, in the
// computer's order.

// openTabsFile is the file under the data directory.
const openTabsFile = "open-tabs.json"

// tabReportTTL is how long a viewer's last list counts without a new one.
const tabReportTTL = 7 * 24 * time.Hour

// tabPresentFor is how long after its last report a viewer still counts as
// open on screen: three of its 10-minute heartbeats (ui/src/lib/reportTabs.ts).
const tabPresentFor = 30 * time.Minute

type tabReport struct {
	// At is when the viewer last reported, unix ms.
	At int64 `json:"at"`
	// Changed is when its list last changed, unix ms: a heartbeat repeating
	// the same list leaves it. Absent in a file written before it existed.
	Changed  int64    `json:"changed,omitempty"`
	Sessions []string `json:"sessions"`
}

type openTabs struct {
	path string // "" keeps the lists in memory only (tests)
	now  func() time.Time

	mu      sync.Mutex
	viewers map[string]tabReport
}

func newOpenTabs(dataDir string) *openTabs {
	t := &openTabs{now: time.Now, viewers: map[string]tabReport{}}
	if dataDir != "" {
		t.path = filepath.Join(dataDir, openTabsFile)
		t.load()
	}
	return t
}

func (t *openTabs) load() {
	b, err := os.ReadFile(t.path)
	if err != nil {
		return
	}
	var f struct {
		Viewers map[string]tabReport `json:"viewers"`
	}
	if json.Unmarshal(b, &f) == nil && f.Viewers != nil {
		t.viewers = f.Viewers
	}
}

// report replaces a viewer's list.
func (t *openTabs) report(viewer string, sessions []string) error {
	if t == nil {
		return errors.New("open tabs are not kept")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	old, had := t.viewers[viewer]
	same := had && slices.Equal(old.Sessions, sessions)
	changed := now.UnixMilli()
	if same {
		changed = old.Changed
		if changed == 0 {
			changed = old.At
		}
	}
	t.viewers[viewer] = tabReport{At: now.UnixMilli(), Changed: changed, Sessions: slices.Clone(sessions)}
	for v, r := range t.viewers {
		if now.Sub(time.UnixMilli(r.At)) > tabReportTTL {
			delete(t.viewers, v)
		}
	}
	// Only a changed list, or a stale one, is written: the heartbeat that
	// repeats the same list every few minutes need not touch the disk each
	// time. A list in the same order is the same list; a drag is a change.
	if same && old.Changed != 0 && now.Sub(time.UnixMilli(old.At)) < time.Hour {
		return nil
	}
	return t.saveLocked()
}

func (t *openTabs) saveLocked() error {
	if t.path == "" {
		return nil
	}
	b, err := json.Marshal(struct {
		Viewers map[string]tabReport `json:"viewers"`
	}{t.viewers})
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(t.path, b, 0o600)
}

// open is every session some viewer that reported within tabReportTTL has
// a tab for.
func (t *openTabs) open() map[string]bool {
	out := map[string]bool{}
	if t == nil {
		return out
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	for _, r := range t.viewers {
		if now.Sub(time.UnixMilli(r.At)) > tabReportTTL {
			continue
		}
		for _, id := range r.Sessions {
			out[id] = true
		}
	}
	return out
}

// latest is the list the phone home mirrors (GET /v1/tabs): of the viewers
// still within tabReportTTL, one on screen now (reported within
// tabPresentFor) before one that is not, and then the one whose list changed
// last — the window the user last opened, closed or dragged a tab in. A
// heartbeat changes nothing, so two windows open at once never take turns.
// ok is false when no viewer counts.
func (t *openTabs) latest() (sessions []string, at int64, ok bool) {
	if t == nil {
		return nil, 0, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	var best tabReport
	bestID, bestPresent := "", false
	for v, r := range t.viewers {
		age := now.Sub(time.UnixMilli(r.At))
		if age > tabReportTTL {
			continue
		}
		present := age <= tabPresentFor
		if r.Changed == 0 {
			r.Changed = r.At
		}
		if !ok || betterTabReport(r, v, present, best, bestID, bestPresent) {
			best, bestID, bestPresent, ok = r, v, present, true
		}
	}
	if !ok {
		return nil, 0, false
	}
	return slices.Clone(best.Sessions), best.At, true
}

// betterTabReport orders two viewers for latest: on screen first, then the
// later change, the later report, and the viewer id so the pick never
// depends on map order.
func betterTabReport(r tabReport, id string, present bool, best tabReport, bestID string, bestPresent bool) bool {
	if present != bestPresent {
		return present
	}
	if r.Changed != best.Changed {
		return r.Changed > best.Changed
	}
	if r.At != best.At {
		return r.At > best.At
	}
	return id < bestID
}
