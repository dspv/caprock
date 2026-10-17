package chatimport

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The fixtures are synthetic: written for these tests in the shapes the
// exports carry (OQ-22), with no one's real conversations in them.
func fixture(name string) string {
	return filepath.Join("..", "..", "testdata", "chatimport", name, "conversations.json")
}

func readAll(t *testing.T, p string) []Conversation {
	t.Helper()
	var out []Conversation
	if err := File(p, func(c Conversation) error { out = append(out, c); return nil }); err != nil {
		t.Fatal(err)
	}
	return out
}

func texts(c Conversation) []string {
	var out []string
	for _, m := range c.Messages {
		out = append(out, m.Role+": "+m.Text)
	}
	return out
}

func TestClaudeExportReadsTheShownBranch(t *testing.T) {
	cs := readAll(t, fixture("claude-ai"))
	if len(cs) != 3 {
		t.Fatalf("conversations: %d", len(cs))
	}
	c := cs[0]
	if c.Source != SourceClaudeAI || c.ID != "0b6c1d2e-0000-4000-8000-000000000001" || c.Title != "Sourdough starter schedule" {
		t.Fatalf("conversation: %+v", c)
	}
	want := []string{
		"user: How often should I feed a <new> sourdough starter?",
		"assistant: Once or twice a day at room temperature.",
		"user: Thanks, here is my schedule.\n[Attached: schedule.txt]",
	}
	if got := texts(c); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("messages:\n got %q\nwant %q", got, want)
	}
	if !c.Created.Equal(time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("created: %v", c.Created)
	}
	// No links and no leaf: read in the export's own order.
	if got := texts(cs[1]); len(got) != 2 || !strings.Contains(got[1], "καλημέρα") {
		t.Fatalf("second: %q", got)
	}
	if len(cs[2].Messages) != 0 {
		t.Fatalf("empty: %+v", cs[2])
	}
}

func TestChatGPTExportFollowsCurrentNode(t *testing.T) {
	cs := readAll(t, fixture("chatgpt"))
	if len(cs) != 1 {
		t.Fatalf("conversations: %d", len(cs))
	}
	c := cs[0]
	if c.Source != SourceChatGPT || c.ID != "6795a000-0000-4000-8000-0000000000c1" || c.Title != "Packing list for a hike" {
		t.Fatalf("conversation: %+v", c)
	}
	want := []string{
		"user: What should I pack for a day hike?",
		"assistant: Water, snacks, a map and a rain layer.",
		"user: [Image]\n\nIs this trail too steep?",
		"assistant: It looks moderate; take poles.",
	}
	if got := texts(c); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("messages:\n got %q\nwant %q", got, want)
	}
	if c.Model != "gpt-test-2" {
		t.Fatalf("model: %q", c.Model)
	}
	if c.Messages[0].At.Unix() != 1767261600 {
		t.Fatalf("time: %v", c.Messages[0].At)
	}
}

func TestAZipIsReadForItsConversationsJSON(t *testing.T) {
	src, err := os.ReadFile(fixture("chatgpt"))
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "export.zip")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range map[string][]byte{
		"user.json":                     []byte(`{"id":"user-test"}`),
		"stale/conversations.json":      []byte(`[]`),
		"conversations.json":            src,
		"file-test.png":                 {0x89, 'P', 'N', 'G'},
		"message_feedback.json":         []byte(`[]`),
		"shared_conversations.json":     []byte(`[]`),
		"chat.html":                     []byte(`<html></html>`),
		"dalle-generations/file-x.webp": {0},
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if cs := readAll(t, p); len(cs) != 1 || len(cs[0].Messages) != 4 {
		t.Fatalf("zip: %+v", cs)
	}
}

