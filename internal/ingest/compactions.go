package ingest

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// BackfillCompactions adds the compaction boundaries (context.compacted) of
// the Claude Code transcripts still on disk, for sessions read before
// parser v5.
//
// The tailer resumes from a stored offset, so a compact_boundary line it
// passed before v5 is never read again; without this a user's own
// compactions — what the Compact button's "usually stays" line is measured
// from — would start empty on the day of the upgrade though months of them
// sit in the files. One read per main transcript, a cheap substring filter
// before any line is decoded, and the boundary's own key (compact:<uuid>)
// so a line the tailer also reads is stored once. The events go straight to
// the store, not through rollup: they are history, and must not move a
// session's status or its last event.
func BackfillCompactions(ctx context.Context, db *sql.DB, log *slog.Logger) (added int, err error) {
	rows, err := db.QueryContext(ctx, `
		SELECT session_id, COALESCE(transcript_path,'') FROM sessions
		WHERE COALESCE(agent,'claude') = 'claude' AND COALESCE(transcript_path,'') != ''`)
	if err != nil {
		return 0, fmt.Errorf("find sessions with transcripts: %w", err)
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
			return added, ctx.Err()
		}
		n, err := backfillCompactionsFrom(ctx, db, MainTranscript(t.path, t.id), t.id)
		added += n
		if err != nil {
			return added, err
		}
	}
	if log != nil && added > 0 {
		log.Info("added compactions from transcripts", "component", "ingest", "events", added)
	}
	return added, nil
}

// compactMarker is the substring every compact_boundary line holds.
var compactMarker = []byte(`"` + SubtypeCompactBoundary + `"`)

// backfillCompactionsFrom stores the boundaries in one transcript that
// belong to sessionID. A file that is gone adds nothing.
func backfillCompactionsFrom(ctx context.Context, db *sql.DB, path, sessionID string) (int, error) {
	f, err := os.Open(path) //nolint:gosec // a transcript path the daemon recorded itself
	if err != nil {
		return 0, nil
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	added := 0
	for sc.Scan() {
		raw := sc.Bytes()
		if !bytes.Contains(raw, compactMarker) {
			continue
		}
		l, err := ParseLine(raw)
		if err != nil || l.SessionID != sessionID {
			continue
		}
		for _, ev := range l.Events(time.Time{}) {
			if ev.Ts.IsZero() {
				continue // no timestamp: it cannot be placed in the session
			}
			if _, err := store.InsertEvent(ctx, db, &ev); err != nil {
				if errors.Is(err, store.ErrDuplicate) {
					continue
				}
				return added, err
			}
			added++
		}
	}
	return added, nil
}

// summaryMarker is the substring every isCompactSummary line holds.
var summaryMarker = []byte(`"isCompactSummary":true`)

// BackfillCompactionSummaries reads back the length of each compaction's
// summary — the isCompactSummary user message after its boundary — for the
// compaction_stats rows that lack it: the summaries are not in the events
// (the line's prompt key is usually the turn's own and is stored once). One
// read per main transcript, a substring filter before any line is decoded.
// A transcript that is gone leaves its rows without one; their cost is then
// the context read alone, and the row says so (summary_tokens_est NULL).
func BackfillCompactionSummaries(ctx context.Context, db *sql.DB) (set int, err error) {
	targets, err := store.CompactionsMissingSummary(ctx, db)
	if err != nil {
		return 0, fmt.Errorf("find compactions without a summary: %w", err)
	}
	for _, t := range targets {
		if ctx.Err() != nil {
			return set, ctx.Err()
		}
		n, err := summariesFrom(ctx, db, MainTranscript(t[1], t[0]), t[0])
		set += n
		if err != nil {
			return set, err
		}
	}
	return set, nil
}

func summariesFrom(ctx context.Context, db *sql.DB, path, sessionID string) (int, error) {
	f, err := os.Open(path) //nolint:gosec // a transcript path the daemon recorded itself
	if err != nil {
		return 0, nil
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	set := 0
	last := "" // the uuid of the last boundary line read
	for sc.Scan() {
		raw := sc.Bytes()
		boundary := bytes.Contains(raw, compactMarker)
		if !boundary && !bytes.Contains(raw, summaryMarker) {
			continue
		}
		l, err := ParseLine(raw)
		if err != nil || l.SessionID != sessionID {
			continue
		}
		if l.Type == "system" && l.Subtype == SubtypeCompactBoundary {
			last = l.UUID
			continue
		}
		if l.Type != "user" || !l.IsCompactSummary {
			continue
		}
		text, _ := l.promptText()
		if err := store.SetCompactionSummary(ctx, db, sessionID, cmp.Or(last, l.ParentUUID), text); err != nil {
			return set, err
		}
		set++
	}
	return set, nil
}
