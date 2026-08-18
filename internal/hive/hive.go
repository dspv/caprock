// Package hive owns the on-disk orchestration state (Phase 2): one directory per
// registered project workspace holding agents, tasks, approvals, mailboxes and an
// append-only ledger. Files are the source of truth; SQLite mirrors them for the
// UI and is rebuildable by rescan. The hive is the single git committer — agents
// never run git on it. See .ai/05-orchestration.md.
package hive

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Layout:
//
//	<hive>/
//	  agents/<agent-id>/{identity.md, memory.md, inbox/, outbox/}
//	  tasks/<task-id>.md
//	  approvals/<id>.json
//	  ledger.jsonl
type Hive struct {
	Root string
	mu   sync.Mutex // serializes writes + ledger appends (single writer)
}

// Open creates (if needed) the hive directory structure at root.
func Open(root string) (*Hive, error) {
	for _, d := range []string{"agents", "tasks", "approvals"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, fmt.Errorf("hive: create %s: %w", d, err)
		}
	}
	return &Hive{Root: root}, nil
}

func (h *Hive) agentDir(id string) string { return filepath.Join(h.Root, "agents", id) }
func (h *Hive) taskPath(id string) string { return filepath.Join(h.Root, "tasks", id+".md") }
func (h *Hive) inbox(id string) string    { return filepath.Join(h.agentDir(id), "inbox") }
func (h *Hive) outbox(id string) string   { return filepath.Join(h.agentDir(id), "outbox") }

// RegisterAgent creates an agent's directory tree with identity/memory files.
func (h *Hive) RegisterAgent(id, identity string) error {
	if err := validID(id); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, d := range []string{"inbox", "outbox"} {
		if err := os.MkdirAll(filepath.Join(h.agentDir(id), d), 0o755); err != nil {
			return err
		}
	}
	if err := writeIfAbsent(filepath.Join(h.agentDir(id), "identity.md"), identity); err != nil {
		return err
	}
	if err := writeIfAbsent(filepath.Join(h.agentDir(id), "memory.md"), "# Memory\n"); err != nil {
		return err
	}
	return h.appendLedger(LedgerEntry{Kind: "agent.registered", AgentID: id})
}

// LedgerEntry is one append-only record of a hive state transition.
type LedgerEntry struct {
	Ts      int64  `json:"ts"` // unix ms
	Kind    string `json:"kind"`
	AgentID string `json:"agent_id,omitempty"`
	TaskID  string `json:"task_id,omitempty"`
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
	Note    string `json:"note,omitempty"`
}

// appendLedger appends one entry to ledger.jsonl. Caller holds h.mu.
func (h *Hive) appendLedger(e LedgerEntry) error {
	if e.Ts == 0 {
		e.Ts = time.Now().UnixMilli()
	}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(h.Root, "ledger.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// Ledger reads the full ledger (newest last).
func (h *Hive) Ledger() ([]LedgerEntry, error) {
	b, err := os.ReadFile(filepath.Join(h.Root, "ledger.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []LedgerEntry
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var e LedgerEntry
		if json.Unmarshal([]byte(line), &e) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}

func validID(id string) error {
	if id == "" || strings.ContainsAny(id, `/\:.`) || strings.Contains(id, "..") {
		return fmt.Errorf("hive: invalid id %q", id)
	}
	return nil
}

func writeIfAbsent(path, content string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	return writeAtomic(path, []byte(content), 0o644)
}

// writeAtomic writes via a temp file + rename so a reader never sees a partial file.
func writeAtomic(path string, data []byte, perm os.FileMode) error { //nolint:unparam // perm kept for symmetry with config.WriteFileAtomic
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return err
	}
	_ = tmp.Chmod(perm)
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(path)
		if err2 := os.Rename(name, path); err2 != nil {
			_ = os.Remove(name)
			return err
		}
	}
	return nil
}

func listDir(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}
