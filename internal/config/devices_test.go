// devices.json is the guest list for LAN access: the set of tablets and phones
// allowed to read this machine's figures, and the bearer tokens they present.
// Nothing else in the product persists a credential someone else holds, so the
// failure modes here are the ones worth pinning down — a lost round trip sends
// the user walking back to their tablet to re-pair, and a permission slip hands
// the tokens to every account on the machine.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/dspv/caprock/internal/pairing"
)

func TestDevicesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	// Every field a paired device carries, because the token is what the guest
	// list exists for and the name is the only thing that lets a user tell one
	// row from another when they revoke.
	want := []pairing.Device{
		{ID: "dev-1", Name: "kitchen tablet", Token: "tok-1", PairedAt: 1_700_000_000_000, LastSeen: 1_700_000_500_000},
		{ID: "dev-2", Name: "phone", Token: "tok-2", PairedAt: 1_700_000_100_000},
	}
	if err := WriteDevices(dir, want); err != nil {
		t.Fatalf("WriteDevices: %v", err)
	}
	got, err := ReadDevices(dir)
	if err != nil {
		t.Fatalf("ReadDevices: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("read back %d devices; want %d", len(got), len(want))
	}
	for i := range want {
		if got[i].ID != want[i].ID || got[i].Name != want[i].Name {
			t.Errorf("device %d = %+v; want %+v", i, got[i], want[i])
		}
		if got[i].Token != want[i].Token {
			t.Errorf("device %d lost its token; the device would be silently locked out after a restart", i)
		}
		if got[i].PairedAt != want[i].PairedAt || got[i].LastSeen != want[i].LastSeen {
			t.Errorf("device %d timestamps = %d/%d; want %d/%d", i, got[i].PairedAt, got[i].LastSeen, want[i].PairedAt, want[i].LastSeen)
		}
	}
}

// First run has no devices.json, and that is the normal case — not an error the
// daemon should report or refuse to start on.
func TestReadDevicesOnAFreshMachineIsEmptyNotAnError(t *testing.T) {
	got, err := ReadDevices(t.TempDir())
	if err != nil {
		t.Fatalf("a missing guest list is the first-run case; got error %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d devices from an empty data dir; want none", len(got))
	}
}

// The file holds bearer tokens. If it were written world readable, every other
// account on the machine could take a token and read the dashboard — the same
// reasoning that puts runtime.json and the licence key at 0600.
func TestWriteDevicesIsNotWorldReadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits")
	}
	dir := t.TempDir()
	if err := WriteDevices(dir, []pairing.Device{{ID: "a", Token: "secret"}}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, devicesFile))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o; want 0600 — this file is a list of bearer tokens", perm)
	}
}

// Revoking the last device must leave nothing behind that a later read could
// resurrect. Writing an empty list rather than deleting the file is the path
// RevokeAll takes, so the empty list has to read back as empty.
func TestWriteDevicesEmptyListClearsTheGuestList(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDevices(dir, []pairing.Device{{ID: "a", Token: "t"}}); err != nil {
		t.Fatal(err)
	}
	if err := WriteDevices(dir, nil); err != nil {
		t.Fatalf("WriteDevices(nil): %v", err)
	}
	got, err := ReadDevices(dir)
	if err != nil {
		t.Fatalf("ReadDevices after clearing: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("a revoked device came back: %+v", got)
	}
}

// A truncated or hand-edited file must be reported rather than silently read as
// "nobody is paired": the daemon logs it and the user re-pairs, which is a
// visible cost. Returning nil,nil here would look identical to a fresh machine.
func TestReadDevicesReportsACorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, devicesFile), []byte(`[{"id":"a"`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadDevices(dir)
	if err == nil {
		t.Fatal("a corrupt guest list was read without error; a torn file must not pass as a valid empty list")
	}
	if got != nil {
		t.Errorf("got %+v alongside the error; want no devices", got)
	}
}

// RemoveDevices is what `caprock reset` and a full revoke run. Removing an
// absent file is the second-run case and must not error, exactly like
// RemoveRuntime.
func TestRemoveDevicesIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDevices(dir, []pairing.Device{{ID: "a", Token: "t"}}); err != nil {
		t.Fatal(err)
	}
	if err := RemoveDevices(dir); err != nil {
		t.Fatalf("RemoveDevices: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, devicesFile)); !os.IsNotExist(err) {
		t.Errorf("devices.json still on disk after RemoveDevices (stat err = %v)", err)
	}
	if err := RemoveDevices(dir); err != nil {
		t.Errorf("second RemoveDevices = %v; want nil — a missing file is not a failure", err)
	}
	got, err := ReadDevices(dir)
	if err != nil || len(got) != 0 {
		t.Errorf("after removal ReadDevices = %+v, %v; want no devices and no error", got, err)
	}
}

// The whole file is a set of keys, and it is meant to be readable at a glance as
// exactly that — a JSON array, indented, not a single line. Support threads ask
// people to look at this file.
func TestDevicesFileIsAReadableJSONArray(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDevices(dir, []pairing.Device{{ID: "a", Name: "tablet", Token: "t"}}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, devicesFile))
	if err != nil {
		t.Fatal(err)
	}
	var arr []map[string]any
	if err := json.Unmarshal(b, &arr); err != nil {
		t.Fatalf("devices.json is not a JSON array: %v\n%s", err, b)
	}
	if len(arr) != 1 {
		t.Fatalf("got %d entries; want 1", len(arr))
	}
}

// Chats and pasted files live under the data dir rather than a second dot
// directory, so there is one place to back up and one place to clear out. A
// refactor that moved either to $HOME would be invisible until a user went
// looking for a screenshot they dropped in.
func TestStateDirectoriesStayUnderTheDataDir(t *testing.T) {
	dir := filepath.Join("base", "caprock")
	for name, got := range map[string]string{
		"ChatsDir": ChatsDir(dir),
		"PasteDir": PasteDir(dir),
	} {
		if filepath.Dir(got) != dir {
			t.Errorf("%s = %q; want it directly under the data dir %q", name, got, dir)
		}
	}
	if ChatsDir(dir) == PasteDir(dir) {
		t.Error("chats and pasted files share a directory; a chat is a project row and a paste is a scratch file")
	}
}
