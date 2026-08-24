//go:build smoke

// Package smoke scripts the Phase 0 Definition-of-Done scenario end-to-end with
// a fake `claude`: a real daemon (in-process), the real shim binary (subprocess),
// a real transcript file, a real git repo. It runs on the three-OS CI matrix:
// `go test -tags smoke ./internal/smoke/...`.
package smoke

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/daemon"
	"github.com/dspv/caprock/internal/hooks"
)

const sessionID = "smoke-1111-2222-3333-444444444444"

type harness struct {
	t          *testing.T
	dataDir    string
	root       string // transcript root
	repo       string // fake project (git repo)
	shim       string
	url        string
	cancel     context.CancelFunc
	done       chan error
	transcript string
}

func buildShim(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "caprock-hook")
	if runtime.GOOS == "windows" {
		out += ".exe"
	}
	cmd := exec.Command("go", "build", "-o", out, "../../cmd/caprock-hook")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("build shim: %v", err)
	}
	return out
}

func startDaemon(t *testing.T, dataDir, root string) (string, context.CancelFunc, chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	ready := make(chan string, 1)
	go func() {
		done <- daemon.Run(ctx, daemon.Options{
			DataDir: dataDir, Config: config.Defaults(), Version: "smoke", TranscriptRoot: root, Listener: ln,
			// Without this the developer's own OpenCode sessions are imported
			// into the temporary store and every count below is wrong.
			OpenCodeDB: "off",
			IdleAfter:  30 * time.Second,
			OnReady:    func(u string) { ready <- u },
		})
	}()
	select {
	case u := <-ready:
		return u, cancel, done
	case err := <-done:
		t.Fatalf("daemon exited early: %v", err)
	case <-time.After(15 * time.Second):
		t.Fatal("daemon did not start")
	}
	return "", nil, nil
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{t: t, dataDir: t.TempDir(), root: t.TempDir(), repo: t.TempDir(), shim: buildShim(t)}
	// The shim resolves the data dir via env.
	t.Setenv(config.EnvDataDir, h.dataDir)
	// Fake project: git repo with one committed file.
	h.git("init", "-q")
	h.git("config", "user.email", "smoke@caprock.dev")
	h.git("config", "user.name", "smoke")
	_ = os.WriteFile(filepath.Join(h.repo, "main.go"), []byte("package main\n"), 0o600)
	h.git("add", "main.go")
	h.git("commit", "-q", "-m", "init")
	proj := filepath.Join(h.root, "-fake-proj")
	_ = os.MkdirAll(proj, 0o700)
	h.transcript = filepath.Join(proj, sessionID+".jsonl")
	h.url, h.cancel, h.done = startDaemon(t, h.dataDir, h.root)
	return h
}

