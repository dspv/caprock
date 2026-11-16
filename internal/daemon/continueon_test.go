package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/ingest"
	"github.com/dspv/caprock/internal/sessionlink"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/subs"
)

// continueDaemon is subsDaemon with a manager that starts testdata's fake
// claude (for Claude Code and for Codex: it ignores every flag and contacts
// nothing), and the own sign-in's transcripts under the temporary HOME.
func continueDaemon(t *testing.T) *Daemon {
	t.Helper()
	if testing.Short() {
		t.Skip("builds the fake claude")
	}
	bin := buildFakeClaude(t)
	d := subsDaemon(t)
	home, _ := os.UserHomeDir()
	d.opt.TranscriptRoot = filepath.Join(home, ".claude", "projects")
	d.mgr = agents.NewManager(d.store, d.opt.DataDir, bin, d.log)
	d.mgr.SetBinary(agents.AgentCodex, bin)
	d.link = sessionlink.New(d.store, d.log)
	t.Cleanup(d.mgr.Shutdown)
	return d
}

var fakeClaudeOnce struct {
	sync.Once
	bin string
	err error
}

// buildFakeClaude builds testdata/fakeclaude once per test binary, before
// any test moves HOME (the module cache is under the real one).
func buildFakeClaude(t *testing.T) string {
	t.Helper()
	f := &fakeClaudeOnce
	f.Do(func() {
		dir, err := os.MkdirTemp("", "caprock-fakeclaude-")
		if err != nil {
			f.err = err
			return
		}
		f.bin = filepath.Join(dir, "claude")
		if runtime.GOOS == "windows" {
			f.bin += ".exe"
		}
		root, _ := filepath.Abs("../..")
		cmd := exec.Command("go", "build", "-o", f.bin, "./testdata/fakeclaude")
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			f.err = fmt.Errorf("%w\n%s", err, out)
		}
	})
	if f.err != nil {
		t.Fatalf("build fake claude: %v", f.err)
	}
	return f.bin
}

