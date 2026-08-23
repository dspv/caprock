package agents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMain points the home directory and Caprock's data dir at throwaway
// locations for the whole package before any test runs. Spawn calls trustFolder,
// which writes ~/.claude.json and the grant ledger, so a test that merely spawns
// — without touching trust deliberately — would otherwise write into the real
// files of whoever runs the suite. Making it the package default means a new
// test cannot forget; trustTestHome still gives an individual test its own pair.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "caprock-agents-home")
	if err != nil {
		panic(err)
	}
	data, err := os.MkdirTemp("", "caprock-agents-data")
	if err != nil {
		panic(err)
	}
	userHomeDir = func() (string, error) { return home, nil }
	dataDir = func() (string, error) { return data, nil }
	code := m.Run()
	_ = os.RemoveAll(home)
	_ = os.RemoveAll(data)
	os.Exit(code)
}

// trustTestHome redirects both the home directory and Caprock's data dir at
// temp locations. Every test that touches trust state must call it: without the
// data-dir redirect the grant ledger would be written into the real
// ~/Library/Application Support/caprock (or its equivalent) on the machine
// running the tests.
func trustTestHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	data := t.TempDir()
	origHome, origData := userHomeDir, dataDir
	userHomeDir = func() (string, error) { return home, nil }
	dataDir = func() (string, error) { return data, nil }
	t.Cleanup(func() { userHomeDir, dataDir = origHome, origData })
	return home
}

func TestTrustFolderPreacceptsAndPreserves(t *testing.T) {
	home := trustTestHome(t)
	// A pre-existing config with unrelated keys must survive untouched.
	cfg := filepath.Join(home, ".claude.json")
	orig := map[string]any{
		"someTopLevel": "keep-me",
		"projects": map[string]any{
			"/other": map[string]any{"hasTrustDialogAccepted": true, "note": "x"},
		},
	}
	b, _ := json.Marshal(orig)
	if err := os.WriteFile(cfg, b, 0o600); err != nil {
		t.Fatal(err)
	}

	dir := "/Users/x/repo"
	if err := trustFolder(dir); err != nil {
		t.Fatal(err)
	}

	var got map[string]any
	raw, _ := os.ReadFile(cfg)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got["someTopLevel"] != "keep-me" {
		t.Fatalf("unrelated top-level key lost: %v", got["someTopLevel"])
	}
	projects := got["projects"].(map[string]any)
	if _, ok := projects["/other"]; !ok {
		t.Fatal("unrelated project entry lost")
	}
	entry, ok := projects[dir].(map[string]any)
	if !ok || entry["hasTrustDialogAccepted"] != true {
		t.Fatalf("folder not trusted: %v", projects[dir])
	}
}

