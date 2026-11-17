package cursor

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// bubbleKey is the bubbleId row of gitChat's message n (1-10).
func bubbleKey(n int) string {
	return "bubbleId:" + gitChat + ":" + msgID10(n)
}

func msgID10(n int) string {
	ids := map[int]string{
		1: "d0000001", 2: "d0000002", 3: "d0000003", 4: "d0000004", 5: "d0000005",
		6: "d0000006", 7: "d0000007", 8: "d0000008", 9: "d0000009", 10: "d0000010",
	}
	return ids[n] + "-0000-4000-8000-000000000000"
}

// Item 6: a turn ends at the next prompt, and the newest one when Cursor
// says the chat stopped — an agent.stop like Claude Code's Stop hook, so Now
// reads "done" or "waiting for you" rather than going by the clock. Item 9:
// the stop carries the turn's timings where Cursor recorded them.
func TestCursorTurnsEndWithAStop(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	// Cursor's own timings on the first turn's reply and a thought.
	r7 := rows[bubbleKey(7)]
	r7["timingInfo"] = map[string]any{"clientStartTime": 90177300.2, "clientRpcSendTime": 1762509601000.0, "clientEndTime": 1762509625000.0}
	h.put(t, bubbleKey(7), r7)
	r3 := rows[bubbleKey(3)]
	r3["thinkingDurationMs"] = 1992
	h.put(t, bubbleKey(3), r3)
	// The chat is still writing its last turn.
	comp := rows["composerData:"+gitChat]
	comp["generatingBubbleIds"] = []string{"d0000010-0000-4000-8000-000000000000"}
	comp["status"] = "generating"
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)

	if n := h.count(t, `kind = 'agent.stop'`); n != 1 {
		t.Fatalf("%d stops while the last turn runs, want the first turn's only", n)
	}
	var ts int64
	var payload string
	if err := h.st.DB().QueryRow(`SELECT ts, payload FROM events WHERE key = 'cu-stop:`+gitChat+`:`+msgID10(1)+`'`).Scan(&ts, &payload); err != nil {
		t.Fatal(err)
	}
	prompt2 := time.Date(2025, 11, 7, 10, 5, 0, 0, time.UTC).UnixMilli()
	if ts >= prompt2 {
		t.Errorf("the first turn's stop at %d, after the next prompt %d", ts, prompt2)
	}
	var p map[string]any
	_ = json.Unmarshal([]byte(payload), &p)
	if p["duration_ms"] != 24000.0 || p["request_ms"] != 24000.0 || p["thinking_ms"] != 1992.0 || p["stop_reason"] != "next_prompt" {
		t.Errorf("stop payload %v", p)
	}

	// Cursor finishes: the newest turn ends too, once.
	comp["generatingBubbleIds"] = []string{}
	comp["status"] = "completed"
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 1000
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)
	h.once(t)
	if n := h.count(t, `kind = 'agent.stop'`); n != 2 {
		t.Fatalf("%d stops after the chat finished", n)
	}
	var last string
	if err := h.st.DB().QueryRow(`SELECT kind FROM events WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) ORDER BY ts DESC, id DESC LIMIT 1`, gitChat).Scan(&last); err != nil || last != "agent.stop" {
		t.Errorf("the session's newest event is %q %v, want its turn's end", last, err)
	}
}

