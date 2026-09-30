package ingest

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/dspv/caprock/internal/store"
)

// BackfillTitles names the Claude Code sessions ingested before titles were
// read, from the transcripts still on disk.
//
// The tailer resumes from a stored offset, so an `ai-title` line it passed
// before parser v3 is never read again; without this every session older than
// the upgrade would stay unnamed even though its name is sitting in the file.
// One read per transcript, the last title wins (Claude Code rewrites it as the
// conversation moves), and a transcript that is gone leaves the row alone.
func BackfillTitles(ctx context.Context, db *sql.DB, log *slog.Logger) (named int, err error) {
	rows, err := db.QueryContext(ctx, `
		SELECT session_id, COALESCE(transcript_path,'') FROM sessions
		WHERE COALESCE(agent,'claude') = 'claude' AND title = '' AND COALESCE(transcript_path,'') != ''`)
	if err != nil {
		return 0, fmt.Errorf("find untitled sessions: %w", err)
	}
	type target struct{ id, path string }
	var targets []target
	for rows.Next() {
		var t target
		if err := rows.Scan(&t.id, &t.path); err != nil {
			_ = rows.Close()
			return 0, err
		}
		targets = append(targets, t)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, t := range targets {
		if ctx.Err() != nil {
			return named, ctx.Err()
		}
		title := lastTitle(MainTranscript(t.path, t.id))
		if title == "" {
			continue
		}
		if err := store.SetTitle(ctx, db, t.id, title); err != nil {
			return named, err
		}
		named++
	}
	if log != nil && named > 0 {
		log.Info("named sessions from their transcripts", "component", "ingest", "sessions", named)
	}
	return named, nil
}

// MainTranscript is the file holding a session's own conversation.
//
// A session's recorded transcript_path is whichever file its last line arrived
// on, and a subagent writes under `<project>/<session-id>/subagents/…`, so the
// recorded path often points into a subagent. The main thread is always
// `<project>/<session-id>.jsonl`.
func MainTranscript(recorded, sessionID string) string {
	if recorded == "" || sessionID == "" {
		return recorded
	}
	sep := string(filepath.Separator)
	marker := sep + sessionID + sep
	if i := strings.Index(recorded, marker); i >= 0 {
		return recorded[:i] + sep + sessionID + ".jsonl"
	}
	return recorded
}

// lastTitle returns the last ai-title in a transcript, or "".
func lastTitle(path string) string {
	f, err := os.Open(path) //nolint:gosec // a transcript path the daemon recorded itself
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	marker := []byte(`"` + TypeAITitle + `"`)
	title := ""
	for sc.Scan() {
		raw := sc.Bytes()
		// Cheap filter first: nearly every line is a turn, and decoding each
		// one to find the handful of title lines would parse the whole file.
		if !bytes.Contains(raw, marker) {
			continue
		}
		if l, err := ParseLine(raw); err == nil && l.Type == TypeAITitle && strings.TrimSpace(l.AITitle) != "" {
			title = strings.TrimSpace(l.AITitle)
		}
	}
	return title
}
