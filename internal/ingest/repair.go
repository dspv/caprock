package ingest

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// RepairAssistantText re-derives the stored prose of assistant turns from the
// transcripts still on disk.
//
// Parser v1 capped assistant text at 2000 *bytes* and sliced at an arbitrary
// byte offset. Two consequences: multi-byte prose (Cyrillic is two bytes per
// character) was cut at roughly half the intended length, and a cut through the
// middle of a rune left a U+FFFD at the end of about a fifth of clipped rows.
// The cap landed hardest on closing summaries — the one thing people come back
// to a session for.
//
// Fixing the parser only helps lines ingested afterwards, so this walks the
// affected rows once and rewrites `payload.text` in place from the original
// transcript. It touches nothing else: no new events, no changed ids, no
// recomputed costs. Rows whose transcript has since been deleted keep what they
// have — a short note is better than a missing one.
func RepairAssistantText(ctx context.Context, db *sql.DB, log *slog.Logger) (repaired int, err error) {
	// Only rows that v1 could have damaged: text ending in the truncation
	// ellipsis, or already carrying a replacement character.
	rows, err := db.QueryContext(ctx, `
		SELECT e.id, e.session_id, COALESCE(json_extract(e.payload,'$.message_id'),''),
		       COALESCE(se.transcript_path,'')
		FROM events e JOIN sessions se ON se.session_id = e.session_id
		WHERE e.kind = 'turn.assistant'
		  AND COALESCE(se.transcript_path,'') != ''
		  AND (json_extract(e.payload,'$.text') LIKE '%…'
		       OR json_extract(e.payload,'$.text') LIKE '%'||char(65533)||'%')`)
	if err != nil {
		return 0, fmt.Errorf("find truncated assistant text: %w", err)
	}
	defer func() { _ = rows.Close() }()

	type target struct {
		id        int64
		messageID string
	}
	// Group by transcript so each file is read once, not once per row.
	byFile := map[string][]target{}
	for rows.Next() {
		var id int64
		var sessionID, messageID, path string
		if err := rows.Scan(&id, &sessionID, &messageID, &path); err != nil {
			return 0, err
		}
		if messageID == "" {
			continue // nothing to match the transcript line on
		}
		byFile[path] = append(byFile[path], target{id: id, messageID: messageID})
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(byFile) == 0 {
		return 0, nil
	}

	for path, targets := range byFile {
		wanted := make(map[string]int64, len(targets))
		for _, t := range targets {
			wanted[t.messageID] = t.id
		}
		texts, err := textsByMessageID(path, wanted)
		if err != nil {
			// A missing or unreadable transcript is not fatal: the rows simply
			// keep the text they already have.
			if log != nil && !errors.Is(err, os.ErrNotExist) {
				log.Debug("repair: cannot read transcript", "component", "ingest", "path", path, "err", err)
			}
			continue
		}
		// A session's recorded transcript_path is not always where its messages
		// live: a session whose last line arrived on a subagent transcript has
		// that file recorded, while the main-thread turns sit in a sibling file
		// in the same project directory. Sweep the siblings for whatever the
		// recorded path did not account for.
		if missing := remaining(wanted, texts); len(missing) > 0 {
			for _, sibling := range siblingTranscripts(path) {
				found, err := textsByMessageID(sibling, missing)
				if err != nil {
					continue
				}
				for id, text := range found {
					texts[id] = text
					delete(missing, id)
				}
				if len(missing) == 0 {
					break
				}
			}
		}
		for messageID, text := range texts {
			id := wanted[messageID]
			n, err := updateText(ctx, db, id, text)
			if err != nil {
				return repaired, err
			}
			repaired += n
		}
	}
	return repaired, nil
}

// remaining returns the wanted ids that a scan did not resolve.
func remaining(wanted map[string]int64, found map[string]string) map[string]int64 {
	out := make(map[string]int64)
	for id, ev := range wanted {
		if _, ok := found[id]; !ok {
			out[id] = ev
		}
	}
	return out
}

// siblingTranscripts lists the other transcripts in the same project directory,
// newest first. Claude Code keeps a session's main transcript and its subagent
// transcripts side by side, so a message absent from one is usually in another.
func siblingTranscripts(path string) []string {
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return nil
	}
	type cand struct {
		path string
		mod  int64
	}
	dir := filepath.Dir(path)
	// When the recorded path is itself a subagent transcript
	// (<project>/<session-id>/subagents/agent-*.jsonl), the main-thread turns
	// live two levels up in the project directory. Search from there, so the
	// sweep covers the parent and every sibling rather than only descendants.
	if filepath.Base(dir) == "subagents" {
		dir = filepath.Dir(filepath.Dir(dir))
		var err error
		entries, err = os.ReadDir(dir)
		if err != nil {
			return nil
		}
	}
	var out []cand
	add := func(full string, info os.FileInfo) {
		if full == path {
			return
		}
		out = append(out, cand{path: full, mod: info.ModTime().UnixNano()})
	}
	for _, e := range entries {
		// Subagent transcripts live one level down, in
		// <session-id>/subagents/agent-*.jsonl, so a flat scan of the project
		// directory misses every message a subagent turn produced.
		if e.IsDir() {
			sub := filepath.Join(dir, e.Name(), "subagents")
			subEntries, err := os.ReadDir(sub)
			if err != nil {
				continue
			}
			for _, se := range subEntries {
				if se.IsDir() || !strings.HasSuffix(se.Name(), ".jsonl") {
					continue
				}
				if info, err := se.Info(); err == nil {
					add(filepath.Join(sub, se.Name()), info)
				}
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if info, err := e.Info(); err == nil {
			add(filepath.Join(dir, e.Name()), info)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].mod > out[j].mod })
	// Bound the work: a busy project directory can hold hundreds of files, and
	// this runs once at startup.
	const maxSiblings = 200
	paths := make([]string, 0, len(out))
	for i, c := range out {
		if i >= maxSiblings {
			break
		}
		paths = append(paths, c.path)
	}
	return paths
}

// textsByMessageID scans a transcript once and returns the full assistant text
// for each message id of interest, re-derived with the current (rune-safe) cap.
func textsByMessageID(path string, wanted map[string]int64) (map[string]string, error) {
	f, err := os.Open(path) //nolint:gosec // path comes from our own sessions table
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	out := make(map[string]string, len(wanted))
	sc := bufio.NewScanner(f)
	// Transcript lines carry whole assistant turns and can be large.
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		raw := sc.Bytes()
		if len(raw) == 0 {
			continue
		}
		l, err := ParseLine(raw)
		// Message is a pointer and is absent on system lines, so it must be
		// checked before the id is read.
		if err != nil || l == nil || l.Message == nil || l.Message.ID == "" {
			continue
		}
		if _, ok := wanted[l.Message.ID]; !ok {
			continue
		}
		var text []string
		for _, b := range l.blocks() {
			if b.Type == "text" {
				if t := strings.TrimSpace(b.Text); t != "" {
					text = append(text, t)
				}
			}
		}
		if len(text) == 0 {
			continue
		}
		out[l.Message.ID] = clipRunes(strings.Join(text, "\n"), MaxAssistantText)
	}
	if err := sc.Err(); err != nil {
		return out, err
	}
	return out, nil
}

