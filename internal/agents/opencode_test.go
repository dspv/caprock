package agents

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// testdata/opencode-*-help.txt and -version.txt are the real output of
// `opencode --help` and `opencode --version` from 1.15.10 and 2.0.26, read on
// 2026-10-09 (1.15.10 without its ASCII logo). The builders are checked
// against them: every flag a builder passes must be one that version lists.

func readTestdata(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// helpFlags is every --long and -s flag a help text lists.
func helpFlags(help string) map[string]bool {
	out := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)(?:^|[\s,])(--?[a-zA-Z][a-zA-Z-]*)`).FindAllStringSubmatch(help, -1) {
		out[m[1]] = true
	}
	return out
}

func flagsOf(args []string) []string {
	var out []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			out = append(out, a)
		}
	}
	return out
}

func TestParseOpenCodeVersion(t *testing.T) {
	for file, want := range map[string]string{"opencode-1.15.10-version.txt": "1.15.10", "opencode-2.0.26-version.txt": "2.0.26"} {
		major, ver := parseVersion(readTestdata(t, file))
		if ver != want || major != int(want[0]-'0') {
			t.Errorf("%s: %d %q, want %q", file, major, ver, want)
		}
	}
	for _, junk := range []string{"", "opencode", "error: unknown flag --version"} {
		if major, ver := parseVersion(junk); major != 0 || ver != "" {
			t.Errorf("%q read as %d %q", junk, major, ver)
		}
	}
}

func TestEachOpenCodeGetsOnlyFlagsItLists(t *testing.T) {
	v1 := helpFlags(readTestdata(t, "opencode-1.15.10-help.txt"))
	v2 := helpFlags(readTestdata(t, "opencode-2.0.26-help.txt"))
	// The reason for two builders: OpenCode 2 dropped what OpenCode 1 was
	// started with.
	for _, f := range []string{"--port", "-m", "--model", "--agent"} {
		if !v1[f] || v2[f] {
			t.Errorf("%s: in 1.15.10 %v, in 2.0.26 %v", f, v1[f], v2[f])
		}
	}
	for _, mode := range []string{"", "plan", "acceptEdits", "bypassPermissions"} {
		for _, resume := range []string{"", "cap-1"} {
			in := launchInput{SessionID: "s", Model: "fake/m1", Mode: mode, Port: 4100, Prompt: "hi", Resume: resume, NativeResume: "ses_x"}
			l1, err := opencodeLaunch(in)
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range flagsOf(l1.args) {
				if !v1[f] {
					t.Errorf("1.x %s/%q: %s is not in its --help", mode, resume, f)
				}
			}
			in.OpenCodeMajor = 2
			l2, err := opencodeLaunch(in)
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range flagsOf(l2.args) {
				if !v2[f] {
					t.Errorf("2.x %s/%q: %s is not in its --help", mode, resume, f)
				}
			}
		}
	}
}

func configOf(t *testing.T, env []string) map[string]any {
	t.Helper()
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "OPENCODE_CONFIG_CONTENT="); ok {
			var m map[string]any
			if err := json.Unmarshal([]byte(v), &m); err != nil {
				t.Fatalf("config content %q: %v", v, err)
			}
			return m
		}
	}
	return nil
}

func TestOpenCode2Launch(t *testing.T) {
	at := time.UnixMilli(1791500304124)
	l, err := opencodeV2Launch(launchInput{SessionID: "cap-1", Model: "fake/m2", Mode: "plan", Prompt: "plan it", Now: at})
	if err != nil {
		t.Fatal(err)
	}
	if l.sessionID != "cap-1" {
		t.Errorf("caprock id %q", l.sessionID)
	}
	if !regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`).MatchString(l.nativeID) {
		t.Errorf("native id %q is not shaped like OpenCode's", l.nativeID)
	}
	// The first message is typed once the TUI is up, not passed as
	// --prompt (see opencodeV2Launch).
	want := []string{"--standalone", "--session", l.nativeID}
	if !slices.Equal(l.args, want) || l.typed != "plan it" {
		t.Errorf("args %v typed %q, want %v and the message", l.args, l.typed, want)
	}
	cfg := configOf(t, l.env)
	if cfg["model"] != "fake/m2" || cfg["default_agent"] != "plan" || len(cfg) != 2 {
		t.Errorf("config %v", cfg)
	}
	if !slices.Contains(l.env, "MSGPACKR_NATIVE_ACCELERATION_DISABLED=true") {
		t.Errorf("env %v", l.env)
	}

	l, _ = opencodeV2Launch(launchInput{SessionID: "s", Mode: "acceptEdits"})
	if p, _ := configOf(t, l.env)["permission"].(map[string]any); p["shell"] != "ask" {
		t.Errorf("accept edits: %v", l.env)
	}
	l, _ = opencodeV2Launch(launchInput{SessionID: "s", Mode: "bypassPermissions"})
	if !slices.Contains(l.args, "--auto") || configOf(t, l.env) != nil {
		t.Errorf("bypass: %v %v", l.args, l.env)
	}
	l, _ = opencodeV2Launch(launchInput{SessionID: "s"})
	if configOf(t, l.env) != nil || slices.Contains(l.args, "--auto") {
		t.Errorf("defaults sent something: %v %v", l.args, l.env)
	}

	// Resume: the session's own id, no new one, no prompt; a fork is refused
	// as for OpenCode 1.
	l, _ = opencodeV2Launch(launchInput{SessionID: "new", Resume: "cap-1", NativeResume: "ses_abc", Prompt: "ignored"})
	if l.sessionID != "cap-1" || l.nativeID != "" || l.typed != "" || !slices.Equal(l.args, []string{"--standalone", "--session", "ses_abc"}) {
		t.Errorf("resume: %+v", l)
	}
	if _, err := opencodeV2Launch(launchInput{SessionID: "new", Resume: "cap-1", Fork: true}); err == nil {
		t.Error("a fork was allowed")
	}
}

