//go:build smoke

package smoke

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// ADR-085, end to end on every OS: the Compact button's POST reaches a
// session Caprock started through its terminal, and what it types is a
// submitted /compact — the fake reads a whole line ending in Enter and
// echoes it (an ESC CR would have stayed in its prompt as ↵).
func TestCompactTypesASubmittedSlashCompact(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	home := filepath.Join(root, "home")
	data := filepath.Join(root, "data")
	proj := filepath.Join(root, "proj")
	for _, d := range []string{bin, home, data, proj} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	caprock := filepath.Join(bin, "caprock"+exe)
	goBuild(t, caprock, "./cmd/caprock")
	goBuild(t, filepath.Join(bin, "claude"+exe), "./testdata/fakeclaude")
	t.Cleanup(func() {
		killHolders(t, data)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})
	port := freePort(t)
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	d := startBinary(t, caprock, daemonEnv(bin, home, data), port, data, "compact")
	id := spawnOwned(t, base, proj)
	term := attachTerm(t, base, id)
	defer term.close()
	term.waitFor(t, "fake-claude ready")

	var res struct {
		Sent bool `json:"sent"`
	}
	if err := json.Unmarshal(post(t, base+"/v1/agents/"+id+"/compact", ``), &res); err != nil || !res.Sent {
		t.Fatalf("compact: %+v %v\ndaemon log:\n%s", res, err, d.log())
	}
	term.waitFor(t, "you-said:/compact")
}
