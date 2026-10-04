package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

type drillResult struct {
	err   bool
	bytes int
}

type drillFixture struct {
	t *testing.T
	s *Store
	n int
}

// call writes a transcript-plane pre and, unless result is nil, its post.
func (f *drillFixture) call(session, tool string, at time.Time, input map[string]any, result *drillResult) {
	f.t.Helper()
	f.n++
	id := "t" + itoa(f.n)
	pre, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "cwd": "/home/u/repo", "tool_name": tool, "tool_input": input, "_from": "transcript"})
	if _, err := InsertEvent(context.Background(), f.s.DB(), &event.Event{SessionID: session, Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: tool, Ts: at, Key: "pre:" + id, Payload: pre}); err != nil {
		f.t.Fatal(err)
	}
	if result == nil {
		return
	}
	post, _ := json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "tool_use_id": id, "tool_response": strings.Repeat("x", result.bytes), "is_error": result.err, "_from": "transcript"})
	if _, err := InsertEvent(context.Background(), f.s.DB(), &event.Event{SessionID: session, Source: event.SourceTranscript, Kind: event.KindToolPost, Ts: at.Add(time.Second), Key: "post:" + id, Payload: post}); err != nil {
		f.t.Fatal(err)
	}
}

func ok(bytes int) *drillResult {
	return &drillResult{false, bytes}
}

func failed() *drillResult {
	return &drillResult{true, 10}
}

func TestCommandHeadNamesWhatAShellCallRan(t *testing.T) {
	for cmd, want := range map[string]string{
		"cd /x && go test ./... -count=1":           "go test",
		"git -C /r --no-pager log --oneline | head": "git log",
		"FOO=1 npm run build":                       "npm run",
		"gh pr create --title x":                    "gh pr create",
		"/usr/local/bin/python3 script.py":          "python3",
		"export A=1; make check":                    "make check",
		"sudo docker ps":                            "docker ps",
		"sleep 5; curl -s http://x":                 "sleep",
		"for f in *.go; do gofmt -l $f; done":       "for loop",
	} {
		if got := commandHead(cmd, "/r"); got != want {
			t.Errorf("%q: got %q, want %q", cmd, got, want)
		}
	}
}

func TestToolDrillGroupsCountsAndFindsWhatFails(t *testing.T) {
	ctx := context.Background()
	f := &drillFixture{t: t, s: openTest(t)}
	base := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	// 40 go test calls, 12 of them failing; 100 git status calls, all fine and
	// small; 20 git diff calls returning most of the output; one with no
	// recorded result.
	for i := 0; i < 40; i++ {
		r := ok(100)
		if i < 12 {
			r = failed()
		}
		f.call("s1", "Bash", base.Add(time.Duration(i)*time.Minute), map[string]any{"command": "go test ./..."}, r)
	}
	for i := 0; i < 100; i++ {
		f.call("s1", "Bash", base.Add(time.Duration(i)*time.Minute), map[string]any{"command": "git status"}, ok(50))
	}
	for i := 0; i < 20; i++ {
		f.call("s2", "Bash", base.Add(time.Duration(i)*time.Hour), map[string]any{"command": "git diff"}, ok(5000))
	}
	f.call("s2", "Bash", base, map[string]any{"command": "ls"}, nil)
	// Another tool's calls stay out of Bash's drill.
	f.call("s1", "Read", base, map[string]any{"file_path": "/home/u/repo/a.go"}, ok(10))

	d, err := ToolDrillStats(ctx, f.s.DB(), DrillOptions{Tool: "Bash", Home: "/home/u"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Kind != "shell" || d.GroupBy != "command" || d.Calls != 161 || d.Results != 160 || d.Failures != 12 {
		t.Fatalf("drill %+v", d)
	}
	if d.Rows[0].Key != "git status" || d.Rows[0].Calls != 100 || d.Rows[1].Key != "go test" || d.Rows[1].Failures != 12 {
		t.Fatalf("rows %+v", d.Rows)
	}
	var sum int64
	for _, r := range d.Rows {
		sum += r.Calls
		var tr int64
		for _, n := range r.Trend {
			tr += n
		}
		if tr != r.Calls || len(r.Trend) != drillTrendBuckets {
			t.Fatalf("%s: trend %v does not add up to %d calls", r.Key, r.Trend, r.Calls)
		}
	}
	if sum+d.Other != d.Calls {
		t.Fatalf("rows %d + other %d != calls %d", sum, d.Other, d.Calls)
	}
	kinds := map[string]string{}
	for _, h := range d.Hints {
		kinds[h.Kind] = h.Key
	}
	if kinds["failures"] != "go test" || kinds["output"] != "git diff" || kinds["repeats"] != "git status" {
		t.Fatalf("hints %+v", d.Hints)
	}
	for _, h := range d.Hints {
		if h.Kind == "failures" && !strings.Contains(h.Text, "12 of 40") {
			t.Fatalf("failure hint does not state the counts: %q", h.Text)
		}
	}

	r, err := ToolDrillStats(ctx, f.s.DB(), DrillOptions{Tool: "Read", Home: "/home/u"})
	if err != nil {
		t.Fatal(err)
	}
	if r.GroupBy != "file" || len(r.Rows) != 1 || r.Rows[0].Key != "~/repo/a.go" {
		t.Fatalf("read drill %+v", r)
	}
}

func TestToolDrillGroupsTheWebByDomainAndCodexByItsCommand(t *testing.T) {
	ctx := context.Background()
	f := &drillFixture{t: t, s: openTest(t)}
	at := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	f.call("s", "WebFetch", at, map[string]any{"url": "https://www.example.com/a"}, ok(1))
	f.call("s", "WebFetch", at, map[string]any{"url": "https://example.com/b"}, ok(1))
	f.call("s", "WebFetch", at, map[string]any{"url": "https://docs.go.dev/"}, ok(1))
	d, err := ToolDrillStats(ctx, f.s.DB(), DrillOptions{Tool: "WebFetch"})
	if err != nil {
		t.Fatal(err)
	}
	if d.GroupBy != "domain" || d.Rows[0].Key != "example.com" || d.Rows[0].Calls != 2 {
		t.Fatalf("web drill %+v", d.Rows)
	}

	f.call("c", "exec", at, map[string]any{}, nil)
	code := "const r = await tools.exec_command({\n  cmd: \"go vet ./...\",\n  workdir: \"/r\"\n})"
	pre, _ := json.Marshal(map[string]any{"tool_input": code})
	if _, err := InsertEvent(ctx, f.s.DB(), &event.Event{SessionID: "c", Source: event.SourceTranscript, Kind: event.KindToolPre, Tool: "exec", Ts: at, Key: "pre:cx1", Payload: pre}); err != nil {
		t.Fatal(err)
	}
	c, err := ToolDrillStats(ctx, f.s.DB(), DrillOptions{Tool: "exec"})
	if err != nil {
		t.Fatal(err)
	}
	found, empty := false, false
	for _, r := range c.Rows {
		found = found || r.Key == "go vet"
		// The call with an empty input is said as such, not as "no detail".
		empty = empty || r.Key == drillNotRecorded
	}
	if !found || !empty {
		t.Fatalf("codex drill %+v", c.Rows)
	}
}
