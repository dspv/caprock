package api

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/bus"
)

// The shell list rides /v1/live: a start sends it at once, a check with
// nothing changed sends nothing, and an exit goes out on the next check.
func TestShellsFrameOnChange(t *testing.T) {
	home := fakeHome(t)
	f := &liveShells{}
	b := bus.New()
	s := New(Deps{Shells: f, Bus: b, DataDir: t.TempDir()})
	sub := b.Subscribe(16)
	defer sub.Unsubscribe()
	next := func() []ShellInfo {
		t.Helper()
		select {
		case fr := <-sub.C:
			if fr.Type != bus.FrameShells {
				t.Fatalf("frame %q", fr.Type)
			}
			raw, _ := json.Marshal(fr.Data)
			var v struct {
				Shells []ShellInfo `json:"shells"`
			}
			if err := json.Unmarshal(raw, &v); err != nil || v.Shells == nil {
				t.Fatalf("shells frame %s: %v", raw, err)
			}
			return v.Shells
		case <-time.After(2 * time.Second):
			t.Fatal("no shells frame")
		}
		return nil
	}
	body := `{"cwd":"` + filepath.ToSlash(home) + `"}`
	if w := call(t, s, machine, "", "POST", "/v1/shells", body); w.Code != 200 {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	if got := next(); len(got) != 1 || got[0].ID != "sh-1" || got[0].Kind != agents.KindShell {
		t.Fatalf("after a start: %+v", got)
	}
	if s.PublishShells() {
		t.Fatal("an unchanged list was sent again")
	}
	f.live = nil
	if !s.PublishShells() {
		t.Fatal("an exit was not sent")
	}
	if got := next(); len(got) != 0 {
		t.Fatalf("after the exit: %+v", got)
	}
}