// Item 5: a summary Cursor wrote to make room is a compaction, measured by
// the prompts' readings either side; it is never priced from the table.
func TestCursorSummaryIsACompaction(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	r5 := rows[bubbleKey(5)]
	r5["conversationSummary"] = `{"summary":"Summary: pushed the branch.","truncationLastBubbleIdInclusive":"d0000004-0000-4000-8000-000000000000"}`
	h.put(t, bubbleKey(5), r5)
	// A summary in the newest turn of a chat still running waits for the
	// next prompt, which measures what it kept.
	r9 := rows[bubbleKey(9)]
	r9["conversationSummary"] = map[string]any{"summary": "later", "truncationLastBubbleIdInclusive": "d0000008-0000-4000-8000-000000000000"}
	h.put(t, bubbleKey(9), r9)
	comp := rows["composerData:"+gitChat]
	comp["status"] = "generating"
	comp["generatingBubbleIds"] = []string{"x"}
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)

	if n := h.count(t, `kind = 'context.compacted'`); n != 1 {
		t.Fatalf("%d compactions, want the first turn's", n)
	}
	last, ok, err := store.LastCompaction(h.ctx, h.st.DB(), gitChat)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if last.Trigger != "auto" || last.PreTokens != 41000 || last.PostTokens != 60000 {
		t.Errorf("compaction %+v", last)
	}
	if _, err := store.AddCompactionBoundaries(h.ctx, h.st.DB()); err != nil {
		t.Fatal(err)
	}
	if n := h.scalar(t, `SELECT COUNT(*) FROM compaction_stats`); n != 0 {
		t.Errorf("%v Cursor compactions given a table-priced estimate", n)
	}
	// The chat stops: the last summary is recorded without a reading after.
	comp["status"] = "completed"
	comp["generatingBubbleIds"] = []string{}
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 1000
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)
	if n := h.count(t, `kind = 'context.compacted'`); n != 2 {
		t.Fatalf("%d compactions after the chat stopped", n)
	}
	if n := h.count(t, `kind = 'context.compacted' AND json_extract(payload,'$.post_tokens') IS NOT NULL AND key = 'cu-compact:`+msgID10(9)+`'`); n != 0 {
		t.Error("a reading after the summary was invented")
	}
}

