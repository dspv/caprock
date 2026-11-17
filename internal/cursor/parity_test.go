package cursor

import (
	"math"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// gitChat is testdata/editor-chat-git.json: a chat shaped as Cursor 2.3.41
// writes one (the result, error and userDecision fields copied from the
// owner's state.vscdb, 2026-11-17; words, paths and ids invented). The
// picker says claude-4-sonnet, the bill says claude-4.1-opus-thinking — 4
// of the owner's 22 priced chats are this way — and no prompt but the Auto
// one names a model. It pushes a branch, opens a pull request, and has a
// failed edit, a failed command, a rejected command and a cancelled read.
const gitChat = "c0ffee00-0000-4000-8000-000000000003"

func (h *harness) restart() {
	h.in = NewIngester(h.in.db, h.path, "", h.in.rec, h.in.log, time.Second)
}

func TestTurnModelPrefersTheBill(t *testing.T) {
	one := Composer{Model: "claude-4-sonnet", Usage: map[string]ModelUsage{"claude-4.1-opus-thinking": {Requests: 7}}}
	two := Composer{Model: "gpt-5-fast", Usage: map[string]ModelUsage{"claude-4-sonnet": {}, "claude-4.1-opus-thinking": {}}}
	none := Composer{Model: "composer-1"}
	for _, c := range []struct {
		name         string
		c            Composer
		prompt       string
		model, where string
	}{
		{"the prompt's own model", one, "claude-4.5-sonnet-thinking", "claude-4.5-sonnet-thinking", "prompt"},
		{"no model on the prompt: the one billed", one, "", "claude-4.1-opus-thinking", "usage"},
		{"Auto: the one billed", one, "default", "claude-4.1-opus-thinking", "usage"},
		{"several billed: not known", two, "", "", "unknown"},
		{"several billed, Auto stays Auto", two, "default", "default", "prompt"},
		{"no bill: the picker", none, "", "composer-1", "picker"},
		{"no bill, no picker", Composer{}, "", "", "unknown"},
	} {
		if m, s := turnModel(c.c, c.prompt); m != c.model || s != c.where {
			t.Errorf("%s: %q %q, want %q %q", c.name, m, s, c.model, c.where)
		}
	}
	if m := sessionModel(two); m != "claude-4-sonnet" && m != "claude-4.1-opus-thinking" {
		t.Errorf("session model %q", m)
	}
}

// Every turn of a chat billed to one model is filed under it, the picker's
// model nowhere: the model mix, the Cost rows and the session's model are
// the one that ran.
func TestCursorTurnsCarryTheBilledModel(t *testing.T) {
	h := newHarness(t)
	h.loadFile(t, "editor-chat-git.json")
	h.once(t)
	if n := h.count(t, `model = 'claude-4-sonnet' OR json_extract(payload,'$.model') = 'claude-4-sonnet'`); n != 0 {
		t.Fatalf("%d rows carry the picker's model", n)
	}
	if n := h.count(t, `kind = 'turn.assistant' AND model = 'claude-4.1-opus-thinking'`); n != 2 {
		t.Fatalf("%d replies on the billed model, want 2", n)
	}
	if n := h.count(t, `kind = 'turn.user' AND json_extract(payload,'$.model_source') = 'usage'`); n != 2 {
		t.Fatalf("%d prompts with the model from the bill, want 2", n)
	}
	s, err := store.GetSession(h.ctx, h.st.DB(), gitChat)
	if err != nil {
		t.Fatal(err)
	}
	if s.Model != "claude-4.1-opus-thinking" {
		t.Fatalf("session model %q", s.Model)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_in) FROM events WHERE model = 'claude-4.1-opus-thinking'`); got != 52000+61000 {
		t.Fatalf("tokens on the billed model %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-1.20) > 1e-9 {
		t.Fatalf("cost %v, want Cursor's 1.20", got)
	}
}

// Cursor's own reading of the window rides on the prompt it was taken for,
// and the composer's latest on the chat's last finished reply.
func TestCursorContextReadingIsStored(t *testing.T) {
	h := newHarness(t)
	h.loadFile(t, "editor-chat-git.json")
	h.once(t)
	if got := h.scalar(t, `SELECT SUM(json_extract(payload,'$.context_tokens')) FROM events WHERE kind = 'turn.user'`); got != 41000+60000 {
		t.Fatalf("prompt readings %v", got)
	}
	r, ok, err := store.LastContextReading(h.ctx, h.st.DB(), gitChat)
	if err != nil || !ok {
		t.Fatalf("reading %v %v", ok, err)
	}
	if r.Tokens != 95756 || r.Window != 176000 || r.Model != "claude-4.1-opus-thinking" {
		t.Fatalf("last reading %+v, want the composer's 95756 of 176000", r)
	}
}

// Each finished call gets a result in Claude Code's shape: the terminal's
// output as stdout, so the push and the pull request are found; failures
// flagged; a cancelled call interrupted; a running call nothing yet.
func TestCursorToolResultsArePosted(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	h.once(t)
	if n := h.count(t, `kind = 'tool.post'`); n != 6 {
		t.Fatalf("%d results, want 6", n)
	}
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.is_error') = 1`); n != 3 {
		t.Fatalf("%d failed results, want the failed edit, the failed command and the rejected one", n)
	}
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.interrupted') = 1`); n != 1 {
		t.Fatalf("%d interrupted, want the cancelled read", n)
	}
	// Every result pairs with its call.
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.tool_use_id') NOT IN
		(SELECT json_extract(payload,'$.tool_use_id') FROM events WHERE kind = 'tool.pre')`); n != 0 {
		t.Fatalf("%d results pair with no call", n)
	}
	if n := h.count(t, `kind = 'tool.post' AND json_extract(payload,'$.tool_response') LIKE '%outputRaw%'`); n != 0 {
		t.Fatal("the terminal's raw copy was stored")
	}
	var msg string
	if err := h.st.DB().QueryRow(`SELECT json_extract(payload,'$.tool_response') FROM events WHERE key = 'cu-post:d0000004-0000-4000-8000-000000000000'`).Scan(&msg); err != nil || msg != "The string to replace was not found in the file." {
		t.Fatalf("failed edit's response %q %v", msg, err)
	}
	prs, err := store.SessionPRs(h.ctx, h.st.DB(), gitChat)
	if err != nil {
		t.Fatal(err)
	}
	if len(prs) != 1 || prs[0].Number != 14 || prs[0].Title != "Fix the sign-up link" {
		t.Fatalf("pull requests %+v", prs)
	}
	if got := h.scalar(t, `SELECT COUNT(*) FROM session_branches WHERE session_id = '`+gitChat+`' AND branch = 'fix/sign-up-link'`); got != 1 {
		t.Fatalf("pushed branch recorded %v times", got)
	}
	if got := h.scalar(t, `SELECT SUM(tool_bytes) FROM events WHERE kind = 'tool.post'`); got <= 0 {
		t.Fatal("result sizes not counted")
	}

	// A call still running has no result until it finishes.
	key := "bubbleId:" + gitChat + ":d0000009-0000-4000-8000-000000000000"
	if _, err := h.st.DB().Exec(`DELETE FROM events WHERE key = 'cu-post:d0000009-0000-4000-8000-000000000000'`); err != nil {
		t.Fatal(err)
	}
	b := rows[key]
	b["toolFormerData"].(map[string]any)["status"] = "loading"
	h.put(t, key, b)
	comp := rows["composerData:"+gitChat]
	comp["lastUpdatedAt"] = comp["lastUpdatedAt"].(float64) + 1000
	h.put(t, "composerData:"+gitChat, comp)
	h.once(t)
	if n := h.count(t, `key = 'cu-post:d0000009-0000-4000-8000-000000000000'`); n != 0 {
		t.Fatal("a running call has a result")
	}
}

// What an earlier version stored — every turn under the picker's model, no
// results, no readings — is corrected once on the next start: models
// re-filed with the usage moved along (the chat's totals unchanged, never
// counted twice), results and readings added, and a second start changes
// nothing.
func TestStoredCursorChatsAreRepairedOnce(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	key := "composerData:" + gitChat
	comp := rows[key]
	usage := comp["usageData"]
	// The earlier version: the picker's model on every turn. A chat with no
	// bill reads the picker today too, so that is how it is staged.
	delete(comp, "usageData")
	h.put(t, key, comp)
	h.once(t)
	if n := h.count(t, `kind = 'turn.assistant' AND model = 'claude-4-sonnet'`); n == 0 {
		t.Fatal("staging: no rows under the picker's model")
	}
	for _, q := range []string{
		`DELETE FROM events WHERE kind = 'tool.post'`,
		`DELETE FROM session_prs`,
		`DELETE FROM session_branches`,
		`UPDATE events SET payload = json_remove(payload, '$.context_tokens', '$.context_window', '$.tool_use_id', '$.model_source')`,
		`DELETE FROM meta WHERE k = '` + store.MetaCursorParityRepaired + `'`,
	} {
		if _, err := h.st.DB().Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	// Cursor's bill arrives; the chat itself has not moved, so a restart
	// would not read it again but for the repair.
	comp["usageData"] = usage
	h.put(t, key, comp)
	h.restart()
	h.once(t)

	if n := h.count(t, `model = 'claude-4-sonnet' OR json_extract(payload,'$.model') = 'claude-4-sonnet'`); n != 0 {
		t.Fatalf("%d rows still on the picker's model", n)
	}
	tokens := `SELECT SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)) FROM events`
	if got := h.scalar(t, tokens); got != 52000+800+61000+300 {
		t.Fatalf("tokens %v after the repair: counted twice or lost", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_in) FROM events WHERE model = 'claude-4.1-opus-thinking'`); got != 52000+61000 {
		t.Fatalf("tokens on the billed model %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-1.20) > 1e-9 {
		t.Fatalf("cost %v", got)
	}
	// The rollups agree with the rows.
	if got := h.scalar(t, `SELECT tokens_in + tokens_out FROM session_stats WHERE session_id = '`+gitChat+`'`); got != 52000+800+61000+300 {
		t.Fatalf("session_stats tokens %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_total) FROM daily_stats WHERE model = 'claude-4-sonnet'`); got != 0 {
		t.Fatalf("daily_stats keeps %v tokens under the picker's model", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_total) FROM daily_stats`); got != 52000+800+61000+300 {
		t.Fatalf("daily_stats tokens %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM daily_stats`); math.Abs(got-1.20) > 1e-9 {
		t.Fatalf("daily_stats cost %v", got)
	}
	if got := h.scalar(t, `SELECT turns FROM session_stats WHERE session_id = '`+gitChat+`'`); got != float64(h.count(t, `kind = 'turn.assistant'`)) {
		t.Fatalf("session_stats turns %v", got)
	}
	if n := h.count(t, `kind = 'tool.post'`); n != 6 {
		t.Fatalf("%d results after the repair", n)
	}
	if n := h.count(t, `kind = 'tool.pre' AND json_extract(payload,'$.tool_use_id') IS NULL`); n != 0 {
		t.Fatalf("%d calls with nothing to pair a result with", n)
	}
	if n := h.count(t, `kind = 'turn.user' AND json_extract(payload,'$.context_tokens') > 0`); n != 2 {
		t.Fatalf("%d prompts with a reading", n)
	}
	prs, _ := store.SessionPRs(h.ctx, h.st.DB(), gitChat)
	if len(prs) != 1 {
		t.Fatalf("pull requests %+v", prs)
	}
	if s, _ := store.GetSession(h.ctx, h.st.DB(), gitChat); s.Model != "claude-4.1-opus-thinking" {
		t.Fatalf("session model %q", s.Model)
	}

	// Once: another start leaves every row as it is.
	type snap struct{ n, ids, tok float64 }
	take := func() snap {
		return snap{float64(h.count(t, `1`)), h.scalar(t, `SELECT SUM(id) FROM events`), h.scalar(t, tokens)}
	}
	before := take()
	h.restart()
	h.once(t)
	if after := take(); after != before {
		t.Fatalf("a second start changed the store: %+v → %+v", before, after)
	}
}

// A chat billed to several models, whose turns name none, files its tokens
// under no model — and keeps them through the repair: "" is a model the
// reconciliation carries like any other (it lost 7.5M tokens of one real
// chat until it did).
func TestTokensOfAnUnknownModelSurviveTheRepair(t *testing.T) {
	h := newHarness(t)
	rows := h.loadFile(t, "editor-chat-git.json")
	key := "composerData:" + gitChat
	comp := rows[key]
	delete(comp, "usageData")
	h.put(t, key, comp)
	h.once(t)
	if _, err := h.st.DB().Exec(`DELETE FROM meta WHERE k = '` + store.MetaCursorParityRepaired + `'`); err != nil {
		t.Fatal(err)
	}
	comp["usageData"] = map[string]any{
		"claude-4-sonnet":          map[string]any{"costInCents": 40, "amount": 3},
		"claude-4.1-opus-thinking": map[string]any{"costInCents": 120, "amount": 7},
	}
	// The Auto prompt names no model the bill can settle either.
	auto := "bubbleId:" + gitChat + ":d0000008-0000-4000-8000-000000000000"
	b := rows[auto]
	delete(b, "modelInfo")
	h.put(t, auto, b)
	h.put(t, key, comp)
	h.restart()
	h.once(t)
	if got := h.scalar(t, `SELECT SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)) FROM events WHERE COALESCE(model,'') = ''`); got != 52000+800+61000+300 {
		t.Fatalf("tokens under no model %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(cost_usd) FROM events`); math.Abs(got-1.60) > 1e-9 {
		t.Fatalf("cost %v", got)
	}
	if got := h.scalar(t, `SELECT SUM(tokens_total) FROM daily_stats`); got != 52000+800+61000+300 {
		t.Fatalf("daily_stats tokens %v", got)
	}
}
