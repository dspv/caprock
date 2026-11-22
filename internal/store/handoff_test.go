package store

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// handoffCoverageBefore is HandoffCoverage as it was before
// idx_events_handoff (migration 0090): the same two figures read off every
// assistant turn's payload. Kept here as the reference the indexed query must
// agree with.
func handoffCoverageBefore(ctx context.Context, q Querier, since int64, minLen int) (repos int, oldest int64, err error) {
	const passage = assistantTextWhere + `
		  AND e.ts >= ?1
		  AND LENGTH(json_extract(e.payload, '$.text')) >= ?2`
	err = q.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM (SELECT DISTINCT project FROM sessions WHERE project != '') p
		    WHERE EXISTS (
		      SELECT 1 FROM sessions se CROSS JOIN events e ON e.sid = se.sid
		       WHERE se.project = p.project AND `+passage+`)),
		  COALESCE((
		    SELECT e.ts FROM events e JOIN sessions se ON se.sid = e.sid
		     WHERE se.project != '' AND `+passage+`
		     ORDER BY e.ts LIMIT 1), 0)`, since, minLen).Scan(&repos, &oldest)
	return repos, oldest, err
}

// The indexed coverage answers what the payload walk answered, over turns
// on both sides of every condition the index holds: length (in characters,
// not bytes), sidechain, subagent, internal, kind, time and an empty project.
func TestHandoffCoverageMatchesThePayloadWalk(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	rng := rand.New(rand.NewSource(7))
	projects := []string{"", "/w/alpha", "/w/beta", "/w/gamma", "/w/delta", "/w/eps", "/w/zeta", "/w/eta", "/w/theta"}
	var sessions []string
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("s%02d", i)
		cwd := projects[rng.Intn(len(projects))]
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: cwd}); err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, id)
	}
	lengths := []int{0, 10, 399, 400, 401, 450, 600, 1200}
	for i := 0; i < 1500; i++ {
		n := lengths[rng.Intn(len(lengths))]
		text := strings.Repeat("w", n)
		if rng.Intn(4) == 0 {
			text = strings.Repeat("é", n) // two bytes a character
		}
		extra := ""
		switch rng.Intn(8) {
		case 0:
			extra = `,"sidechain":true`
		case 1:
			extra = `,"sidechain":false`
		}
		ev := &event.Event{
			SessionID: sessions[rng.Intn(len(sessions))], Source: event.SourceTranscript,
			Kind: event.KindTurnAssistant, Key: strconv.Itoa(i),
			Ts:      time.UnixMilli(int64(1000 + rng.Intn(100000))),
			Payload: json.RawMessage(`{"text":` + strconv.Quote(text) + extra + `}`),
		}
		switch rng.Intn(12) {
		case 0:
			ev.AgentID = "sub"
		case 1:
			ev.Kind = event.KindTurnUser
		}
		id, err := InsertEvent(ctx, db, ev)
		if err != nil {
			t.Fatal(err)
		}
		if rng.Intn(15) == 0 {
			if _, err := db.ExecContext(ctx, `UPDATE events SET internal = 1 WHERE id = ?`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	checked := 0
	for _, since := range []int64{0, 1000, 20000, 50000, 90000, 99000, 200000} {
		for _, minLen := range []int{400, 401, 450, 1000, 5000} {
			wantR, wantO, err := handoffCoverageBefore(ctx, db, since, minLen)
			if err != nil {
				t.Fatal(err)
			}
			gotR, gotO, err := HandoffCoverage(ctx, db, since, minLen)
			if err != nil {
				t.Fatal(err)
			}
			if gotR != wantR || gotO != wantO {
				t.Fatalf("since %d, min %d: got %d repos since %d, want %d since %d", since, minLen, gotR, gotO, wantR, wantO)
			}
			if wantR > 0 {
				checked++
			}
		}
	}
	if checked == 0 {
		t.Fatal("no case found a passage: the data proves nothing")
	}
	if _, _, err := HandoffCoverage(ctx, db, 0, HandoffMinRunes-1); err == nil {
		t.Fatal("a floor below the index's was answered; the index does not hold those passages")
	}
}

// At the index's own floor the coverage never reads a column of the events
// table: every condition is implied by idx_events_handoff, so the statement's
// program opens the table only to follow rowids it never dereferences, and
// the payload stays shut.
func TestHandoffCoverageReadsNoPayload(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	db := s.DB()
	var root int64
	if err := db.QueryRowContext(ctx, `SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'events'`).Scan(&root); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `EXPLAIN `+handoffCoverageSQL(HandoffMinRunes), int64(0))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	cols, _ := rows.Columns()
	onEvents := map[int64]bool{}
	var reads []string
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		op := fmt.Sprint(vals[1])
		p1, _ := strconv.ParseInt(fmt.Sprint(vals[2]), 10, 64)
		p2, _ := strconv.ParseInt(fmt.Sprint(vals[3]), 10, 64)
		switch op {
		case "OpenRead":
			onEvents[p1] = p2 == root
		case "Column":
			if onEvents[p1] {
				reads = append(reads, fmt.Sprintf("column %d", p2))
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(onEvents) == 0 {
		t.Fatal("the program opens nothing: the EXPLAIN was not read")
	}
	if len(reads) > 0 {
		t.Fatalf("the coverage reads the events table: %v", reads)
	}
}