// startOwned starts a Claude Code session Caprock owns in cwd and gives it a
// transcript where Claude Code keeps the own sign-in's.
func startOwned(t *testing.T, d *Daemon, cwd string) string {
	t.Helper()
	ctx := context.Background()
	ag, err := d.mgr.Spawn(ctx, agents.SpawnRequest{Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	id := ag.SessionID
	tp := filepath.Join(d.opt.TranscriptRoot, ingest.ProjectDirName(cwd), id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(tp), 0o700); err != nil {
		t.Fatal(err)
	}
	lines := `{"type":"user","uuid":"u1","sessionId":"` + id + `","cwd":"` + jsonPath(cwd) + `","message":{"role":"user","content":"fix the bug"}}` + "\n" +
		`{"type":"assistant","uuid":"u2","sessionId":"` + id + `","cwd":"` + jsonPath(cwd) + `","message":{"model":"claude-opus-5","id":"m1","content":[{"type":"text","text":"on it"}]}}` + "\n" +
		limitRefusal(id)
	if err := os.WriteFile(tp, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, d.store.DB(), id, store.SessionPatch{Cwd: cwd, TranscriptPath: tp, Model: "claude-opus-5"}); err != nil {
		t.Fatal(err)
	}
	return id
}

func jsonPath(p string) string { return strings.ReplaceAll(p, `\`, `\\`) }

func limitRefusal(id string) string {
	return `{"type":"assistant","error":"rate_limit","isApiErrorMessage":true,"session_id":"` + id + `","sessionId":"` + id +
		`","quotaLimits":{"status":"rejected","resetsAt":1793613600,"rateLimitType":"five_hour"},"message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit"}]}}` + "\n"
}

// waitEnded waits for the manager to let go of a session it ended.
func waitEnded(t *testing.T, d *Daemon, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, held := d.mgr.Get(id); !held {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("session %s still running", id)
}

// On DeepSeek or Kimi the same conversation is resumed, forked, in the same
// configuration directory, and the original is ended.
func TestContinueOnProviderForksInTheSameDirectory(t *testing.T) {
	d := continueDaemon(t)
	ctx := context.Background()
	a := &agentAdapter{m: d.mgr, d: d}
	cwd := t.TempDir()
	id := startOwned(t, d, cwd)

	if _, err := a.ContinueOn(ctx, id, subs.KimiID); err == nil || !strings.Contains(err.Error(), "Kimi key") {
		t.Fatalf("Kimi with no key: %v", err)
	}
	if _, err := a.ContinueOn(ctx, id, subs.DefaultID); err == nil {
		t.Fatal("continued on the sign-in it already runs on")
	}
	d.opt.Config.KimiAPIKey = "sk-kimi-" + "test-only-0000"
	frames := d.bus.Subscribe(64)
	defer frames.Unsubscribe()
	res, err := a.ContinueOn(ctx, id, subs.KimiID)
	if err != nil {
		t.Fatal(err)
	}
	if res.How != "resume" || !res.SameConversation || res.SessionID == id || res.ContinuedFrom != id || res.From != subs.DefaultID || !res.StoppedOriginal {
		t.Fatalf("result: %+v", res)
	}
	s, err := store.GetSession(ctx, d.store.DB(), res.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Subscription != subs.KimiID || s.ParentSession != id {
		t.Fatalf("new session: subscription %q parent %q", s.Subscription, s.ParentSession)
	}
	if !strings.Contains(s.SpawnCommand, "--resume "+id) || !strings.Contains(s.SpawnCommand, "--fork-session") {
		t.Fatalf("argv: %s", s.SpawnCommand)
	}
	if strings.Contains(s.SpawnCommand, "sk-kimi") {
		t.Fatal("the key is on the command line")
	}
	waitEnded(t, d, id)
	select {
	case f := <-frames.C:
		for f.Type != bus.FrameContinued {
			f = <-frames.C
		}
		if got := f.Data.(api.ContinueOnResult); got.SessionID != res.SessionID || got.Auto {
			t.Fatalf("frame: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no continued frame")
	}
}

// On another Claude Code sign-in the transcript is copied under a new id
// into that sign-in's directory and resumed there; the original stays.
func TestContinueOnAnotherSignInCopiesTheTranscript(t *testing.T) {
	d := continueDaemon(t)
	ctx := context.Background()
	a := &agentAdapter{m: d.mgr, d: d}
	work, err := (&subsAdapter{d: d}).Add(ctx, "claude", "Work")
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	id := startOwned(t, d, cwd)
	src, _ := store.GetSession(ctx, d.store.DB(), id)
	before, _ := os.ReadFile(src.TranscriptPath)

	res, err := a.ContinueOn(ctx, id, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	if res.How != "copy" || !res.SameConversation || res.SessionID == id {
		t.Fatalf("result: %+v", res)
	}
	copied := filepath.Join(subs.Dir(d.opt.DataDir, work.ID), "projects", ingest.ProjectDirName(cwd), res.SessionID+".jsonl")
	b, err := os.ReadFile(copied)
	if err != nil {
		t.Fatalf("no copy where Claude Code looks: %v", err)
	}
	if strings.Contains(string(b), `"sessionId":"`+id+`"`) || strings.Count(string(b), `"sessionId":"`+res.SessionID+`"`) != 3 ||
		!strings.Contains(string(b), `"session_id":"`+res.SessionID+`"`) {
		t.Fatalf("copy not renamed:\n%s", b)
	}
	if after, _ := os.ReadFile(src.TranscriptPath); string(after) != string(before) {
		t.Fatal("the original transcript changed")
	}
	s, _ := store.GetSession(ctx, d.store.DB(), res.SessionID)
	if s.Subscription != work.ID || s.ParentSession != id {
		t.Fatalf("new session: subscription %q parent %q", s.Subscription, s.ParentSession)
	}
	if !strings.Contains(s.SpawnCommand, "--resume "+res.SessionID) || strings.Contains(s.SpawnCommand, "--fork-session") {
		t.Fatalf("argv: %s", s.SpawnCommand)
	}
	if err := copyTranscript(src.TranscriptPath, copied, id, "x"); err == nil {
		t.Fatal("a copy replaced a file")
	}
}

// On Codex it is a new session with a brief, linked as a relay.
func TestContinueOnCodexStartsASummary(t *testing.T) {
	d := continueDaemon(t)
	ctx := context.Background()
	a := &agentAdapter{m: d.mgr, d: d}
	id := startOwned(t, d, t.TempDir())
	res, err := a.ContinueOn(ctx, id, agents.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	if res.How != "summary" || res.SameConversation || !strings.Contains(res.Note, "not the same conversation") {
		t.Fatalf("result: %+v", res)
	}
	s, _ := store.GetSession(ctx, d.store.DB(), res.SessionID)
	if s.Agent != agents.AgentCodex || s.RelayFrom != id {
		t.Fatalf("new session: agent %q relay_from %q", s.Agent, s.RelayFrom)
	}
}

// A session Caprock did not start is not stopped and moved (rule 7), and an
// unknown one is not found.
func TestContinueOnRefusesASessionCaprockDidNotStart(t *testing.T) {
	d := continueDaemon(t)
	ctx := context.Background()
	a := &agentAdapter{m: d.mgr, d: d}
	if err := store.UpsertSession(ctx, d.store.DB(), "theirs", store.SessionPatch{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.ContinueOn(ctx, "theirs", subs.DefaultID); !errors.Is(err, api.ErrContinueNotOwned) {
		t.Fatalf("not owned: %v", err)
	}
	if _, err := a.ContinueOn(ctx, "nope", subs.DefaultID); !errors.Is(err, api.ErrContinueNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

// limit_action "auto": a session at its limit moves to the first fallback
// that is available, once; with the return on, it goes back after the reset,
// even when the daemon restarted in between.
func TestAutoContinueAndReturnAfterTheReset(t *testing.T) {
	d := continueDaemon(t)
	ctx := context.Background()
	id := startOwned(t, d, t.TempDir())
	d.opt.Config.DeepSeekAPIKey = "sk-ds-" + "test-only-0000"
	d.opt.Config.LimitAction = config.LimitAuto
	d.opt.Config.LimitFallbacks = []string{subs.DefaultID, subs.KimiID, subs.DeepSeekID}
	d.opt.Config.LimitReturnAfterReset = true
	resets := time.Now().Add(time.Hour).UnixMilli()
	if err := store.SetLimitHit(ctx, d.store.DB(), id, store.LimitHit{At: time.Now().UnixMilli(), ResetsAt: resets, Window: "five_hour"}); err != nil {
		t.Fatal(err)
	}
	frames := d.bus.Subscribe(64)
	defer frames.Unsubscribe()
	next := func() api.ContinueOnResult {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case f := <-frames.C:
				if f.Type == bus.FrameContinued {
					return f.Data.(api.ContinueOnResult)
				}
			case <-deadline:
				t.Fatal("no continued frame")
			}
		}
	}
	d.limitTick(ctx, time.Now())
	moved := next()
	// "default" is where it already is, Kimi has no key: DeepSeek.
	if !moved.Auto || moved.Target != subs.DeepSeekID || moved.From != subs.DefaultID || moved.ReturnAt != resets+returnGrace.Milliseconds() {
		t.Fatalf("moved: %+v", moved)
	}
	waitEnded(t, d, id)
	d.limitTick(ctx, time.Now())
	select {
	case f := <-frames.C:
		if f.Type == bus.FrameContinued {
			t.Fatalf("moved twice for one limit: %+v", f.Data)
		}
	case <-time.After(200 * time.Millisecond):
	}
	// The new session is on DeepSeek in the own directory, so going back is
	// a fork there too. Give it a transcript, as Claude Code would write.
	sess, _ := store.GetSession(ctx, d.store.DB(), moved.SessionID)
	tp := filepath.Join(d.opt.TranscriptRoot, ingest.ProjectDirName(sess.Cwd), moved.SessionID+".jsonl")
	if err := os.WriteFile(tp, []byte(`{"type":"user","sessionId":"`+moved.SessionID+`","cwd":"`+jsonPath(sess.Cwd)+`","message":{"role":"user","content":"x"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(ctx, d.store.DB(), moved.SessionID, store.SessionPatch{TranscriptPath: tp}); err != nil {
		t.Fatal(err)
	}
	// A restart in between: the return is read back from the database.
	d.limits = limitWatch{}
	d.limitTick(ctx, time.UnixMilli(moved.ReturnAt+1))
	back := next()
	if !back.Auto || back.Target != subs.DefaultID || back.ContinuedFrom != moved.SessionID || back.How != "resume" {
		t.Fatalf("back: %+v", back)
	}
	var left int
	if err := d.store.DB().QueryRow(`SELECT COUNT(*) FROM limit_returns`).Scan(&left); err != nil || left != 0 {
		t.Fatalf("%d returns left after going back (%v)", left, err)
	}
}
