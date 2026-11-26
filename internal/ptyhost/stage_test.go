package ptyhost

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeBundle lays out a helper bundle in dir, its executable saying v.
func fakeBundle(t *testing.T, dir, v string) string {
	t.Helper()
	b := filepath.Join(dir, HelperBundle)
	macos := filepath.Join(b, "Contents", "MacOS")
	if err := os.MkdirAll(filepath.Join(b, "Contents", "_CodeSignature"), 0o755); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	if err := os.MkdirAll(macos, 0o755); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b, "Contents", "Info.plist"), []byte("<plist "+v+"/>"), 0o644); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b, "Contents", "_CodeSignature", "CodeResources"), []byte("seal "+v), 0o644); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(macos, BinaryName()), []byte("holder "+v), 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}
	return b
}

// An update must never touch the copy a running holder was started from:
// each version of the helper gets a copy of its own, named by its contents,
// and an unchanged helper reuses its copy.
func TestStageBundleGivesEachVersionItsOwnCopy(t *testing.T) {
	src, bin := t.TempDir(), t.TempDir()
	b := fakeBundle(t, src, "v1")

	d1, err := stageBundle(b, bin)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(HelperExe(d1)); string(got) != "holder v1" {
		t.Fatalf("staged executable says %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(d1, HelperBundle, "Contents", "_CodeSignature", "CodeResources")); string(got) != "seal v1" {
		t.Fatalf("the signature's seal did not come along: %q", got)
	}
	if !executable(HelperExe(d1)) {
		t.Fatal("the staged helper is not executable")
	}
	before, err := os.Stat(HelperExe(d1))
	if err != nil {
		t.Fatal(err)
	}

	again, err := stageBundle(b, bin)
	if err != nil || again != d1 {
		t.Fatalf("an unchanged helper staged at %q (%v), want its copy %q", again, err, d1)
	}
	after, _ := os.Stat(HelperExe(d1))
	if !os.SameFile(before, after) {
		t.Fatal("an unchanged helper was copied again")
	}

	// The next release replaces the installed bundle; the old copy stays
	// exactly as it was.
	if err := os.RemoveAll(b); err != nil {
		t.Fatal(err)
	}
	b = fakeBundle(t, src, "v2")
	d2, err := stageBundle(b, bin)
	if err != nil {
		t.Fatal(err)
	}
	if d2 == d1 {
		t.Fatal("a changed helper reused the old copy")
	}
	if got, _ := os.ReadFile(HelperExe(d2)); string(got) != "holder v2" {
		t.Fatalf("new copy says %q", got)
	}
	still, err := os.Stat(HelperExe(d1))
	if err != nil || !os.SameFile(before, still) {
		t.Fatalf("the copy a running holder uses was touched: %v", err)
	}
	if n := leftovers(t, bin); n != 0 {
		t.Fatalf("%d temporary copies left behind", n)
	}
}

// A copy that went wrong (no executable in it) is made again.
func TestStageBundleRedoesABrokenCopy(t *testing.T) {
	src, bin := t.TempDir(), t.TempDir()
	b := fakeBundle(t, src, "v1")
	d, err := stageBundle(b, bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(HelperExe(d)); err != nil {
		t.Fatal(err)
	}
	d2, err := stageBundle(b, bin)
	if err != nil || d2 != d || !executable(HelperExe(d)) {
		t.Fatalf("broken copy not redone: %q %v", d2, err)
	}
}

func TestTreeHashFollowsContentsAndModes(t *testing.T) {
	a, b := fakeBundle(t, t.TempDir(), "v1"), fakeBundle(t, t.TempDir(), "v1")
	ha, err := treeHash(a)
	if err != nil {
		t.Fatal(err)
	}
	hb, _ := treeHash(b)
	if ha != hb || len(ha) != 16 {
		t.Fatalf("identical bundles hash %q and %q", ha, hb)
	}
	if err := os.WriteFile(filepath.Join(b, "Contents", "Info.plist"), []byte("<plist v2/>"), 0o644); err != nil { //nolint:gosec // a test bundle
		t.Fatal(err)
	}
	if hb, _ = treeHash(b); hb == ha {
		t.Fatal("a changed file did not change the hash")
	}
	if runtime.GOOS != "windows" {
		c := fakeBundle(t, t.TempDir(), "v1")
		if err := os.Chmod(filepath.Join(c, "Contents", "Info.plist"), 0o600); err != nil {
			t.Fatal(err)
		}
		if hc, _ := treeHash(c); hc == ha {
			t.Fatal("a changed mode did not change the hash")
		}
	}
}

func TestCopyTreeKeepsModesAndLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the helper is a macOS bundle; links and exec bits are Unix's")
	}
	src := fakeBundle(t, t.TempDir(), "v1")
	if err := os.Symlink("MacOS/"+BinaryName(), filepath.Join(src, "Contents", "link")); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), HelperBundle)
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(filepath.Join(dst, "Contents", "link")); err != nil || got != "MacOS/"+BinaryName() {
		t.Fatalf("link copied as %q (%v)", got, err)
	}
	fi, err := os.Stat(filepath.Join(dst, "Contents", "MacOS", BinaryName()))
	if err != nil || fi.Mode().Perm() != 0o755 {
		t.Fatalf("executable copied with mode %v (%v)", fi.Mode(), err)
	}
	hs, _ := treeHash(src)
	hd, _ := treeHash(dst)
	if hs != hd {
		t.Fatal("the copy differs from the bundle")
	}
}