// Item 7: a chat in the format before fullConversationHeadersOnly keeps its
// messages inline and its tool calls in its capabilities; they are read as
// any chat's, not only its cost.
func TestCursorLegacyChatIsRead(t *testing.T) {
	h := newHarness(t)
	const chat = "c0ffee00-0000-4000-8000-0000000000aa"
	tools, _ := json.Marshal(map[string]any{
		"b2": map[string]any{"tool": 15, "toolCallId": "tool_l2", "status": "completed", "name": "edit_file",
			"rawArgs": `{"target_file": "kgpu/src/main.jsx", "code_edit": "x"}`, "result": `{"diff": {}}`},
	})
	h.put(t, "composerData:"+chat, map[string]any{
		"_v": 1, "composerId": chat, "name": "Old chat", "createdAt": 1747724990124.0, "lastUpdatedAt": 1747727340872.0,
		"status": "completed", "unifiedMode": "agent",
		"usageData": map[string]any{"claude-4-sonnet": map[string]any{"costInCents": 2, "amount": 8}},
		"conversation": []any{
			map[string]any{"_v": 1, "type": 1, "bubbleId": "b1", "text": "look at the project", "tokenCount": map[string]any{"inputTokens": 0, "outputTokens": 0}},
			map[string]any{"_v": 1, "type": 2, "bubbleId": "b2", "text": "", "capabilityType": 15,
				"timingInfo": map[string]any{"clientRpcSendTime": 1747725270354.0, "clientEndTime": 1747725319365.0}},
			map[string]any{"_v": 1, "type": 2, "bubbleId": "b3", "text": "It is a React app.", "tokenCount": map[string]any{"inputTokens": 5063, "outputTokens": 951}},
		},
		"capabilities": []any{map[string]any{"type": 15, "data": map[string]any{"bubbleDataMap": string(tools)}}},
	})
	// The folder Cursor's legacy rows give: the chat's terminal is unknown,
	// so the tool's relative path is resolved where the session is.
	h.once(t)
	for kind, want := range map[string]int{"turn.user": 1, "tool.pre": 1, "tool.post": 1, "agent.stop": 1} {
		if n := h.count(t, `kind = '`+kind+`' AND sid = (SELECT sid FROM sessions WHERE session_id = '`+chat+`')`); n != want {
			t.Errorf("%s: %d, want %d", kind, n, want)
		}
	}
	if n := h.count(t, `kind = 'tool.pre' AND tool = 'Edit'`); n != 1 {
		t.Error("the legacy edit_file is not an Edit")
	}
	// Dated by the request's timing, the prompt by the reply that follows.
	var ts int64
	if err := h.st.DB().QueryRow(`SELECT ts FROM events WHERE key = 'cu-user:b1'`).Scan(&ts); err != nil || ts != 1747725270354 {
		t.Errorf("prompt dated %d %v", ts, err)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-0.02) > 1e-9 {
		t.Errorf("cost %v, want Cursor's 2 cents", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_in) FROM events`); got != 5063 {
		t.Errorf("tokens %v", got)
	}
}

// Item 8: Cursor's newer edit tools are Edits, an MCP call is spelled as
// Claude Code spells one, and a relative path that repeats the folder's own
// name is not filed a folder too deep.
func TestCursorToolNamesAndPaths(t *testing.T) {
	for in, want := range map[string]string{"edit_file_v2_search_replace": "Edit", "reapply": "Edit", "edit_file_v2_write": "Write"} {
		if got := ToolName(in); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
	var b Bubble
	b.setTool(&rawTool{Name: "mcp_cursor-browser-extension_browser_navigate", RawArgs: `{"url":"https://example.com"}`,
		Additional: json.RawMessage(`{"status":"success","reviewData":{"approvalType":"full_auto","toolName":"browser_navigate","serverId":"cursor-browser-extension"}}`)})
	if got := callName(b.Tool); got != "mcp__cursor-browser-extension__browser_navigate" {
		t.Errorf("mcp call named %q", got)
	}
	b = Bubble{}
	b.setTool(&rawTool{Name: "mcp", Params: `{"tools":[{"name":"browser_wait_for","serverName":"cursor-browser-extension"}]}`})
	if got := callName(b.Tool); got != "mcp__cursor-browser-extension__browser_wait_for" {
		t.Errorf("bare mcp call named %q", got)
	}
	b = Bubble{}
	b.setTool(&rawTool{Name: "mcp_some_server_tool"})
	if got := callName(b.Tool); got != "mcp_some_server_tool" {
		t.Errorf("an MCP call with no server recorded was renamed to %q", got)
	}

	saved := osStat
	t.Cleanup(func() { osStat = saved })
	osStat = func(string) (os.FileInfo, error) { return nil, errors.New("absent") }
	for _, c := range []struct{ p, cwd, want string }{
		{"kgpu/src/main.jsx", "/Users/x/dev/kgpu", "/Users/x/dev/kgpu/src/main.jsx"},
		{"./kgpu/src/main.jsx", "/Users/x/dev/kgpu", "/Users/x/dev/kgpu/src/main.jsx"},
		{"src/main.jsx", "/Users/x/dev/kgpu", "/Users/x/dev/kgpu/src/main.jsx"},
		{"kgpu", "/Users/x/dev/kgpu", "/Users/x/dev/kgpu/kgpu"},
		{"/abs/file.go", "/Users/x/dev/kgpu", "/abs/file.go"},
	} {
		if got := absolute(c.p, c.cwd); got != c.want {
			t.Errorf("absolute(%q, %q) = %q, want %q", c.p, c.cwd, got, c.want)
		}
	}
	// A folder that really holds a subfolder of its own name keeps it.
	osStat = func(string) (os.FileInfo, error) { return nil, nil }
	if got := absolute("kgpu/main.go", "/Users/x/dev/kgpu"); got != "/Users/x/dev/kgpu/kgpu/main.go" {
		t.Errorf("a real kgpu/kgpu folder lost: %q", got)
	}
}

// Item 11: the mode Cursor recorded — plan or ask from the chat, auto-run
// or asked from each terminal command — is the session's permission mode,
// and the person's answer to a call is on its result.
func TestCursorModeAndDecisions(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	// The newest command (bubble 6, rejected) ran under auto-run after all.
	r6 := rows[bubbleKey(6)]
	tf := r6["toolFormerData"].(map[string]any)
	tf["additionalData"] = map[string]any{"status": "success", "reviewData": map[string]any{"approvalType": "full_auto"}}
	h.put(t, bubbleKey(6), r6)
	h.once(t)
	mode, err := store.LastPermissionMode(h.ctx, h.st.DB(), gitChat)
	if err != nil || mode != ModeAutoRun {
		t.Fatalf("mode %q %v, want auto-run from the newest command", mode, err)
	}
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.user_decision') = 'rejected'`); n == 0 {
		t.Error("the rejected command's decision is not on its result")
	}

	// A plan chat says so on its prompts.
	h2 := newHarness(t)
	rows = h2.loadFile(t, "editor-chat.json")
	for k, v := range rows {
		if len(k) > 13 && k[:13] == "composerData:" {
			v["unifiedMode"] = "plan"
			h2.put(t, k, v)
			h2.once(t)
			mode, _ := store.LastPermissionMode(h2.ctx, h2.st.DB(), k[13:])
			if mode != "plan" {
				t.Errorf("plan chat's mode %q", mode)
			}
		}
	}
}

