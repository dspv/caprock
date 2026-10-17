package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// growthMeta is the first record of every synthetic growing transcript.
const growthMeta = `{"timestamp":"2026-10-18T10:00:00.000Z","type":"session_meta","payload":{"session_id":"01f3f3f3-0000-7000-8000-000000000001","id":"01f3f3f3-0000-7000-8000-000000000001","timestamp":"2026-10-18T10:00:00.000Z","cwd":"/Users/dev/proj","originator":"codex-tui","cli_version":"0.160.0","source":"cli","base_instructions":{"provenance":{"type":"model","model":"gpt-5-codex"}}}}`

// growthRecord is line i (0-based, after session_meta) of a synthetic
// transcript that grows the way a live Codex session does: requests of eight
// records — task_started, the typed prompt, assistant prose, a shell call, its
// output, the cumulative token_count, late prose and task_complete. Text is
// padded so a record averages roughly the audit's 1 KiB.
func growthRecord(i int) []byte {
	req := i / 8
	at := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC).Add(time.Duration(i) * 10 * time.Millisecond).Format(time.RFC3339Nano)
	pad := strings.Repeat("x", 900)
	call := fmt.Sprintf("call_%d", req)
	var typ string
	var payload any
	switch i % 8 {
	case 0:
		typ, payload = "event_msg", map[string]any{"type": "task_started", "turn_id": fmt.Sprintf("turn-%d", req)}
	case 1:
		typ, payload = "event_msg", map[string]any{"type": "item_completed", "item": map[string]any{
			"type": "UserMessage", "content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("request %d %s", req, pad)}}}}
	case 2:
		typ, payload = "response_item", map[string]any{"type": "message", "role": "assistant", "content": []any{
			map[string]any{"type": "output_text", "text": fmt.Sprintf("looking at %d %s", req, pad)}}}
	case 3:
		typ, payload = "response_item", map[string]any{"type": "function_call", "name": "shell", "call_id": call,
			"arguments": fmt.Sprintf(`{"command":["bash","-lc","echo %d %s"]}`, req, pad)}
	case 4:
		typ, payload = "response_item", map[string]any{"type": "function_call_output", "call_id": call,
			"output": fmt.Sprintf(`{"output":"%d %s","metadata":{"exit_code":0}}`, req, pad)}
	case 5:
		n := int64(req + 1)
		typ, payload = "event_msg", map[string]any{"type": "token_count", "info": map[string]any{"total_token_usage": map[string]any{
			"input_tokens": 1000 * n, "cached_input_tokens": 800 * n, "output_tokens": 100 * n,
			"reasoning_output_tokens": 40 * n, "total_tokens": 1100 * n}}}
	case 6:
		typ, payload = "response_item", map[string]any{"type": "message", "role": "assistant", "content": []any{
			map[string]any{"type": "output_text", "text": fmt.Sprintf("done %d %s", req, pad)}}}
	default:
		typ, payload = "event_msg", map[string]any{"type": "task_complete", "turn_id": fmt.Sprintf("turn-%d", req)}
	}
	b, err := json.Marshal(map[string]any{"timestamp": at, "type": typ, "payload": payload})
	if err != nil {
		panic(err)
	}
	return append(b, '\n')
}

// growthTranscript is the meta record and the first n growth records.
func growthTranscript(n int) []byte {
	out := []byte(growthMeta + "\n")
	for i := 0; i < n; i++ {
		out = append(out, growthRecord(i)...)
	}
	return out
}

// BenchmarkAppendOneRecord measures one ingest pass after one record is
// appended to a transcript already holding n records: the work a live Codex
// session costs per poll. The initial import is outside the timer.
func BenchmarkAppendOneRecord(b *testing.B) { benchAppend(b, false) }

// BenchmarkAppendOneRecordReplay is the same pass with tails off: the whole
// file parsed and every record offered again, as before tails.
func BenchmarkAppendOneRecordReplay(b *testing.B) { benchAppend(b, true) }

func benchAppend(b *testing.B, replay bool) {
	for _, n := range []int{1024, 8192, 16384} {
		b.Run(fmt.Sprintf("records=%d", n), func(b *testing.B) {
			lg := slog.New(slog.NewTextHandler(io.Discard, nil))
			st, err := store.Open(context.Background(), filepath.Join(b.TempDir(), "caprock.db"), lg)
			if err != nil {
				b.Fatal(err)
			}
			defer st.Close()
			table, err := cost.Load("")
			if err != nil {
				b.Fatal(err)
			}
			dir := filepath.Join(b.TempDir(), "sessions")
			sub := filepath.Join(dir, "2026", "10", "18")
			if err := os.MkdirAll(sub, 0o755); err != nil {
				b.Fatal(err)
			}
			path := filepath.Join(sub, "rollout-2026-10-18T10-00-00-01f3f3f3-0000-7000-8000-000000000001.jsonl")
			if err := os.WriteFile(path, growthTranscript(n), 0o600); err != nil {
				b.Fatal(err)
			}
			in := NewIngester([]string{dir}, rollup.New(st, table, nil, lg), lg, time.Second)
			in.replay = replay
			ctx := context.Background()
			if err := in.once(ctx); err != nil {
				b.Fatal(err)
			}
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				b.Fatal(err)
			}
			defer f.Close()
			next := n
			start := benchCounters(in)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := f.Write(growthRecord(next)); err != nil {
					b.Fatal(err)
				}
				next++
				if err := in.once(ctx); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
			reportCounters(b, in, start)
		})
	}
}
