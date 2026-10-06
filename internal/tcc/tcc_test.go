package tcc

import (
	"path/filepath"
	"testing"
)

func TestOnlyAnIsolatedDaemonOnMacOSIsGuarded(t *testing.T) {
	acct := t.TempDir()
	other := t.TempDir()
	if g := guardedFor("darwin", acct, acct); g != nil {
		t.Fatalf("the user's own daemon is never limited, got %v", g)
	}
	if g := guardedFor("linux", other, acct); g != nil {
		t.Fatalf("only macOS asks, got %v", g)
	}
	if g := guardedFor("darwin", "", acct); g != nil {
		t.Fatalf("no HOME is not isolation, got %v", g)
	}
	g := guardedFor("darwin", other, acct)
	if len(g) != len(Folders) {
		t.Fatalf("an isolated daemon guards %v, got %v", Folders, g)
	}
}

func TestOffLimitsCoversTheFoldersAndWhatIsUnderThem(t *testing.T) {
	acct := t.TempDir()
	g := guardedFor("darwin", t.TempDir(), acct)
	root := resolve(acct)
	for _, p := range []string{
		filepath.Join(root, "Documents"),
		filepath.Join(root, "Documents", "repo"),
		filepath.Join(root, "Desktop", "a", "b"),
		filepath.Join(root, "Downloads", "x.png"),
	} {
		if !offLimits(g, p) {
			t.Errorf("%s should be off limits", p)
		}
	}
	for _, p := range []string{
		filepath.Join(root, "dev", "repo"),
		filepath.Join(root, "DocumentsArchive"),
		filepath.Join(root, "Library", "Application Support", "caprock"),
		"Documents/relative",
		"",
	} {
		if offLimits(g, p) {
			t.Errorf("%s should not be off limits", p)
		}
	}
	if offLimits(nil, filepath.Join(root, "Documents")) {
		t.Error("an unguarded daemon touches everything")
	}
}