// The overhead estimate is recorded for a chat whose first turn's model
// Cursor did not record, as an unnamed model, rather than dropped.
func TestCursorOverheadWithoutAModel(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	comp := rows["composerData:"+gitChat]
	comp["usageData"] = map[string]any{
		"claude-4.1-opus-thinking": map[string]any{"costInCents": 100, "amount": 5},
		"gpt-5":                    map[string]any{"costInCents": 20, "amount": 2},
	}
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)
	if n := h.count(t, `kind = 'context.overhead' AND COALESCE(model,'') = ''`); n != 1 {
		t.Fatalf("%d overhead rows for a chat billed to two models", n)
	}
}

// Part 2's repair: chats stored before compactions, turn ends, MCP names,
// fixed paths and modes are read again once — the new rows added, the old
// ones corrected in place, nothing counted twice, totals unchanged.
func TestStoredCursorChatsGainPart2Once(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	r5 := rows[bubbleKey(5)]
	r5["conversationSummary"] = `{"summary":"s","truncationLastBubbleIdInclusive":"d0000004-0000-4000-8000-000000000000"}`
	h.put(t, bubbleKey(5), r5)
	// The chat's folder, from Cursor's terminal.
	r2 := rows[bubbleKey(2)]
	r2["lastTerminalCwd"] = "/work/site"
	h.put(t, bubbleKey(2), r2)
	h.once(t)
	before := map[string]float64{}
	for _, q := range []string{
		`SELECT SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) FROM events`,
		`SELECT SUM(cost_usd) FROM events`,
		`SELECT tokens_in + tokens_out FROM session_stats`,
		`SELECT SUM(tokens_total) FROM daily_stats`,
		`SELECT COUNT(*) FROM events`,
	} {
		before[q] = h.scalar(t, q)
	}
	// What the reader before part 2 left: no stops, no compactions, no
	// modes or decisions.
	for _, q := range []string{
		`DELETE FROM events WHERE kind IN ('agent.stop','context.compacted')`,
		`UPDATE events SET payload = json_remove(payload, '$.permission_mode', '$.user_decision')`,
		`DELETE FROM meta WHERE k = '` + store.MetaCursorParity2Repaired + `'`,
		// The relative path filed a folder too deep, as before the fix.
		`UPDATE events SET payload = json_set(payload, '$.tool_input.file_path', '/work/site/site/app/page.tsx') WHERE key = 'cu-tool:` + msgID10(4) + `'`,
		`UPDATE session_files SET path = '/work/site/site/app/page.tsx' WHERE path = '/work/site/app/page.tsx'`,
	} {
		if _, err := h.st.DB().Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if n := h.count(t, `json_extract(payload,'$.tool_input.file_path') = '/work/site/site/app/page.tsx'`); n != 1 {
		t.Fatalf("staging: %d rows under the doubled folder", n)
	}
	h.restart()
	h.once(t)
	h.restart()
	h.once(t)
	for q, v := range before {
		if got := h.scalar(t, q); got != v {
			t.Errorf("%s: %v after the repair, %v before", q, got, v)
		}
	}
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.user_decision') IS NOT NULL`); n == 0 {
		t.Error("decisions not added to stored results")
	}
	if n := h.count(t, `json_extract(payload,'$.tool_input.file_path') = '/work/site/site/app/page.tsx'`); n != 0 {
		t.Errorf("%d rows still under the doubled folder", n)
	}
	if got := h.scalar(t, `SELECT COUNT(*) FROM session_files WHERE path = '/work/site/app/page.tsx'`); got != 1 {
		t.Errorf("touched file not moved: %v", got)
	}
	if got := h.scalar(t, `SELECT COUNT(*) FROM session_files WHERE path LIKE '%/site/site/%'`); got != 0 {
		t.Errorf("doubled folder still a touched file")
	}
	if done, _ := h.st.GetMeta(h.ctx, store.MetaCursorParity2Repaired); done != "1" {
		t.Error("the repair is not marked done")
	}
}