func TestTrustFolderCreatesConfig(t *testing.T) {
	home := trustTestHome(t)
	if err := trustFolder("/repo"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	entry := got["projects"].(map[string]any)["/repo"].(map[string]any)
	if entry["hasTrustDialogAccepted"] != true {
		t.Fatalf("not trusted: %v", entry)
	}
}

func TestTrustFolderRefusesUnparsableConfig(t *testing.T) {
	home := trustTestHome(t)
	cfg := filepath.Join(home, ".claude.json")
	_ = os.WriteFile(cfg, []byte("{not json"), 0o600)
	if err := trustFolder("/repo"); err == nil {
		t.Fatal("should refuse to overwrite an unparsable config")
	}
	// The bad file is left as-is, not clobbered.
	raw, _ := os.ReadFile(cfg)
	if string(raw) != "{not json" {
		t.Fatalf("clobbered unparsable config: %q", raw)
	}
}

// TestTrustFolderPreservesKeyOrderAndBigInts is the regression test for the
// map[string]any round-trip: ~/.claude.json is the user's file (200KB+, hundreds
// of projects) and Go sorts map keys on marshal, so every write reordered the
// whole file, and any integer past 2^53 was truncated through float64.
//
// Reverting trustFolder to encoding/json with map[string]any makes this fail
// with "key order destroyed" and "integer corrupted".
func TestTrustFolderPreservesKeyOrderAndBigInts(t *testing.T) {
	home := trustTestHome(t)
	cfg := filepath.Join(home, ".claude.json")
	// Keys deliberately not in alphabetical order, so sorting is detectable.
	const in = `{"zeta":1,"alpha":2,"bigint":9007199254740993,"projects":{"/other":{"hasTrustDialogAccepted":true}},"middle":"m"}`
	if err := os.WriteFile(cfg, []byte(in), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := trustFolder("/repo"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	out := string(raw)

	// Key order is preserved exactly as the user had it.
	want := []string{"zeta", "alpha", "bigint", "projects", "middle"}
	var idx []int
	for _, k := range want {
		i := strings.Index(out, `"`+k+`"`)
		if i < 0 {
			t.Fatalf("key %q lost from the config entirely:\n%s", k, out)
		}
		idx = append(idx, i)
	}
	for i := 1; i < len(idx); i++ {
		if idx[i] < idx[i-1] {
			t.Errorf("key order destroyed: %q now precedes %q\n%s", want[i], want[i-1], out)
			break
		}
	}
	// A large integer survives byte-for-byte rather than going through float64.
	if !strings.Contains(out, "9007199254740993") {
		t.Errorf("integer corrupted by a float64 round-trip; want 9007199254740993 in:\n%s", out)
	}
}

// TestRevokeTrustGrantsRemovesOnlyOurs proves uninstall can undo what Caprock
// granted and nothing else. Deleting the recordTrustGrant call makes this fail
// with "revoked = 0"; making RevokeTrustGrants iterate all projects instead of
// the ledger makes it fail with "revoked a grant Caprock did not create".
func TestRevokeTrustGrantsRemovesOnlyOurs(t *testing.T) {
	home := trustTestHome(t)
	cfg := filepath.Join(home, ".claude.json")
	// The user trusted /user-own themselves, and has settings on /mixed.
	const in = `{"projects":{` +
		`"/user-own":{"hasTrustDialogAccepted":true},` +
		`"/mixed":{"someUserSetting":"keep"}` +
		`}}`
	if err := os.WriteFile(cfg, []byte(in), 0o600); err != nil {
		t.Fatal(err)
	}
	// Caprock grants two: one fresh, one onto an entry the user already owns.
	if err := trustFolder("/caprock-worktree"); err != nil {
		t.Fatal(err)
	}
	if err := trustFolder("/mixed"); err != nil {
		t.Fatal(err)
	}
	if n := TrustGrantCount(); n != 2 {
		t.Fatalf("TrustGrantCount = %d; want 2 recorded grants", n)
	}

	revoked, err := RevokeTrustGrants()
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 2 {
		t.Errorf("revoked = %d; want 2", revoked)
	}

	raw, _ := os.ReadFile(cfg)
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	projects := got["projects"].(map[string]any)

	// The user's own grant is untouched — undoing a human's decision is not
	// uninstall's job.
	own, ok := projects["/user-own"].(map[string]any)
	if !ok || own["hasTrustDialogAccepted"] != true {
		t.Errorf("revoked a grant Caprock did not create: /user-own is now %v", projects["/user-own"])
	}
	// Ours is gone, and the entry that held nothing else went with it.
	if _, present := projects["/caprock-worktree"]; present {
		t.Errorf("Caprock's own grant survived revocation: %v", projects["/caprock-worktree"])
	}
	// The mixed entry keeps the user's setting but loses only our field.
	mixed, ok := projects["/mixed"].(map[string]any)
	if !ok {
		t.Fatalf("removed an entry carrying the user's own settings: %v", projects["/mixed"])
	}
	if mixed["someUserSetting"] != "keep" {
		t.Errorf("user setting lost from a mixed entry: %v", mixed)
	}
	if _, present := mixed["hasTrustDialogAccepted"]; present {
		t.Errorf("our grant survived on the mixed entry: %v", mixed)
	}
	// The ledger is cleared, so a second uninstall is a no-op.
	if n := TrustGrantCount(); n != 0 {
		t.Errorf("ledger not cleared after revoke: %d remain", n)
	}
}

// TestTrustFolderDoesNotClaimPreexistingGrants proves Caprock never records a
// grant for a folder the user had already trusted — otherwise uninstall would
// revoke the user's own decision.
func TestTrustFolderDoesNotClaimPreexistingGrants(t *testing.T) {
	home := trustTestHome(t)
	cfg := filepath.Join(home, ".claude.json")
	const in = `{"projects":{"/already":{"hasTrustDialogAccepted":true}}}`
	if err := os.WriteFile(cfg, []byte(in), 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cfg)
	if err := trustFolder("/already"); err != nil {
		t.Fatal(err)
	}
	if n := TrustGrantCount(); n != 0 {
		t.Errorf("claimed a grant the user had already made: %d recorded", n)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Errorf("rewrote a config that needed no change:\n before=%s\n after=%s", before, after)
	}
}
