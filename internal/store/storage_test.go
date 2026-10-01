package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

func storageEvent(t *testing.T, st *Store, session, agent string, kind event.Kind, ts time.Time, payload string, n int) {
	t.Helper()
	ctx := context.Background()
	if err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, session, SessionPatch{StartedAt: ts.UnixMilli(), LastEventAt: ts.UnixMilli(), Agent: agent}); err != nil {
			return err
		}
		for i := 0; i < n; i++ {
			if _, err := InsertEvent(ctx, q, &event.Event{
				Ts: ts, SessionID: session, Source: event.SourceTranscript, Kind: kind,
				Key: string(kind) + strconv.Itoa(i) + ts.String(), Payload: json.RawMessage(payload),
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// The breakdown counts bytes, splits by agent and kind, and puts every event
// on the right side of each day boundary.
func TestMeasureStorageBreaksTheEventsDown(t *testing.T) {
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	// "é" is two bytes and one character: length() would undercount it.
	big := `{"t":"` + strings.Repeat("é", 500) + `"}` // 1008 bytes
	small := `{"t":"x"}`                              // 9 bytes
	storageEvent(t, st, "c1", "claude", event.KindToolPost, now.Add(-2*day), big, 3)
	storageEvent(t, st, "c1", "claude", event.KindTurnAssistant, now.Add(-20*day), small, 4)
	storageEvent(t, st, "x1", "codex", event.KindToolPre, now.Add(-100*day), small, 5)

	got, err := MeasureStorage(context.Background(), st.DB(), now)
	if err != nil {
		t.Fatal(err)
	}
	if got.Events != 12 || got.PayloadBytes != 3*1008+9*9 {
		t.Fatalf("events %d payload %d", got.Events, got.PayloadBytes)
	}
	if got.OldestTs != now.Add(-100*day).UnixMilli() {
		t.Fatalf("oldest %d", got.OldestTs)
	}
	if len(got.Agents) != 2 || got.Agents[0].Name != "claude" || got.Agents[0].Events != 7 || got.Agents[1].PayloadBytes != 45 {
		t.Fatalf("agents %+v", got.Agents)
	}
	if got.Kinds[0].Name != string(event.KindToolPost) || got.Kinds[0].PayloadBytes != 3024 {
		t.Fatalf("kinds %+v", got.Kinds)
	}
	want := []WindowSize{{Days: 7, Events: 3, PayloadBytes: 3024}, {Days: 30, Events: 7, PayloadBytes: 3060}}
	if got.Recent[0] != want[0] || got.Recent[1] != want[1] {
		t.Fatalf("recent %+v", got.Recent)
	}
	if got.Older[0] != (WindowSize{Days: 30, Events: 5, PayloadBytes: 45}) || got.Older[1] != (WindowSize{Days: 90, Events: 5, PayloadBytes: 45}) {
		t.Fatalf("older %+v", got.Older)
	}
	if len(got.Tables) == 0 {
		t.Fatal("no table sizes: this build of SQLite has no dbstat")
	}
	var events *TableSize
	for i := range got.Tables {
		if got.Tables[i].Name == "events" {
			events = &got.Tables[i]
		}
		if strings.HasPrefix(got.Tables[i].Name, "idx_") || strings.HasPrefix(got.Tables[i].Name, "sqlite_autoindex") {
			t.Fatalf("index %s reported as a table", got.Tables[i].Name)
		}
	}
	if events == nil || events.DataBytes == 0 || events.IndexBytes == 0 {
		t.Fatalf("events table %+v", events)
	}
	if got.PageSize*got.PageCount == 0 {
		t.Fatalf("pages %d×%d", got.PageCount, got.PageSize)
	}
}

// Deleted rows leave free pages behind, and the measurement reports them —
// that is the figure that says whether a VACUUM would give anything back.
func TestMeasureStorageReportsFreePages(t *testing.T) {
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "c.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now()
	storageEvent(t, st, "c1", "claude", event.KindToolPost, now.Add(-48*time.Hour), `{"t":"`+strings.Repeat("a", 20000)+`"}`, 50)
	if _, err := st.DB().Exec(`DELETE FROM events`); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		t.Fatal(err)
	}
	got, err := MeasureStorage(context.Background(), st.DB(), now)
	if err != nil {
		t.Fatal(err)
	}
	if got.FreePages == 0 || got.Events != 0 || got.OldestTs != 0 {
		t.Fatalf("free %d events %d oldest %d", got.FreePages, got.Events, got.OldestTs)
	}
}
