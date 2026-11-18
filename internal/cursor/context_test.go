package cursor

import (
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// shareChat is a chat shaped as Cursor's November 2025 builds write one on
// composer-1 or Auto: every prompt's contextWindowStatusAtCreation holds
// percentageRemaining and percentageRemainingFloat only, and the composer
// contextUsagePercent only — no tokensUsed, tokenLimit, contextTokensUsed or
// contextTokenLimit (read on the owner's machine, 2026-11-18; every value
// here is invented).
const shareChat = "c0ffee00-0000-4000-8000-0000000000c1"

func shareComposer(status string, generating []string, usage any) map[string]any {
	c := map[string]any{
		"_v": 10, "composerId": shareChat, "name": "Tidy the router",
		"createdAt": 1762400000000, "lastUpdatedAt": 1762400060000,
		"modelConfig": map[string]any{"modelName": "composer-1", "maxMode": true},
		"unifiedMode": "agent", "status": status,
		"generatingBubbleIds": generating,
		"fullConversationHeadersOnly": []map[string]any{
			{"bubbleId": "p1", "type": 1}, {"bubbleId": "r1", "type": 2},
			{"bubbleId": "p2", "type": 1}, {"bubbleId": "r2", "type": 2},
		},
	}
	if usage != nil {
		c["contextUsagePercent"] = usage
	}
	return c
}

func (h *harness) putShareBubbles(t *testing.T) {
	t.Helper()
	for _, b := range []map[string]any{
		{"bubbleId": "p1", "type": 1, "text": "tidy the router", "createdAt": 1762400000000,
			"modelInfo":                     map[string]any{"modelName": "composer-1"},
			"contextWindowStatusAtCreation": map[string]any{"percentageRemaining": 88, "percentageRemainingFloat": 88.5}},
		{"bubbleId": "r1", "type": 2, "text": "done", "createdAt": 1762400010000,
			"tokenCount": map[string]any{"inputTokens": 30000, "outputTokens": 200}},
		{"bubbleId": "p2", "type": 1, "text": "and the tests", "createdAt": 1762400020000,
			"modelInfo":                     map[string]any{"modelName": "composer-1"},
			"contextWindowStatusAtCreation": map[string]any{"percentageRemaining": 64, "percentageRemainingFloat": 64.25}},
		{"bubbleId": "r2", "type": 2, "text": "tests pass", "createdAt": 1762400030000,
			"tokenCount": map[string]any{"inputTokens": 52000, "outputTokens": 300}},
	} {
		h.put(t, "bubbleId:"+shareChat+":"+b["bubbleId"].(string), b)
	}
}

// A reading that is a share of the window alone is kept as one: each prompt
// carries 100 minus its percentageRemainingFloat, the last finished reply
// the composer's contextUsagePercent, and neither gains a token count made
// up from the turns' tokens.
func TestCursorShareReadingIsStored(t *testing.T) {
	h := newHarness(t)
	h.put(t, "composerData:"+shareChat, shareComposer("completed", []string{}, 41.5))
	h.putShareBubbles(t)
	h.once(t)

	if got := h.scalar(t, `SELECT json_extract(payload,'$.context_pct') FROM events WHERE key = 'cu-user:p2'`); got != 35.75 {
		t.Fatalf("second prompt's share %v, want 100 - 64.25", got)
	}
	if n := h.count(t, `json_extract(payload,'$.context_tokens') IS NOT NULL OR json_extract(payload,'$.context_window') IS NOT NULL`); n != 0 {
		t.Fatalf("%d rows carry a token reading Cursor never wrote", n)
	}
	r, ok, err := store.LastContextReading(h.ctx, h.st.DB(), shareChat)
	if err != nil || !ok {
		t.Fatalf("reading %v %v", ok, err)
	}
	if !r.HasPct || r.Pct != 41.5 || r.Tokens != 0 || r.Window != 0 {
		t.Fatalf("last reading %+v, want the composer's 41.5%% and no tokens", r)
	}
}

// A live chat's last reply is stored while Cursor writes it, before the
// composer has a reading; the reading lands on that row once Cursor stops,
// and moves when Cursor measures again.
func TestCursorReadingReachesAStoredReply(t *testing.T) {
	h := newHarness(t)
	h.put(t, "composerData:"+shareChat, shareComposer("generating", []string{"r2"}, nil))
	h.putShareBubbles(t)
	h.once(t)
	if r, _, _ := store.LastContextReading(h.ctx, h.st.DB(), shareChat); r.Pct != 35.75 {
		t.Fatalf("while writing: %+v, want the last prompt's 35.75%%", r)
	}

	if _, err := h.w.Exec(`DELETE FROM cursorDiskKV WHERE key = ?`, "composerData:"+shareChat); err != nil {
		t.Fatal(err)
	}
	h.put(t, "composerData:"+shareChat, shareComposer("completed", []string{}, 47.0))
	h.once(t)
	if r, _, _ := store.LastContextReading(h.ctx, h.st.DB(), shareChat); r.Pct != 47 {
		t.Fatalf("after the reply: %+v, want the composer's 47%%", r)
	}
	if n := h.count(t, `key = 'cu-msg:r2'`); n != 1 {
		t.Fatalf("%d rows for the last reply", n)
	}
}

// Chats stored before the reader kept shares gain them on the first start
// that has it (MetaCursorContextPctRepaired), though nothing in Cursor moved.
func TestCursorShareReadingIsRepaired(t *testing.T) {
	h := newHarness(t)
	h.put(t, "composerData:"+shareChat, shareComposer("completed", []string{}, 41.5))
	h.putShareBubbles(t)
	h.once(t)
	for _, q := range []string{
		`UPDATE events SET payload = json_remove(payload, '$.context_pct')`,
		`DELETE FROM meta WHERE k = '` + store.MetaCursorContextPctRepaired + `'`,
	} {
		if _, err := h.st.DB().Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := store.LastContextReading(h.ctx, h.st.DB(), shareChat); ok {
		t.Fatal("staging: a reading is left")
	}
	h.restart()
	h.once(t)
	r, ok, err := store.LastContextReading(h.ctx, h.st.DB(), shareChat)
	if err != nil || !ok || r.Pct != 41.5 {
		t.Fatalf("after the repair: %+v %v %v", r, ok, err)
	}
	if n := h.count(t, `kind = 'turn.user' AND json_extract(payload,'$.context_pct') IS NOT NULL`); n != 2 {
		t.Fatalf("%d prompts with a share after the repair", n)
	}
}

// A chat stopped after a prompt with no words and a reply with none keeps
// Cursor's last measure on its newest stored reply, not an older prompt's.
func TestCursorReadingAfterAWordlessEnd(t *testing.T) {
	h := newHarness(t)
	c := shareComposer("aborted", []string{}, 95.7)
	c["fullConversationHeadersOnly"] = []map[string]any{
		{"bubbleId": "p1", "type": 1}, {"bubbleId": "r1", "type": 2},
		{"bubbleId": "p2", "type": 1}, {"bubbleId": "r2", "type": 2},
		{"bubbleId": "p3", "type": 1}, {"bubbleId": "r3", "type": 2},
	}
	h.put(t, "composerData:"+shareChat, c)
	h.putShareBubbles(t)
	h.put(t, "bubbleId:"+shareChat+":p3", map[string]any{"bubbleId": "p3", "type": 1, "text": "", "createdAt": 1762400040000,
		"contextWindowStatusAtCreation": map[string]any{"percentageRemaining": 4, "percentageRemainingFloat": 4.5}})
	h.put(t, "bubbleId:"+shareChat+":r3", map[string]any{"bubbleId": "r3", "type": 2, "text": "", "createdAt": 1762400041000})
	h.once(t)
	r, ok, err := store.LastContextReading(h.ctx, h.st.DB(), shareChat)
	if err != nil || !ok || r.Pct != 95.7 {
		t.Fatalf("reading %+v %v %v, want the composer's 95.7%%", r, ok, err)
	}
}

func TestFillPct(t *testing.T) {
	for _, c := range []struct {
		used, limit int64
		pct         float64
		want        float64
		ok          bool
	}{
		{88000, 176000, -1, 50, true}, // tokens win
		{88000, 176000, 70, 50, true}, // over any share
		{0, 0, 41.5, 41.5, true},      // a share alone
		{0, 0, 0, 0, true},            // an empty window is a reading
		{0, 0, -1, 0, false},          // nothing
		{88000, 0, -1, 0, false},      // tokens with no window: no share
		{0, 0, 100.4, 100, true},      // clipped
	} {
		got, ok := fillPct(c.used, c.limit, c.pct)
		if got != c.want || ok != c.ok {
			t.Errorf("fillPct(%d, %d, %v) = %v %v, want %v %v", c.used, c.limit, c.pct, got, ok, c.want, c.ok)
		}
	}
}
