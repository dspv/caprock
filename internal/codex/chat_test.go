package codex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

const chatFixture = "../../testdata/codex/rollout-chat.jsonl"

// What the person typed is the UserMessage item, not every user-role message:
// Codex writes its own environment block the same way, and that is not a
// prompt.
func TestPromptsAreWhatThePersonTyped(t *testing.T) {
	s, err := ParseFile(chatFixture)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range s.Prompts {
		got = append(got, p.Text)
	}
	want := []string{"Why is the Windows job red?", "Fix it and run the tests again"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("prompts = %q, want %q", got, want)
	}
	if s.Prompts[0].Key != "codex:user:7" {
		t.Errorf("prompt key = %q, want the item's line", s.Prompts[0].Key)
	}
}

// A file with only the older `user_message` event reads its prompts from
// there; a file with both reads the item alone, so nothing is stored twice.
func TestPromptsFromUserMessageEvents(t *testing.T) {
	head := `{"timestamp":"2026-09-15T09:25:25.100Z","type":"session_meta","payload":{"id":"s-um","cwd":"/p","source":"cli"}}
{"timestamp":"2026-09-15T09:25:26.000Z","type":"event_msg","payload":{"type":"user_message","message":"list the files","images":[]}}
`
	s, err := Parse(strings.NewReader(head), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Prompts) != 1 || s.Prompts[0].Text != "list the files" {
		t.Fatalf("user_message prompts: %+v", s.Prompts)
	}
	both := head + `{"timestamp":"2026-09-15T09:25:26.001Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"list the files"},{"type":"local_image","path":"/tmp/a.png"}]}}}
`
	s, err = Parse(strings.NewReader(both), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Prompts) != 1 || s.Prompts[0].Key != "codex:user:3" {
		t.Fatalf("a prompt written both ways was read %d times: %+v", len(s.Prompts), s.Prompts)
	}
}

// A subagent's file replays its parent's history, prompts included; storing
// them would show the parent's prompts twice.
func TestSubagentThreadKeepsNoPrompts(t *testing.T) {
	src := `{"timestamp":"2026-09-24T09:26:30.191Z","type":"session_meta","payload":{"session_id":"s-parent","id":"s-child","cwd":"/p","source":{"subagent":{"thread_spawn":{"parent_thread_id":"s-parent","depth":1}}}}}
{"timestamp":"2026-09-24T09:26:31.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"the parent's prompt"}]}}}
`
	s, err := Parse(strings.NewReader(src), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Prompts) != 0 {
		t.Fatalf("subagent prompts kept: %+v", s.Prompts)
	}
}

// Every output is paired to its call by call_id, and says whether it failed:
// an exec script that failed, a shell command's non-zero exit code.
func TestToolResultsPairWithTheirCalls(t *testing.T) {
	s, err := ParseFile(chatFixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Tools) != 5 || len(s.Results) != 4 {
		t.Fatalf("want 5 calls and 4 results, got %d and %d", len(s.Tools), len(s.Results))
	}
	byCall := map[string]ToolResult{}
	for _, r := range s.Results {
		byCall[r.CallID] = r
	}
	exec := byCall["call_exec1"]
	if exec.Name != "exec" || exec.Failed || !strings.Contains(exec.Output, "Output:\n--- FAIL: TestHome") {
		t.Errorf("exec result: %+v", exec)
	}
	if js := byCall["call_js1"]; js.Name != "js" || js.Output != "Wall time: 0.7206 seconds\nOutput:\nBrowser is not available: iab" {
		t.Errorf("js result: %+v", js)
	}
	if p := byCall["call_patch1"]; !p.Failed || p.ExitCode != nil {
		t.Errorf("a failed script must read failed, with no exit code: %+v", p)
	}
	sh := byCall["call_shell1"]
	if !sh.Failed || sh.ExitCode == nil || *sh.ExitCode != 1 || sh.Output != "--- FAIL: TestHome (0.00s)\nFAIL\n" {
		t.Errorf("shell result: %+v", sh)
	}
	for _, c := range s.Tools {
		if c.CallID == "" {
			t.Errorf("call %s has no call id", c.Key)
		}
	}
}

func TestToolOutputIsClippedOnRunes(t *testing.T) {
	long := strings.Repeat("ε", MaxToolOutput+10)
	r := readOutput(json.RawMessage(`"` + long + `"`))
	if !strings.HasSuffix(r.Output, "…[truncated]") || len([]rune(strings.TrimSuffix(r.Output, "…[truncated]"))) != MaxToolOutput {
		t.Fatalf("clipped to %d runes", len([]rune(r.Output)))
	}
}

