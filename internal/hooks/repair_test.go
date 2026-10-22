package hooks

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/config"
)

func exeName(n string) string {
	if runtime.GOOS == "windows" {
		return n + ".exe"
	}
	return n
}

func writeExe(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}

func readBody(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A shim a Homebrew install left in the data dir months ago is replaced by
// the running caprock when no caprock-hook sits beside it (the desktop app),
// and the replacement leaves no temporary file behind.
func TestStaleDataDirShimIsReplacedByTheRunningCaprock(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	self := filepath.Join(data, "bin", exeName("caprock"))
	writeExe(t, self, "caprock 0.147.0")
	shim := config.ShimPath(data)
	writeExe(t, shim, "caprock-hook 0.31.2")

	if err := ensureShimFrom(self, data); err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, shim); got != "caprock 0.147.0" {
		t.Fatalf("shim after refresh: %q", got)
	}
	if fi, err := os.Stat(shim); err != nil || (runtime.GOOS != "windows" && fi.Mode().Perm()&0o100 == 0) {
		t.Fatalf("shim not executable: %v %v", fi, err)
	}
	ents, _ := os.ReadDir(data)
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temporary file left behind: %s", e.Name())
		}
	}
	// Twice is a no-op.
	if err := ensureShimFrom(self, data); err != nil {
		t.Fatal(err)
	}
}

// A sibling caprock-hook (Homebrew, the archives) wins, and is copied in
// whenever its bytes differ from the data-dir one.
func TestSiblingShimIsCopiedWhenItDiffers(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	bin := filepath.Join(dir, "bin")
	self := filepath.Join(bin, exeName("caprock"))
	writeExe(t, self, "caprock new")
	writeExe(t, filepath.Join(bin, filepath.Base(config.ShimPath(data))), "hook new")
	writeExe(t, config.ShimPath(data), "hook old")
	if err := ensureShimFrom(self, data); err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, config.ShimPath(data)); got != "hook new" {
		t.Fatalf("shim: %q", got)
	}
}

// With neither a sibling shim nor a data-dir one, nothing is written: the
// registered command is `<self> hook`. A binary not named caprock (a test or
// a renamed preview build) never stands in for the shim.
func TestNoShimIsCreatedAndOnlyCaprockStandsIn(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	self := filepath.Join(dir, "bin", exeName("caprock"))
	writeExe(t, self, "caprock")
	if err := ensureShimFrom(self, data); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.ShimPath(data)); !os.IsNotExist(err) {
		t.Fatalf("a shim was created: %v", err)
	}
	other := filepath.Join(dir, "bin", exeName("hooks.test"))
	writeExe(t, other, "test binary")
	writeExe(t, config.ShimPath(data), "old shim")
	if err := ensureShimFrom(other, data); err != nil {
		t.Fatal(err)
	}
	if got := readBody(t, config.ShimPath(data)); got != "old shim" {
		t.Fatalf("a test binary replaced the shim: %q", got)
	}
}

func writeSettingsFile(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func fwd(p string) string { return strings.ReplaceAll(p, `\`, "/") }

// The user's case: hooks and statusLine run an uninstalled Homebrew caprock.
// Ours are pointed at this install; the statusLine keeps its flags; a user's
// own hook in the same event is untouched; a second run changes nothing.
func TestRepairPathsPointsOurEntriesAtThisInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	sp := filepath.Join(home, ".claude", "settings.json")
	data := filepath.Join(home, "data")
	shim := config.ShimPath(data)
	writeExe(t, shim, "shim")
	self := filepath.Join(data, "bin", exeName("caprock"))
	writeExe(t, self, "caprock")
	gone := "/opt/homebrew-gone/bin"
	writeSettingsFile(t, sp, `{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "`+gone+`/caprock-hook", "timeout": 5}]},
      {"hooks": [{"type": "command", "command": "afplay done.aiff"}]}
    ]
  },
  "statusLine": {"type": "command", "command": "`+gone+`/caprock statusline --width 100"},
  "model": "opus"
}`)
	slCmd := ShellCommand(self) + " statusline"
	r, err := RepairPaths(sp, shim, slCmd)
	if err != nil {
		t.Fatal(err)
	}
	if r.Hooks != 1 || !r.Statusline {
		t.Fatalf("repaired: %+v", r)
	}
	got := readBody(t, sp)
	for _, want := range []string{
		`"command": "\"` + fwd(shim) + `\""`,
		`"command": "afplay done.aiff"`,
		`"command": "\"` + fwd(self) + `\" statusline --width 100"`,
		`"model": "opus"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("settings lack %s:\n%s", want, got)
		}
	}
	if strings.Contains(got, gone) {
		t.Fatalf("an old path survived:\n%s", got)
	}
	again, err := RepairPaths(sp, shim, slCmd)
	if err != nil || again.Changed() {
		t.Fatalf("second run: %+v %v", again, err)
	}
}