func TestSomethingElseIsRefused(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"object.json": `{"hello": 1}`,
		"array.json":  `[{"hello": 1}]`,
		"text.json":   `not json`,
	} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := File(p, func(Conversation) error { return nil }); !errors.Is(err, ErrNotExport) {
			t.Errorf("%s: %v", name, err)
		}
	}
	p := filepath.Join(dir, "empty.zip")
	f, _ := os.Create(p)
	zw := zip.NewWriter(f)
	_, _ = zw.Create("user.json")
	_ = zw.Close()
	_ = f.Close()
	if err := File(p, func(Conversation) error { return nil }); !errors.Is(err, ErrNotExport) {
		t.Errorf("zip without conversations: %v", err)
	}
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestImportFilesReadOnlyChatsAndDedupes(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	res, err := Import(ctx, st, fixture("claude-ai"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 2 || res.Empty != 1 || res.Messages != 5 || res.Conversations != 2 || res.Sources[SourceClaudeAI] != 2 {
		t.Fatalf("first import: %+v", res)
	}
	id := SessionID(SourceClaudeAI, "0b6c1d2e-0000-4000-8000-000000000001")
	s, err := store.GetSession(ctx, st.DB(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Chat || s.Agent != SourceClaudeAI || s.Status != store.StatusEnded || s.Owned || s.Title != "Sourdough starter schedule" ||
		s.NativeID != "0b6c1d2e-0000-4000-8000-000000000001" || s.Cwd != "" {
		t.Fatalf("session: %+v", s)
	}
	if s.WorkedAt != time.Date(2026, 3, 2, 9, 5, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("worked_at: %d", s.WorkedAt)
	}

	// Again: the same rows, nothing added.
	res, err = Import(ctx, st, fixture("claude-ai"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Added != 0 || res.Unchanged != 2 || res.Messages != 0 {
		t.Fatalf("second import: %+v", res)
	}

	// Searchable with the chat search, prompts verbatim ("<" unescaped).
	for _, q := range []string{"<new> sourdough", "καλημέρα", "Sourdough starter"} {
		list, err := store.ListSessionsQuery(ctx, st.DB(), store.SessionQuery{Search: q, Chats: store.ChatsOnly}, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(list) != 1 {
			t.Errorf("search %q: %d", q, len(list))
		}
	}

	// Counted by nothing: no daily row, no activity, no stats.
	var daily, counted int
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM daily_stats`).Scan(&daily)
	_ = st.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM events WHERE internal = 0`).Scan(&counted)
	if daily != 0 || counted != 0 {
		t.Fatalf("daily rows %d, counted events %d", daily, counted)
	}
	stats, err := store.GetStats(ctx, st.DB(), id)
	if err != nil || stats.Turns != 0 || stats.CostUSD != 0 {
		t.Fatalf("stats: %+v %v", stats, err)
	}

	// The conversation view reads every message, in order.
	evs, err := store.EventsBefore(ctx, st.DB(), id, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 3 || evs[0].Kind != "turn.user" || evs[1].Kind != "turn.assistant" {
		t.Fatalf("events: %+v", evs)
	}
	var p map[string]any
	_ = json.Unmarshal(evs[1].Payload, &p)
	if p["text"] != "Once or twice a day at room temperature." || p["imported_from"] != SourceClaudeAI {
		t.Fatalf("payload: %s", evs[1].Payload)
	}
}

func TestReimportAddsNewMessagesAndKeepsDeletedChatsDeleted(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	dir := t.TempDir()
	write := func(convs []map[string]any) string {
		b, _ := json.Marshal(convs)
		p := filepath.Join(dir, "conversations.json")
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	msg := func(id, sender, text, at string) map[string]any {
		return map[string]any{"uuid": id, "sender": sender, "text": text, "created_at": at}
	}
	conv := func(id string, msgs ...map[string]any) map[string]any {
		return map[string]any{"uuid": id, "name": "t " + id, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:10:00Z", "chat_messages": msgs}
	}
	p := write([]map[string]any{
		conv("a", msg("a1", "human", "first", "2026-01-01T00:00:00Z"), msg("a2", "assistant", "reply", "2026-01-01T00:01:00Z")),
		conv("b", msg("b1", "human", "other", "2026-01-01T00:00:00Z")),
	})
	if _, err := Import(ctx, st, p); err != nil {
		t.Fatal(err)
	}
	// The user deletes b in Caprock (a chat's delete is ADR-037's removal).
	found, err := store.FindRemovalCandidates(ctx, st.DB(), []string{SessionID(SourceClaudeAI, "b")}, "")
	if err != nil || len(found) != 1 {
		t.Fatalf("candidates: %v %v", found, err)
	}
	if err := st.WithTx(ctx, func(q store.Querier) error {
		_, err := store.RemoveSession(ctx, q, found[0], time.UTC, 1)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// A later export: a carries on, b is still there.
	p = write([]map[string]any{
		conv("a", msg("a1", "human", "first", "2026-01-01T00:00:00Z"), msg("a2", "assistant", "reply", "2026-01-01T00:01:00Z"),
			msg("a3", "human", "and then?", "2026-01-02T00:00:00Z")),
		conv("b", msg("b1", "human", "other", "2026-01-01T00:00:00Z")),
	})
	res, err := Import(ctx, st, p)
	if err != nil {
		t.Fatal(err)
	}
	if res.Updated != 1 || res.Deleted != 1 || res.Messages != 1 || res.Added != 0 {
		t.Fatalf("re-import: %+v", res)
	}
	if _, err := store.GetSession(ctx, st.DB(), SessionID(SourceClaudeAI, "b")); err == nil {
		t.Fatal("a deleted chat came back")
	}
	s, _ := store.GetSession(ctx, st.DB(), SessionID(SourceClaudeAI, "a"))
	if s.WorkedAt != time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("worked_at moved to the new message: %d", s.WorkedAt)
	}
}

func TestBothSourcesLiveSideBySide(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	for _, f := range []string{"claude-ai", "chatgpt"} {
		if _, err := Import(ctx, st, fixture(f)); err != nil {
			t.Fatal(err)
		}
	}
	counts, err := store.CountChats(ctx, st.DB())
	if err != nil || counts.Chats != 3 {
		t.Fatalf("chats: %+v %v", counts, err)
	}
	s, err := store.GetSession(ctx, st.DB(), SessionID(SourceChatGPT, "6795a000-0000-4000-8000-0000000000c1"))
	if err != nil || s.Agent != SourceChatGPT || s.Model != "gpt-test-2" || s.Prompt != "What should I pack for a day hike?" {
		t.Fatalf("chatgpt session: %+v %v", s, err)
	}
}