// Only copies no holder runs from go; the newest always stays, and so does
// anything that is not a staged copy (the Windows holder copies live here).
func TestPruneStagedKeepsWhatRuns(t *testing.T) {
	bin := t.TempDir()
	mk := func(name string) string {
		d := filepath.Join(bin, name)
		fakeBundle(t, d, name)
		return d
	}
	current := mk(stagedPrefix + "cccccccccccccccc")
	running := mk(stagedPrefix + "rrrrrrrrrrrrrrrr")
	idle := mk(stagedPrefix + "iiiiiiiiiiiiiiii")
	half := mk("." + stagedPrefix + "hhhhhhhhhhhhhhhh.tmp")
	other := filepath.Join(bin, "caprock-pty-host-0123456789abcdef.exe")
	if err := os.WriteFile(other, []byte("x"), 0o755); err != nil { //nolint:gosec // a test executable
		t.Fatal(err)
	}

	pruneStaged(bin, filepath.Base(current), []string{HelperExe(running), "/usr/bin/somewhere-else"})

	for _, keep := range []string{current, running, other} {
		if _, err := os.Stat(keep); err != nil {
			t.Errorf("%s was deleted: %v", filepath.Base(keep), err)
		}
	}
	for _, gone := range []string{idle, half} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s was kept", filepath.Base(gone))
		}
	}
}

// A helper running from a copy with a similar name does not keep another.
func TestRunsFromMatchesWholeDirectories(t *testing.T) {
	bin := t.TempDir()
	a := filepath.Join(bin, stagedPrefix+"aaaa")
	if runsFrom([]string{HelperExe(a + "bb")}, a) {
		t.Fatal("helper-aaaabb kept helper-aaaa")
	}
	if !runsFrom([]string{HelperExe(a)}, a) {
		t.Fatal("helper-aaaa's own holder did not keep it")
	}
}

// Off the helper nothing is staged: Homebrew, development builds, Windows
// and Linux start holders as before.
func TestStageHelperLeavesOtherHoldersAlone(t *testing.T) {
	data := t.TempDir()
	for _, exe := range []string{filepath.Join(t.TempDir(), BinaryName()), ""} {
		if got := StageHelper(exe, data); got != exe {
			t.Errorf("StageHelper(%q) = %q, want it unchanged", exe, got)
		}
	}
	if _, err := os.Stat(stagedDir(data)); !os.IsNotExist(err) {
		t.Error("a holder that is not the helper left a staging directory")
	}
	if StagedHelperDirs(data) != nil {
		t.Error("staged copies listed where none were made")
	}
	m := &Manager{Exe: filepath.Join(t.TempDir(), BinaryName()), DataDir: data}
	m.HolderExited()
	if m.pruneTimer != nil {
		t.Error("a plain holder's exit scheduled a prune")
	}
}

func leftovers(t *testing.T, bin string) int {
	t.Helper()
	entries, err := os.ReadDir(bin)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if e.Name()[0] == '.' {
			n++
		}
	}
	return n
}
