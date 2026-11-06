package store

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// benchStore holds 90 days of a busy session's tool calls: 2,000 Bash and
// Edit calls with their results, the results a few kilobytes each.
func benchStore(b *testing.B, now time.Time) *Store {
	b.Helper()
	st, err := Open(context.Background(), filepath.Join(b.TempDir(), "b.db"), nil)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	if err := st.WithTx(ctx, func(q Querier) error {
		if err := UpsertSession(ctx, q, "b", SessionPatch{StartedAt: 1, LastEventAt: 1, Cwd: "/w/app"}); err != nil {
			return err
		}
		for i := range 2000 {
			ts := now.Add(-90 * 24 * time.Hour).Add(time.Duration(i) * 65 * time.Minute)
			tool := []string{"Bash", "Edit"}[i%2]
			in := map[string]any{"command": fmt.Sprintf("go test ./pkg%d/...", i%40)}
			if tool == "Edit" {
				in = map[string]any{"file_path": fmt.Sprintf("/w/app/f%d.go", i%60), "old_string": strings.Repeat("a\n", 80), "new_string": strings.Repeat("b\n", 90)}
			}
			pre, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "tool_use_id": fmt.Sprint(i), "cwd": "/w/app", "tool_input": in})
			post, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "tool_use_id": fmt.Sprint(i), "cwd": "/w/app", "tool_input": in,
				"tool_response": map[string]any{"stdout": strings.Repeat(fmt.Sprintf("ok  \tgithub.com/x/pkg%d\t0.%03ds\n", i%40, i%997), 60)}})
			for _, e := range []event.Event{
				{Ts: ts, SessionID: "b", Source: event.SourceHook, Kind: event.KindToolPre, Tool: tool, Key: fmt.Sprint("pre:", i), Payload: pre},
				{Ts: ts.Add(time.Second), SessionID: "b", Source: event.SourceHook, Kind: event.KindToolPost, Tool: tool, Key: fmt.Sprint("post:", i), Payload: post},
			} {
				if _, err := InsertEvent(ctx, q, &e); err != nil {
					return err
				}
			}
		}
		return nil
	}); err != nil {
		b.Fatal(err)
	}
	if _, err := st.FillToolFields(ctx, 5000, 0); err != nil {
		b.Fatal(err)
	}
	return st
}

// BenchmarkZjson is one decompression through the SQL function, a different
// row each time so the cache never answers.
func BenchmarkZjson(b *testing.B) {
	var frames [][]byte
	for i := range 64 {
		z, _ := CompressPayload(toolPayload(i))
		frames = append(frames, z)
	}
	b.SetBytes(int64(len(toolPayload(0))))
	i := 0
	for b.Loop() {
		if _, err := zjson(nil, []driver.Value{frames[i%len(frames)]}); err != nil {
			b.Fatal(err)
		}
		i++
	}
}

// BenchmarkToolReads is the tool statistics over a long range, plain and with
// every older tool row compressed: the Tools drill-down (from tool_fields,
// which compression does not touch) and the Week's tool scan over 90 days
// (which decompresses each result it reads).
func BenchmarkToolReads(b *testing.B) {
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	for _, compressed := range []bool{false, true} {
		st := benchStore(b, now)
		if compressed {
			for {
				s, err := st.CompressPayloadsStep(context.Background(), 5000, now.Add(-CompressAge).UnixMilli(), now.UnixMilli())
				if err != nil {
					b.Fatal(err)
				}
				if s.Done {
					break
				}
			}
		}
		name := map[bool]string{false: "plain", true: "compressed"}[compressed]
		ctx := context.Background()
		b.Run("drill-90d/"+name, func(b *testing.B) {
			for b.Loop() {
				if _, err := ToolDrillStats(ctx, st.DB(), DrillOptions{Tool: "Bash", FromMs: now.AddDate(0, 0, -90).UnixMilli(), ToMs: now.UnixMilli()}); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("week-tools-90d/"+name, func(b *testing.B) {
			for b.Loop() {
				if _, err := scanToolPosts(ctx, st.DB(), now.AddDate(0, 0, -90).UnixMilli(), now.UnixMilli(), ""); err != nil {
					b.Fatal(err)
				}
			}
		})
		b.Run("events-4000/"+name, func(b *testing.B) {
			for b.Loop() {
				if _, err := ListEvents(ctx, st.DB(), "b", 0, 4000); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
