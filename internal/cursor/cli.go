package cursor

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The CLI keeps each chat in its own SQLite file,
// <config dir>/chats/<md5 of the folder>/<chat id>/store.db, with two
// tables (cursor-agent 2025.09.12's bundled source, read 2026-11-16):
//
//   - `meta`: one row, key "0", whose value is the hex of a JSON object —
//     agentId, latestRootBlobId, name, createdAt, mode, lastUsedModel.
//   - `blobs`: the conversation itself, as content-addressed protobuf
//     messages keyed by their SHA-256, with no schema shipped beside them.
//
// Caprock reads the meta row — enough to know a chat exists, what it is
// called and which model it last ran on — and not the blobs: reading an
// undocumented protobuf by guesswork is how a reader starts telling
// confident lies. A CLI chat's turns come from Cursor's hooks instead
// (hooks.go), and no token count reaches Caprock for it.

// ChatMeta is a CLI chat's meta row.
type ChatMeta struct {
	ID        string    `json:"agentId"`
	Name      string    `json:"name"`
	Mode      string    `json:"mode"`
	Model     string    `json:"lastUsedModel"`
	CreatedMs float64   `json:"createdAt"`
	Created   time.Time `json:"-"`
	// FolderHash is the md5 directory the chat sits under.
	FolderHash string `json:"-"`
}

// ChatExists reports whether cursor-agent has a chat with this id for the
// folder, which is what `cursor-agent --resume <id>` started there needs.
func ChatExists(cwd, id string) bool {
	d := ChatDir(cwd, id)
	if d == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(d, "store.db"))
	return err == nil && !fi.IsDir()
}

// ReadChatMeta reads one store.db's meta row, read-only.
func ReadChatMeta(ctx context.Context, path string) (ChatMeta, error) {
	db, err := open(path, 500)
	if err != nil {
		return ChatMeta{}, err
	}
	defer db.Close()
	var raw sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = '0'`).Scan(&raw); err != nil {
		return ChatMeta{}, err
	}
	m, err := decodeMeta(raw.String)
	if err != nil {
		return ChatMeta{}, err
	}
	m.FolderHash = filepath.Base(filepath.Dir(filepath.Dir(path)))
	if m.ID == "" {
		m.ID = filepath.Base(filepath.Dir(path))
	}
	return m, nil
}

// decodeMeta reads the meta value: hex of a UTF-8 JSON object, or the JSON
// itself should a later CLI stop hex-encoding it.
func decodeMeta(v string) (ChatMeta, error) {
	var m ChatMeta
	b := []byte(strings.TrimSpace(v))
	if dec, err := hex.DecodeString(string(b)); err == nil {
		b = dec
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return ChatMeta{}, err
	}
	m.Created = millis(m.CreatedMs)
	return m, nil
}

// CLIChats lists the CLI's chats, newest first, at most limit of them. A
// chat whose meta cannot be read is skipped.
func CLIChats(ctx context.Context, configDir string, limit int) []ChatMeta {
	if configDir == "" {
		return nil
	}
	paths, _ := filepath.Glob(filepath.Join(configDir, "chats", "*", "*", "store.db"))
	type stamped struct {
		p string
		t time.Time
	}
	ps := make([]stamped, 0, len(paths))
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil {
			ps = append(ps, stamped{p, fi.ModTime()})
		}
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].t.After(ps[j].t) })
	var out []ChatMeta
	for _, s := range ps {
		if limit > 0 && len(out) >= limit {
			break
		}
		if m, err := ReadChatMeta(ctx, s.p); err == nil {
			out = append(out, m)
		}
	}
	return out
}

// CLIConfiguredModel is the model cursor-agent's own cli-config.json names,
// "" when it names none. The CLI writes it as {"model": {"modelId": …}}.
func CLIConfiguredModel(configDir string) string {
	b, err := os.ReadFile(filepath.Join(configDir, "cli-config.json"))
	if err != nil {
		return ""
	}
	var c struct {
		Model json.RawMessage `json:"model"`
	}
	if json.Unmarshal(b, &c) != nil || len(c.Model) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(c.Model, &s) == nil {
		return s
	}
	var o struct {
		ModelID string `json:"modelId"`
	}
	if json.Unmarshal(c.Model, &o) == nil {
		return o.ModelID
	}
	return ""
}