func TestNewOpenCodeIDSortsLikeOpenCodes(t *testing.T) {
	// OpenCode 2 names sessions so that a newer one sorts first.
	a := newOpenCodeID(time.UnixMilli(1791500304124))
	b := newOpenCodeID(time.UnixMilli(1791500304125))
	if !(b[:16] < a[:16]) {
		t.Errorf("newer %q does not sort before older %q", b, a)
	}
	// The clock part matches a real 2.0.26 id made at a known moment:
	// ses_ee23fe547ffe… decodes to 1791500491448, 131 ms before the
	// time_created OpenCode then stamped on its session_v2 row.
	if got := newOpenCodeID(time.UnixMilli(1791500491448))[:16]; got != "ses_ee23fe547ffe" {
		t.Errorf("clock part %q, want ses_ee23fe547ffe", got)
	}
}

func TestWithEnvReplacesAndMerges(t *testing.T) {
	base := []string{"A=1", "OPENCODE_CONFIG_CONTENT={\"theme\":\"x\",\"model\":\"old/m\"}", "B=2"}
	out := withEnv(base, []string{"A=9", `OPENCODE_CONFIG_CONTENT={"model":"new/m"}`, "C=3"})
	n := 0
	for _, kv := range out {
		if strings.HasPrefix(kv, "A=") {
			n++
			if kv != "A=9" {
				t.Errorf("A = %q", kv)
			}
		}
	}
	if n != 1 {
		t.Errorf("A appears %d times: %v", n, out)
	}
	cfg := configOf(t, out)
	if cfg["model"] != "new/m" || cfg["theme"] != "x" {
		t.Errorf("merged config %v", cfg)
	}
	if !slices.Contains(out, "B=2") || !slices.Contains(out, "C=3") {
		t.Errorf("lost a variable: %v", out)
	}
	if got := mergeJSON("not json", `{"a":1}`); got != `{"a":1}` {
		t.Errorf("unreadable base: %q", got)
	}
}

