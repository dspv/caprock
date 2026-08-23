package hooks

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// settingsWith writes a settings.json containing one user hook, distinguishable
// by the marker string.
func settingsWith(t *testing.T, dir, marker string) string {
	t.Helper()
	p := filepath.Join(dir, "settings.json")
	body := `{"theme":"dark","userMarker":"` + marker + `"}`
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func backupsOf(t *testing.T, p string) []string {
	t.Helper()
	return ListBackups(p)
}

// TestBackupRefreshesWhenTheFileChanged is the regression test for a snapshot
// that could never be updated: backupOnce returned early if *any* backup
// existed, so the first one — possibly months old — was the only one there
// would ever be. On the owner's machine the sole backup was dated 10 July while
// settings.json had been edited on 20 August: a "restore point" that no longer
// resembled the file it was protecting.
//
// Restoring the `if len(matches) > 0 { return "", nil }` early-return makes this
// fail with "the user's edit was never backed up".
func TestBackupRefreshesWhenTheFileChanged(t *testing.T) {
	dir := t.TempDir()
	p := settingsWith(t, dir, "original")

	first, err := backupOnce(p)
	if err != nil {
		t.Fatal(err)
	}
	if first == "" {
		t.Fatal("no backup taken for a pre-existing settings.json")
	}

	// The user edits their settings after Caprock's first run.
	edited := `{"theme":"light","userMarker":"edited-by-the-user"}`
	if err := os.WriteFile(p, []byte(edited), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := backupOnce(p)
	if err != nil {
		t.Fatal(err)
	}
	if second == "" {
		t.Fatal("the user's edit was never backed up: backupOnce refused because an older backup existed")
	}

	// The edited content is now recoverable.
	var foundEdited bool
	for _, b := range backupsOf(t, p) {
		got, err := os.ReadFile(b)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(got), "edited-by-the-user") {
			foundEdited = true
		}
	}
	if !foundEdited {
		t.Error("no backup contains the user's edited settings; the snapshot is stale")
	}
}

// TestBackupDoesNotDuplicateUnchangedContent keeps the property the original
// early-return was there for: repeated runs over an unchanged file must not
// litter the directory with identical snapshots.
func TestBackupDoesNotDuplicateUnchangedContent(t *testing.T) {
	dir := t.TempDir()
	p := settingsWith(t, dir, "original")

	if _, err := backupOnce(p); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		got, err := backupOnce(p)
		if err != nil {
			t.Fatal(err)
		}
		if got != "" {
			t.Errorf("backed up unchanged content again: %s", got)
		}
	}
	if n := len(backupsOf(t, p)); n != 1 {
		t.Errorf("backups = %d; want 1 for an unchanged file", n)
	}
}

// TestBackupPruneKeepsOldestAndNewest proves the retention bound does not throw
// away the pre-Caprock snapshot, which is the one most worth keeping.
func TestBackupPruneKeepsOldestAndNewest(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "settings.json")

	// Fabricate more backups than the cap, with known timestamps, plus the file.
	if err := os.WriteFile(p, []byte(`{"n":"current"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= maxBackups+3; i++ {
		name := p + ".caprock-backup-" + pad(i)
		if err := os.WriteFile(name, []byte(`{"n":`+pad(i)+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	oldest := p + ".caprock-backup-" + pad(1)

	pruneBackups(p)

	got := backupsOf(t, p)
	if len(got) > maxBackups {
		t.Errorf("backups = %d; want at most %d", len(got), maxBackups)
	}
	if _, err := os.Stat(oldest); err != nil {
		t.Errorf("pruned the oldest backup, which is the closest thing to a pre-Caprock state: %v", err)
	}
	// The newest survives too.
	newest := p + ".caprock-backup-" + pad(maxBackups+3)
	if _, err := os.Stat(newest); err != nil {
		t.Errorf("pruned the newest backup: %v", err)
	}
}

// TestRestorePutsTheFileBack proves `caprock hooks restore` actually recovers the
// user's settings, and that restoring is itself undoable.
func TestRestorePutsTheFileBack(t *testing.T) {
	dir := t.TempDir()
	p := settingsWith(t, dir, "the-users-original")

	backup, err := backupOnce(p)
	if err != nil || backup == "" {
		t.Fatalf("no backup: %v", err)
	}
	// Caprock (or anything else) then mangles the file.
	if err := os.WriteFile(p, []byte(`{"theme":"dark","hooks":{"Stop":[]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Restore(p, backup); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "the-users-original") {
		t.Errorf("restore did not bring the user's settings back: %s", got)
	}
	// The pre-restore state was itself snapshotted, so a restore is undoable.
	var foundPreRestore bool
	for _, b := range backupsOf(t, p) {
		if c, err := os.ReadFile(b); err == nil && strings.Contains(string(c), `"Stop"`) {
			foundPreRestore = true
		}
	}
	if !foundPreRestore {
		t.Error("restore overwrote the current file without snapshotting it first; the restore is not undoable")
	}
}

// TestRestoreRefusesUnparsableBackup: a corrupt snapshot must not be written
// over a working settings.json.
func TestRestoreRefusesUnparsableBackup(t *testing.T) {
	dir := t.TempDir()
	p := settingsWith(t, dir, "good")
	bad := p + ".caprock-backup-1"
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Restore(p, bad); err == nil {
		t.Fatal("restored an unparsable backup over a working settings.json")
	}
	got, _ := os.ReadFile(p)
	if !strings.Contains(string(got), "good") {
		t.Errorf("clobbered settings.json with a corrupt backup: %s", got)
	}
}

// pad renders i as a fixed-width timestamp-like suffix so lexical and numeric
// order agree in the fixtures above.
func pad(i int) string {
	s := "000000000" + itoa(i)
	return s[len(s)-10:]
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// TestBackupsInTheSameSecondDoNotCollide: the backup name carries a
// one-second-resolution unix timestamp. Two different contents backed up inside
// the same second must not resolve to the same filename, or the second write
// silently destroys the first snapshot while reporting success.
//
// Removing the freeBackupName disambiguation makes this fail with "the first
// snapshot was overwritten".
func TestBackupsInTheSameSecondDoNotCollide(t *testing.T) {
	dir := t.TempDir()
	p := settingsWith(t, dir, "first-content")

	one, err := backupOnce(p)
	if err != nil || one == "" {
		t.Fatalf("first backup: %v", err)
	}
	// A second distinct edit within the same second.
	if err := os.WriteFile(p, []byte(`{"theme":"x","userMarker":"second-content"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	two, err := backupOnce(p)
	if err != nil || two == "" {
		t.Fatalf("second backup: %v", err)
	}
	if one == two {
		t.Fatalf("both backups used the same filename %s; one overwrote the other", one)
	}
	first, err := os.ReadFile(one)
	if err != nil {
		t.Fatalf("the first snapshot was overwritten: %v", err)
	}
	if !strings.Contains(string(first), "first-content") {
		t.Errorf("the first snapshot was overwritten with later content: %s", first)
	}
	second, _ := os.ReadFile(two)
	if !strings.Contains(string(second), "second-content") {
		t.Errorf("the second snapshot has the wrong content: %s", second)
	}
}
