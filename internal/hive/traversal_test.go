package hive

import (
	"os"
	"path/filepath"
	"testing"
)

// The tests here demonstrate attacks, not merely that a guard function is
// reachable: each one asserts on the file system outside the hive root, so
// removing the guard makes them fail with evidence of the write or read.
//
// Threat model: the author of an outbox file or a hand-written task file is a
// worker Claude session running with --dangerously-skip-permissions. It is the
// designed writer of these files, so no external attacker is required — a
// confused or prompt-injected worker is enough.

// writeOutbox drops a raw message file into an agent's outbox, the way a worker
// session writes one. It deliberately bypasses Send, which validates.
func writeOutbox(t *testing.T, root, agent, name, to string) {
	t.Helper()
	body := "---\nfrom: " + agent + "\nto: " + to + "\nts: 1\nkind: result\n---\nowned\n"
	path := filepath.Join(root, "agents", agent, "outbox", name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestDeliverRefusesTraversalInTo proves a message cannot write outside the hive
// root. Removing the validID(m.To) guard in Deliver makes this fail with
// "escaped the hive root: <path>".
func TestDeliverRefusesTraversalInTo(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "nested", "hive")
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterAgent("worker-1", "id"); err != nil {
		t.Fatal(err)
	}

	// inbox(to) is <root>/agents/<to>/inbox, so two levels of ".." reach base.
	for i, to := range []string{
		"../../escape",
		"../../../escape-higher",
		"..",
		".",
	} {
		name := "1-result-worker-1.md"
		writeOutbox(t, root, "worker-1", name, to)

		if _, err := h.Deliver(); err != nil {
			t.Fatalf("case %d (%q): Deliver returned an error; one bad message must be skipped, not fail the pass: %v", i, to, err)
		}
		// The malicious message must not still be sitting in the outbox, or every
		// later Deliver retries it forever.
		if _, err := os.Stat(filepath.Join(root, "agents", "worker-1", "outbox", name)); err == nil {
			t.Errorf("case %d (%q): rejected message left in the outbox", i, to)
		}
	}

	// Nothing may exist outside the hive root.
	if err := filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // a walk error must not mask the assertion below
		}
		if rel, rerr := filepath.Rel(root, p); rerr != nil || rel == ".." || filepath.IsAbs(rel) ||
			(len(rel) >= 3 && rel[:3] == ".."+string(os.PathSeparator)) {
			t.Errorf("escaped the hive root: %s", p)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// TestDeliverQuarantinesRatherThanDropping proves a refused message is preserved
// as evidence and ledgered, and that it does not block delivery of good mail.
func TestDeliverQuarantinesRatherThanDropping(t *testing.T) {
	root := t.TempDir()
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{"worker-1", "orchestrator"} {
		if err := h.RegisterAgent(a, "id"); err != nil {
			t.Fatal(err)
		}
	}
	writeOutbox(t, root, "worker-1", "1-result-worker-1.md", "../../escape")
	writeOutbox(t, root, "worker-1", "2-result-worker-1.md", "orchestrator")

	n, err := h.Deliver()
	if err != nil {
		t.Fatal(err)
	}
	// The good message still gets through — one poisoned file must not wedge the
	// whole mailbox.
	if n != 1 {
		t.Errorf("delivered = %d; want 1 (the legitimate message)", n)
	}
	if _, err := os.Stat(filepath.Join(root, "agents", "orchestrator", "inbox", "2-result-worker-1.md")); err != nil {
		t.Errorf("legitimate message was not delivered: %v", err)
	}
	// The bad one is kept for inspection, not deleted.
	if _, err := os.Stat(filepath.Join(root, "agents", "worker-1", "rejected", "1-result-worker-1.md")); err != nil {
		t.Errorf("rejected message was not quarantined: %v", err)
	}
	entries, err := h.Ledger()
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range entries {
		if e.Kind == "mail.rejected" {
			found = true
		}
	}
	if !found {
		t.Error("no mail.rejected ledger entry; a refused delivery must leave a record")
	}
}

// TestGetTaskRefusesTraversal proves a task id cannot read a file outside the
// hive. Removing the validID guard in GetTask makes this fail with the secret's
// title in the message.
func TestGetTaskRefusesTraversal(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "hive")
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	// taskPath is <root>/tasks/<id>.md, so "../../secret" lands on base/secret.md.
	secret := filepath.Join(base, "secret.md")
	if err := os.WriteFile(secret, []byte("---\nid: s\ntitle: TOPSECRET\nstatus: inbox\n---\nx\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../../secret", "../..", "..\\..\\secret"} {
		got, err := h.GetTask(id)
		if err == nil {
			t.Errorf("GetTask(%q) succeeded and read outside the hive: title=%q", id, got.Title)
		}
	}
}

// TestUpdateTaskRefusesTraversal proves the write side too: ListTasks reads the
// `id` from *inside* a task file, so a hand-written id is a write primitive on
// the next update. Removing the validID guard in UpdateTask makes this fail
// with "wrote outside the hive".
func TestUpdateTaskRefusesTraversal(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "hive")
	h, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(base, "victim.md")
	const original = "---\nid: v\ntitle: user data\nstatus: inbox\n---\nDO NOT CLOBBER\n"
	if err := os.WriteFile(victim, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.UpdateTask("../../victim", func(x *Task) error {
		x.Title = "owned"
		return nil
	}); err == nil {
		t.Error("UpdateTask accepted a traversing id")
	}
	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != original {
		t.Errorf("wrote outside the hive: victim file was modified to %q", got)
	}
}