// Stored, a prompt is a turn.user in Claude Code's shape and a result a
// tool.post whose tool_use_id is its call's, so the chat pairs them.
func TestChatEventsAreStored(t *testing.T) {
	h := newHarness(t)
	h.putFile(chatFixture, "rollout-chat.jsonl")
	h.poll()
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.user'`); n != 2 {
		t.Fatalf("want 2 prompts stored, got %d", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.user' AND json_extract(payload,'$.prompt') LIKE '%environment_context%'`); n != 0 {
		t.Fatal("Codex's environment block was stored as a prompt")
	}
	// Every result pairs with a stored call.
	if n := count(t, h.out, `SELECT COUNT(*) FROM events p JOIN events c
		ON c.session_id = p.session_id AND c.kind = 'tool.pre'
		AND json_extract(c.payload,'$.tool_use_id') = json_extract(p.payload,'$.tool_use_id')
		WHERE p.source='codex' AND p.kind='tool.post'`); n != 4 {
		t.Fatalf("want 4 results paired with their calls, got %d", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE kind='tool.post' AND json_extract(payload,'$.exit_code') = 1 AND json_extract(payload,'$.is_error') = 1 AND tool = 'shell'`); n != 1 {
		t.Fatalf("the shell result lost its exit code: %d", n)
	}
	// The shell call's input is the command it ran, not the JSON it came in.
	var cmd string
	if err := h.out.QueryRow(`SELECT json_extract(payload,'$.tool_input.command') FROM events WHERE kind='tool.pre' AND tool='shell'`).Scan(&cmd); err != nil {
		t.Fatal(err)
	}
	if cmd != "go test ./internal/home/" {
		t.Fatalf("shell command stored as %q", cmd)
	}
	// Reading the file again stores nothing new.
	before := count(t, h.out, `SELECT COUNT(*) FROM events`)
	s, err := ParseFile(chatFixture)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.in.session(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if after := count(t, h.out, `SELECT COUNT(*) FROM events`); after != before {
		t.Fatalf("a re-read stored %d more events", after-before)
	}
}

// Transcripts read before prompts and results were stored are read once more:
// the prompts and results are added, the calls already stored gain their call
// id and their normalised input, and nothing else changes.
func TestBackfillGivesOldSessionsTheirChat(t *testing.T) {
	h := newHarness(t)
	h.putFile(chatFixture, "rollout-chat.jsonl")
	h.poll()
	// Make the store look like an older importer wrote it.
	if _, err := h.out.Exec(`DELETE FROM events WHERE source='codex' AND kind IN ('turn.user','tool.post')`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.out.Exec(`UPDATE events SET payload = json_remove(payload, '$.tool_use_id') WHERE source='codex' AND kind='tool.pre'`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.out.Exec(`UPDATE events SET payload = json_set(payload, '$.tool_input', json_object('command', '{"command":["bash","-lc","go test ./internal/home/"],"workdir":"/Users/dev/proj"}')) WHERE source='codex' AND tool='shell'`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.out.Exec(`DELETE FROM meta WHERE k = ?`, store.MetaCodexChatBackfilled); err != nil {
		t.Fatal(err)
	}
	costBefore := count(t, h.out, `SELECT CAST(SUM(cost_usd)*1e6 AS INTEGER) FROM events WHERE source='codex'`)

	restarted := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
	if err := restarted.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.user'`); n != 2 {
		t.Fatalf("backfill stored %d prompts, want 2", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='tool.post'`); n != 4 {
		t.Fatalf("backfill stored %d results, want 4", n)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='tool.pre' AND COALESCE(json_extract(payload,'$.tool_use_id'),'') = ''`); n != 0 {
		t.Fatalf("%d calls left without their call id", n)
	}
	var cmd string
	if err := h.out.QueryRow(`SELECT json_extract(payload,'$.tool_input.command') FROM events WHERE kind='tool.pre' AND tool='shell'`).Scan(&cmd); err != nil {
		t.Fatal(err)
	}
	if cmd != "go test ./internal/home/" {
		t.Fatalf("the stored shell call kept its JSON input: %q", cmd)
	}
	if after := count(t, h.out, `SELECT CAST(SUM(cost_usd)*1e6 AS INTEGER) FROM events WHERE source='codex'`); after != costBefore {
		t.Fatalf("backfill changed cost: %d → %d", costBefore, after)
	}
	if done, _ := h.in.rec.Store.GetMeta(context.Background(), store.MetaCodexChatBackfilled); done != "1" {
		t.Fatalf("backfill not marked done: %q", done)
	}

	// Done means done.
	if _, err := h.out.Exec(`DELETE FROM events WHERE source='codex' AND kind='turn.user'`); err != nil {
		t.Fatal(err)
	}
	again := NewIngester(h.in.dirs, h.in.rec, h.in.log, time.Second)
	if err := again.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := count(t, h.out, `SELECT COUNT(*) FROM events WHERE source='codex' AND kind='turn.user'`); n != 0 {
		t.Fatalf("a finished backfill ran again and stored %d prompts", n)
	}
}
