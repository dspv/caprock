package mail

import (
	"encoding/json"
	"runtime"
	"testing"
)

// The Full Disk Access button opens the settings pane and shows the daemon's
// own file; on other systems the route says there is no such setting. The
// real opener is replaced: a test never raises an OS window.
func TestImportGrantOpensFullDiskAccess(t *testing.T) {
	var got []string
	old := openGrant
	openGrant = func(program string) error { got = append(got, program); return nil }
	t.Cleanup(func() { openGrant = old })

	s := newTestService(t)
	w := do(t, s.Handler(), "POST", "/v1/mail/import/grant", nil)
	if runtime.GOOS != "darwin" {
		if w.Code != 404 || len(got) != 0 {
			t.Fatalf("off macOS: want 404 and nothing opened, got %d %v", w.Code, got)
		}
		return
	}
	if w.Code != 200 {
		t.Fatalf("grant: %d %s", w.Code, w.Body)
	}
	var out struct{ Program string }
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] == "" || got[0] != out.Program || out.Program != daemonProgram() {
		t.Fatalf("want the daemon's executable revealed once, got %v answer %q", got, out.Program)
	}
}