func (h *harness) git(args ...string) {
	h.t.Helper()
	cmd := exec.Command("git", append([]string{"-C", h.repo}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		h.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// hook runs the real shim binary with a payload, exactly as Claude Code would.
func (h *harness) hook(event string, extra map[string]any) {
	h.t.Helper()
	p := map[string]any{"session_id": sessionID, "hook_event_name": event, "cwd": h.repo, "transcript_path": h.transcript, "permission_mode": "default"}
	for k, v := range extra {
		p[k] = v
	}
	body, _ := json.Marshal(p)
	cmd := exec.Command(h.shim)
	cmd.Env = append(os.Environ(), config.EnvDataDir+"="+h.dataDir)
	cmd.Stdin = bytes.NewReader(body)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	start := time.Now()
	if err := cmd.Run(); err != nil {
		h.t.Fatalf("shim %s: %v (stderr %q)", event, err, errb.String())
	}
	if el := time.Since(start); el > 2*time.Second {
		h.t.Fatalf("shim took %s (budget 1s + process spawn)", el)
	}
	if out.Len() != 0 {
		h.t.Fatalf("shim printed to stdout on %s: %q", event, out.String())
	}
}

// transcriptTurn appends an assistant line with usage (what Claude Code writes).
func (h *harness) transcriptTurn(msgID string, in, out, cr, cw int64, text string) {
	h.t.Helper()
	line := map[string]any{
		"type": "assistant", "uuid": "u-" + msgID, "sessionId": sessionID, "cwd": h.repo, "gitBranch": "master", "version": "2.1.221",
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"message": map[string]any{"model": "claude-opus-5", "id": msgID, "role": "assistant",
			"content": []map[string]any{{"type": "text", "text": text}},
			"usage":   map[string]any{"input_tokens": in, "output_tokens": out, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw}},
	}
	b, _ := json.Marshal(line)
	f, err := os.OpenFile(h.transcript, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		h.t.Fatal(err)
	}
	defer f.Close()
	_, _ = f.Write(append(b, '\n'))
}

func (h *harness) getJSON(path string, out any) int {
	h.t.Helper()
	resp, err := http.Get(h.url + path)
	if err != nil {
		h.t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	if out != nil && resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			h.t.Fatalf("decode %s: %v", path, err)
		}
	}
	return resp.StatusCode
}

type sessionDTO struct {
	SessionID string `json:"session_id"`
	Status    string `json:"status"`
	HasHooks  bool   `json:"has_hooks"`
	Stats     struct {
		Turns     int64   `json:"turns"`
		ToolCalls int64   `json:"tool_calls"`
		CostUSD   float64 `json:"cost_usd"`
	} `json:"stats"`
	Activity struct {
		Phrase string `json:"phrase"`
		Health string `json:"health"`
	} `json:"activity"`
	Loop *struct {
		Count int `json:"count"`
	} `json:"loop"`
}

func (h *harness) session() *sessionDTO {
	var list []sessionDTO
	h.getJSON("/v1/sessions?active=true", &list)
	for i := range list {
		if list[i].SessionID == sessionID {
			return &list[i]
		}
	}
	return nil
}

func (h *harness) waitFor(timeout time.Duration, what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	h.t.Fatalf("timed out after %s waiting for: %s", timeout, what)
}

func TestPhase0DefinitionOfDone(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	h := newHarness(t)

	// DoD 1 — hooks installed (into a fixture settings.json) non-destructively; shim in place.
	settings := filepath.Join(t.TempDir(), "settings.json")
	_ = os.WriteFile(settings, []byte(`{"model":"opus","hooks":{"Notification":[{"hooks":[{"type":"command","command":"say hi"}]}]}}`), 0o600)
	if _, err := hooks.Install(settings, h.shim); err != nil {
		t.Fatalf("install: %v", err)
	}
	st, err := hooks.Inspect(settings, h.shim)
	if err != nil || len(st.Missing) != 0 || !st.ShimExists {
		t.Fatalf("hooks status: %+v %v", st, err)
	}
	b, _ := os.ReadFile(settings)
	if !strings.Contains(string(b), "say hi") || !strings.Contains(string(b), `"model": "opus"`) {
		t.Fatalf("user settings damaged:\n%s", b)
	}
	if _, err := os.Stat(config.RuntimePath(h.dataDir)); err != nil {
		t.Fatalf("runtime.json missing: %v", err)
	}

	// DoD 2+3 — user starts claude and gives it a task; within 2s Now shows activity.
	h.hook("SessionStart", map[string]any{"source": "startup"})
	h.hook("UserPromptSubmit", map[string]any{"prompt": "add healthz", "prompt_id": "p1"})
	t0 := time.Now()
	h.hook("PreToolUse", map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": filepath.Join(h.repo, "main.go"), "old_string": "a", "new_string": "b"}, "tool_use_id": "toolu_1"})
	h.waitFor(2*time.Second, "Now shows 'editing main.go'", func() bool {
		s := h.session()
		return s != nil && s.Activity.Phrase == "editing main.go" && s.Activity.Health == "working" && s.HasHooks
	})
	t.Logf("activity visible after %s", time.Since(t0))
	h.hook("PostToolUse", map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": filepath.Join(h.repo, "main.go")}, "tool_use_id": "toolu_1", "tool_response": "ok"})

	// DoD 4 — within 15s of an assistant turn, tokens + cost update.
	t1 := time.Now()
	h.transcriptTurn("msg_1", 1000, 500, 20000, 3000, "Adding the endpoint.")
	h.waitFor(15*time.Second, "cost updates on Now", func() bool {
		s := h.session()
		return s != nil && s.Stats.Turns == 1 && s.Stats.CostUSD > 0
	})
	t.Logf("cost visible after %s", time.Since(t1))
	var sum struct {
		Turns   int64   `json:"turns"`
		CostUSD float64 `json:"cost_usd"`
	}
	h.getJSON("/v1/stats/summary?range=today", &sum)
	if sum.Turns != 1 || sum.CostUSD <= 0 {
		t.Fatalf("summary: %+v", sum)
	}
	// Exact price for Opus 5: 1000·5 + 500·25 + 20000·0.5 + 3000·6.25 per MTok.
	want := (1000*5 + 500*25 + 20000*0.5 + 3000*6.25) / 1e6
	if s := h.session(); s == nil || s.Stats.CostUSD < want-1e-6 || s.Stats.CostUSD > want+1e-6 {
		t.Fatalf("cost %v want %v", s.Stats.CostUSD, want)
	}

	// DoD 5 — Session Detail: timeline + live git diff of the cwd.
	_ = os.WriteFile(filepath.Join(h.repo, "main.go"), []byte("package main\n\nfunc healthz() {}\n"), 0o600)
	var det struct {
		Events []map[string]any `json:"events"`
		Files  []string         `json:"files"`
	}
	if code := h.getJSON("/v1/sessions/"+sessionID, &det); code != 200 || len(det.Events) < 4 || len(det.Files) != 1 {
		t.Fatalf("detail: %d %+v", code, det)
	}
	var diff struct {
		Files []struct {
			Path      string `json:"path"`
			Additions int    `json:"additions"`
		} `json:"files"`
	}
	if code := h.getJSON("/v1/sessions/"+sessionID+"/diff", &diff); code != 200 || len(diff.Files) != 1 || diff.Files[0].Path != "main.go" || diff.Files[0].Additions != 2 {
		t.Fatalf("diff: %d %+v", code, diff)
	}

	// DoD 6 — synthetic looping session: same Bash command 6× in 3 min raises a loop banner.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.url, "http")+"/v1/live", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	_, _, _ = c.Read(ctx) // hello
	alerts := make(chan string, 1)
	go func() {
		for {
			_, msg, err := c.Read(ctx)
			if err != nil {
				return
			}
			if strings.Contains(string(msg), `"type":"alert"`) {
				alerts <- string(msg)
				return
			}
		}
	}()
	for i := 0; i < 6; i++ {
		h.hook("PreToolUse", map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "go test ./...", "description": fmt.Sprintf("attempt %d", i)}, "tool_use_id": fmt.Sprintf("toolu_loop_%d", i)})
	}
	select {
	case a := <-alerts:
		if !strings.Contains(a, `"kind":"loop"`) || !strings.Contains(a, `"tool":"Bash"`) {
			t.Fatalf("alert frame: %s", a)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no loop alert within 10s")
	}
	h.waitFor(2*time.Second, "looping badge", func() bool {
		s := h.session()
		return s != nil && s.Loop != nil && s.Activity.Health == "looping"
	})

	// DoD 7 — down removes nothing; restart restores history.
	h.cancel()
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatalf("daemon exit: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("daemon did not stop")
	}
	if _, err := os.Stat(config.RuntimePath(h.dataDir)); err == nil {
		t.Fatal("runtime.json left behind after down")
	}
	if _, err := os.Stat(config.DBPath(h.dataDir)); err != nil {
		t.Fatalf("database removed on down: %v", err)
	}
	h.url, h.cancel, h.done = startDaemon(t, h.dataDir, h.root)
	defer func() { h.cancel(); <-h.done }()
	var list []sessionDTO
	if code := h.getJSON("/v1/sessions", &list); code != 200 || len(list) != 1 || list[0].SessionID != sessionID || list[0].Stats.Turns != 1 || list[0].Stats.ToolCalls != 7 {
		t.Fatalf("history after restart: %d %+v", code, list)
	}
	// Uninstall leaves the user's hooks intact.
	if removed, err := hooks.Uninstall(settings, h.shim); err != nil || !removed {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	b, _ = os.ReadFile(settings)
	if !strings.Contains(string(b), "say hi") || strings.Contains(string(b), "caprock-hook") {
		t.Fatalf("uninstall result:\n%s", b)
	}
}