// A stale entry beside a current one is removed, not rewritten, so the
// event does not fire the shim twice.
func TestRepairPathsDropsAStaleDuplicate(t *testing.T) {
	home := t.TempDir()
	sp := filepath.Join(home, ".claude", "settings.json")
	data := filepath.Join(home, "data")
	shim := config.ShimPath(data)
	writeExe(t, shim, "shim")
	cur := ShellCommand(shim)
	writeSettingsFile(t, sp, `{"hooks": {"Stop": [
  {"hooks": [{"type": "command", "command": "/gone/caprock-hook"}]},
  {"hooks": [{"type": "command", "command": `+jsonString(cur)+`}]}
]}}`)
	r, err := RepairPaths(sp, shim, "")
	if err != nil || r.Hooks != 1 {
		t.Fatalf("repaired: %+v %v", r, err)
	}
	got := readBody(t, sp)
	if strings.Count(got, "caprock-hook") != 1 || strings.Contains(got, "/gone/") {
		t.Fatalf("settings:\n%s", got)
	}
}

func jsonString(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// Never touched: a statusLine of the user's own, ours already running this
// binary (by any spelling), and everything when the current binary is
// itself missing. No settings.json is never created.
func TestRepairPathsLeavesWhatIsNotBroken(t *testing.T) {
	home := t.TempDir()
	sp := filepath.Join(home, ".claude", "settings.json")
	data := filepath.Join(home, "data")
	shim := config.ShimPath(data)
	self := filepath.Join(data, "bin", exeName("caprock"))
	slCmd := ShellCommand(self) + " statusline"

	if r, err := RepairPaths(sp, shim, slCmd); err != nil || r.Changed() {
		t.Fatalf("no file: %+v %v", r, err)
	}
	if _, err := os.Stat(sp); !os.IsNotExist(err) {
		t.Fatal("a settings.json was created")
	}

	user := `{"statusLine": {"type": "command", "command": "npx ccusage statusline"}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/gone/caprock-hook"}]}]}}`
	writeSettingsFile(t, sp, user)
	// The current shim and binary do not exist: nothing better to point at.
	if r, err := RepairPaths(sp, shim, slCmd); err != nil || r.Changed() {
		t.Fatalf("missing target: %+v %v", r, err)
	}
	writeExe(t, self, "caprock")
	if r, err := RepairPaths(sp, shim, slCmd); err != nil || r.Statusline {
		t.Fatalf("user statusline touched: %+v %v", r, err)
	}
	if !strings.Contains(readBody(t, sp), "npx ccusage statusline") {
		t.Fatal("user statusline lost")
	}

	// Ours, bare spelling of this very binary: already runs it.
	writeSettingsFile(t, sp, `{"statusLine": {"type": "command", "command": `+jsonString(fwd(self)+" statusline")+`}}`)
	if r, err := RepairPaths(sp, shim, slCmd); err != nil || r.Changed() {
		t.Fatalf("working entry rewritten: %+v %v", r, err)
	}
}
