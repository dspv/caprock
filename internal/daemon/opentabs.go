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

// openTabsFile is the file under the data directory.
const openTabsFile = "open-tabs.json"

// tabReportTTL is how long a viewer's last list counts without a new one.
const tabReportTTL = 7 * 24 * time.Hour

type tabReport struct {
	// At is when the viewer last reported, unix ms.
	At       int64    `json:"at"`
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
	t.viewers[viewer] = tabReport{At: now.UnixMilli(), Sessions: slices.Clone(sessions)}
	for v, r := range t.viewers {
		if now.Sub(time.UnixMilli(r.At)) > tabReportTTL {
			delete(t.viewers, v)
		}
	}
	// Only a changed list, or a stale one, is written: the heartbeat that
	// repeats the same list every few minutes need not touch the disk each
	// time.
	if had && slices.Equal(old.Sessions, sessions) && now.Sub(time.UnixMilli(old.At)) < time.Hour {
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