func TestSpawnStartsOpenCode2(t *testing.T) {
	m, f := codexMgr(t)
	m.vers = map[string]string{AgentOpenCode: "2.0.26"}
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Model: "fake/m2", PermissionMode: "bypassPermissions"})
	if err != nil {
		t.Fatal(err)
	}
	if ag.Port != 0 || slices.Contains(f.lastSpec.Args, "--port") {
		t.Errorf("OpenCode 2 was given a port: %v", f.lastSpec.Args)
	}
	if ag.NativeID == "" || !slices.Contains(f.lastSpec.Args, ag.NativeID) {
		t.Errorf("native id %q not passed: %v", ag.NativeID, f.lastSpec.Args)
	}
	if ag.SessionID == ag.NativeID {
		t.Errorf("caprock's id is the native one")
	}
	if cfg := configOf(t, f.lastSpec.Env); cfg["model"] != "fake/m2" {
		t.Errorf("env config %v", cfg)
	}
	if m.OpenCodeVersion() != "2.0.26" {
		t.Errorf("version %q", m.OpenCodeVersion())
	}
}

func TestVersionIsAskedOfTheBinaryAndCached(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a shell script stands in for the binary")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "opencode")
	count := filepath.Join(dir, "count")
	script := "#!/bin/sh\necho x >> " + count + "\necho 'opencode v2.0.26'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var v versions
	if got := v.get(bin, true); got != "2.0.26" {
		t.Fatalf("version %q", got)
	}
	if got := v.get(bin, false); got != "2.0.26" {
		t.Errorf("cached %q", got)
	}
	if b, _ := os.ReadFile(count); strings.Count(string(b), "x") != 1 {
		t.Errorf("asked %d times, want once", strings.Count(string(b), "x"))
	}
	// An upgrade replaces the file; the next question is asked again.
	if err := os.WriteFile(bin, []byte(strings.Replace(script, "v2.0.26", "v2.1.0", 1)), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := v.get(bin, true); got != "2.1.0" {
		t.Errorf("after upgrade %q", got)
	}
	if v.get(filepath.Join(dir, "missing"), true) != "" {
		t.Error("a missing binary has a version")
	}
	// Without wait, an unknown binary answers "" at once and asks behind.
	other := filepath.Join(dir, "other")
	_ = os.WriteFile(other, []byte("#!/bin/sh\necho 1.15.10\n"), 0o755)
	if got := v.get(other, false); got != "" {
		t.Errorf("non-blocking get returned %q", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for v.get(other, false) != "1.15.10" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := v.get(other, false); got != "1.15.10" {
		t.Errorf("background ask gave %q", got)
	}
}

func TestOpenCode2FirstMessageIsTypedOnceTheTUIIsQuiet(t *testing.T) {
	defer func(q, w time.Duration) { typeQuiet, typeWait = q, w }(typeQuiet, typeWait)
	typeQuiet, typeWait = 100*time.Millisecond, 3*time.Second

	m, f := codexMgr(t)
	m.vers = map[string]string{AgentOpenCode: "2.0.26"}
	if _, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Prompt: "line one\nline two\n"}); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(f.lastSpec.Args, "--prompt") {
		t.Errorf("--prompt passed: %v", f.lastSpec.Args)
	}
	written := func() string {
		f.session.mu.Lock()
		defer f.session.mu.Unlock()
		return string(f.session.written)
	}
	// Nothing is typed before the TUI has drawn anything.
	time.Sleep(300 * time.Millisecond)
	if w := written(); w != "" {
		t.Fatalf("typed %q before any output", w)
	}
	f.session.out <- []byte("\x1b[2J drawing the screen")
	deadline := time.Now().Add(3 * time.Second)
	for written() != "line one\x1b\rline two\r" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if w := written(); w != "line one\x1b\rline two\r" {
		t.Errorf("typed %q, want the lines joined by ESC CR and a final CR", w)
	}
}

func TestTypeWhenReadyGivesUpOnASilentProcess(t *testing.T) {
	defer func(q, w time.Duration) { typeQuiet, typeWait = q, w }(typeQuiet, typeWait)
	typeQuiet, typeWait = 50*time.Millisecond, 200*time.Millisecond
	m, f := codexMgr(t)
	m.vers = map[string]string{AgentOpenCode: "2.0.26"}
	ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Agent: AgentOpenCode, Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { m.typeWhenReady(ag, "again"); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("typeWhenReady did not give up")
	}
	f.session.mu.Lock()
	defer f.session.mu.Unlock()
	if len(f.session.written) != 0 {
		t.Errorf("typed %q into a process that drew nothing", f.session.written)
	}
}