// updateText rewrites only the `text` key of the row's payload, leaving every
// other key (model, tools, sidechain, _from) exactly as ingested.
func updateText(ctx context.Context, db *sql.DB, id int64, text string) (int, error) {
	var raw string
	if err := db.QueryRowContext(ctx, `SELECT payload FROM events WHERE id = ?`, id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	payload, ok := decodePayload(raw)
	if !ok {
		// A payload we cannot parse is left exactly as it is: this repair may
		// only ever improve a row, never damage one it does not understand.
		return 0, nil
	}
	if cur, _ := payload["text"].(string); cur == text {
		return 0, nil
	}
	payload["text"] = text
	enc, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	if _, err := db.ExecContext(ctx, `UPDATE events SET payload = ? WHERE id = ?`, string(enc), id); err != nil {
		return 0, err
	}
	return 1, nil
}

// decodePayload parses a stored payload, reporting failure as a plain bool: an
// unreadable payload is a row to skip, not an error to propagate.
func decodePayload(raw string) (map[string]any, bool) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, false
	}
	return payload, true
}

// NeedsTextRepair reports whether the database was written by a parser version
// that truncated on bytes.
func NeedsTextRepair(storedVersion string) bool {
	return storedVersion != "" && storedVersion != fmt.Sprint(SchemaVersion)
}

// HasReplacementChar is a small helper for tests and diagnostics.
func HasReplacementChar(s string) bool {
	return strings.ContainsRune(s, utf8.RuneError)
}
