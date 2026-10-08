package agents

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/userenv"
)

// Two OpenCodes.
//
// OpenCode 2 (2.0.x) shipped beside OpenCode 1 (1.x) under the same command
// name: opencode.ai's installer, `brew install opencode` and Arch install 2,
// while the npm package `opencode-ai`, Scoop, Chocolatey and nixpkgs stay on
// 1. The two TUIs take different flags. Read from `opencode --help` of 1.15.10
// and 2.0.26 on 2026-10-09 (testdata/):
//
//   - 1.x: `--port`, `-m provider/model`, `--agent`, `-s/--session` (continue
//     only), `--fork`, `--prompt`.
//   - 2.x: `--standalone`, `--server`, `--auto`, `-c`, `-s/--session` ("to
//     continue, or to create if it does not exist"), `--prompt`. No `--port`,
//     no `-m`, no `--agent`: the model and agent come from config, and
//     OPENCODE_CONFIG_CONTENT is config for one process.
//
// So the version is asked before the argv is built, from the binary that will
// run (`opencode --version`: "1.15.10" from 1.x, "opencode v2.0.26" from 2.x).

// versionTimeout bounds `opencode --version`. Both answer in well under a
// second; a binary that hangs must not hold up a spawn for longer than this.
const versionTimeout = 5 * time.Second

var versionRe = regexp.MustCompile(`(?:^|\s|v)(\d+)\.(\d+)\.(\d+)`)

// parseVersion reads the major version and the version string out of
// `opencode --version`, or 0 and "" when the output names none.
func parseVersion(out string) (int, string) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return 0, ""
	}
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, ""
	}
	return major, m[1] + "." + m[2] + "." + m[3]
}

// versionEntry is one binary's answer, kept while the file is unchanged.
type versionEntry struct {
	mod     time.Time
	size    int64
	version string
}

// versions caches `--version` per binary path. An upgrade replaces the file,
// which changes its size or time, so the next spawn asks again.
type versions struct {
	mu      sync.Mutex
	m       map[string]versionEntry
	pending map[string]bool
}

// get returns the cached version of bin, asking it when wait is set and the
// cache has nothing current. Without wait it never blocks: it starts the
// question in the background and returns what it has.
func (v *versions) get(bin string, wait bool) string {
	fi, err := os.Stat(bin)
	if err != nil {
		return ""
	}
	v.mu.Lock()
	if v.m == nil {
		v.m, v.pending = map[string]versionEntry{}, map[string]bool{}
	}
	if e, ok := v.m[bin]; ok && e.mod.Equal(fi.ModTime()) && e.size == fi.Size() {
		v.mu.Unlock()
		return e.version
	}
	if !wait {
		if !v.pending[bin] {
			v.pending[bin] = true
			go func() { v.get(bin, true) }()
		}
		v.mu.Unlock()
		return ""
	}
	v.mu.Unlock()

	ver := askVersion(bin)
	v.mu.Lock()
	v.m[bin] = versionEntry{mod: fi.ModTime(), size: fi.Size(), version: ver}
	delete(v.pending, bin)
	v.mu.Unlock()
	return ver
}

// askVersion runs `bin --version` in the user's environment.
func askVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), versionTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.Env = userenv.Environ(nil)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	_, ver := parseVersion(string(out))
	return ver
}

// majorOf is the major number of a version string, 0 when unknown.
func majorOf(ver string) int {
	major, _ := parseVersion(ver)
	return major
}

// OpenCodeVersion is the version of the OpenCode this machine would start,
// "" while unknown. It never blocks: the first call asks in the background.
func (m *Manager) OpenCodeVersion() string {
	if v, ok := m.vers[AgentOpenCode]; ok {
		return v
	}
	if !m.AgentAvailable(AgentOpenCode) {
		return ""
	}
	return m.ocVersions.get(m.binary(AgentOpenCode), false)
}

// openCodeMajor is the major version of the OpenCode about to be started,
// asked and waited for. 0 — unknown — builds OpenCode 1's command line, which
// is what every spawn did before OpenCode 2 existed.
func (m *Manager) openCodeMajor() int {
	if v, ok := m.vers[AgentOpenCode]; ok {
		return majorOf(v)
	}
	return majorOf(m.ocVersions.get(m.binary(AgentOpenCode), true))
}

// newOpenCodeID makes a session id the way OpenCode 2 makes its own
// (2.0.26: "ses_" + 12 hex digits of the inverted millisecond clock times
// 4096 plus a counter, then 14 random base-62 characters), so a session
// Caprock names sorts among the user's own as if OpenCode had named it.
// `opencode --session <id>` creates the session under exactly this id, which
// is what links it to Caprock's from the first byte.
func newOpenCodeID(now time.Time) string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	r := ^(uint64(now.UnixMilli())*0x1000 + 1)
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], r)
	id := "ses_" + hex.EncodeToString(b[2:])
	var rnd [14]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		// Never in practice; the clock part alone is unique per millisecond.
		for i := range rnd {
			rnd[i] = byte(now.UnixNano() >> (i % 8))
		}
	}
	for _, c := range rnd {
		id += string(alphabet[int(c)%62])
	}
	return id
}

// opencodeV2Launch starts the OpenCode 2 TUI (2.0.26).
//
//   - `--standalone` runs the session in a private server inside the process
//     Caprock started, not in the shared background service: pause and stop
//     then act on the work itself, as `--no-daemon` does for Codex, and the
//     environment below reaches the session rather than a service another
//     terminal shares.
//   - `--session <id>` creates the session under an id Caprock chose (or
//     continues the one being resumed), so it is linked at the spawn — no
//     server to watch for the id.
//   - The model, the plan agent and "ask before commands" are config, given
//     to this process alone as OPENCODE_CONFIG_CONTENT: {"model":"p/m"},
//     {"default_agent":"plan"}, {"permission":{"shell":"ask"}} — verified with
//     `opencode debug agents` and with the model and agent recorded on the
//     session's steps. It is merged over the user's own config, not instead of
//     it.
//   - Bypass is `--auto`, "Auto-approve permissions that are not explicitly
//     denied": OpenCode 2 has the flag OpenCode 1 lacked.
//   - A first message is typed into the TUI once it has drawn and gone quiet
//     (typeWhenReady), not passed as `--prompt`. 2.0.26 can send a --prompt
//     before it has resolved the configured model, and the message then runs
//     on its catalog default instead (measured: 4 of 9 starts in a browser
//     terminal, with the model from config and from OPENCODE_CONFIG_CONTENT
//     alike; 0 of 3 when the same text was typed after the TUI settled).
//   - MSGPACKR_NATIVE_ACCELERATION_DISABLED=true: 2.0.26 looks for an
//     optional native msgpack module at a path from its own build machine,
//     under /home, and on a Mac where /home is an automount that does not
//     answer, the server never starts (measured: blocked in open(2) on
//     /home/, no output, no port). The pure-JavaScript decoder it falls back
//     to behaves the same.
func opencodeV2Launch(in launchInput) (launch, error) {
	l := launch{sessionID: in.SessionID}
	native := ""
	if in.Resume != "" {
		native = in.NativeResume
		if native == "" {
			native = in.Resume
		}
		if _, err := resumeArgs(AgentOpenCode, native, in.Fork); err != nil {
			return launch{}, err
		}
		l.sessionID = in.Resume
	} else {
		native = newOpenCodeID(in.now())
		l.nativeID = native
	}
	l.args = []string{"--standalone", "--session", native}
	cfg := map[string]any{}
	if in.Model != "" {
		cfg["model"] = in.Model
	}
	switch in.Mode {
	case "plan":
		cfg["default_agent"] = "plan"
	case "acceptEdits":
		cfg["permission"] = map[string]string{"shell": "ask"}
	case "bypassPermissions":
		l.args = append(l.args, "--auto")
	}
	if len(cfg) > 0 {
		b, _ := json.Marshal(cfg)
		l.env = append(l.env, "OPENCODE_CONFIG_CONTENT="+string(b))
	}
	l.env = append(l.env, "MSGPACKR_NATIVE_ACCELERATION_DISABLED=true")
	l.args = append(l.args, in.Extra...)
	if promptArg(in) != "" {
		l.typed = strings.TrimRight(in.Prompt, " \t\r\n")
	}
	return l, nil
}

// How long a TUI must stay quiet before a first message is typed into it, and
// how long to wait for that at most. OpenCode 2's TUI draws its first screen
// within a second of starting and then writes nothing until something
// happens; the bound is for a TUI that never goes quiet, which then gets the
// message anyway rather than never.
var (
	typeQuiet = time.Second
	typeWait  = 30 * time.Second
)

// typeWhenReady types a first message into a session once its output has
// started and then stopped for typeQuiet, as a person would after the screen
// appeared. Newlines are ESC CR, which inserts a line in OpenCode 2's prompt
// (measured on 2.0.26) as in OpenCode 1's; a final CR sends it. Nothing is
// typed into a process that has ended or never drew anything.
func (m *Manager) typeWhenReady(a *Agent, text string) {
	deadline := time.Now().Add(typeWait)
	t := time.NewTicker(typeQuiet / 10)
	defer t.Stop()
wait:
	for {
		select {
		case <-a.done:
			return
		case <-t.C:
		}
		at := a.outAt.Load()
		switch {
		case at != 0 && time.Since(time.Unix(0, at)) >= typeQuiet:
			break wait
		case time.Now().After(deadline):
			if at == 0 {
				m.log.Warn("the session drew nothing; its first message was not typed", "component", "agents", "session_id", a.SessionID)
				return
			}
			break wait
		}
	}
	body := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\x1b\r")
	if err := m.Input(a.SessionID, []byte(body)); err != nil {
		m.log.Warn("could not type the first message", "component", "agents", "session_id", a.SessionID, "err", err)
		return
	}
	// The send is its own write, after the text has landed: a CR in the same
	// chunk can be read as part of a paste rather than as Enter.
	time.Sleep(typeQuiet / 5)
	if err := m.Input(a.SessionID, []byte("\r")); err != nil {
		m.log.Warn("could not send the first message", "component", "agents", "session_id", a.SessionID, "err", err)
	}
}

// withEnv adds extra to a child's environment. A variable extra sets replaces
// the inherited one rather than sitting beside it — two values for one name
// leave the child to pick — with one exception: OPENCODE_CONFIG_CONTENT the
// user already exports is merged with Caprock's, Caprock's keys winning, so a
// model chosen in the dialog does not throw away the rest of their inline
// config.
func withEnv(base, extra []string) []string {
	set := map[string]string{}
	for _, kv := range extra {
		if i := strings.IndexByte(kv, '='); i > 0 {
			set[kv[:i]] = kv[i+1:]
		}
	}
	out := make([]string, 0, len(base)+len(extra))
	for _, kv := range base {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			out = append(out, kv)
			continue
		}
		k := kv[:i]
		v, ours := set[k]
		if !ours {
			out = append(out, kv)
			continue
		}
		if k == "OPENCODE_CONFIG_CONTENT" {
			set[k] = mergeJSON(kv[i+1:], v)
		}
	}
	for _, kv := range extra {
		if i := strings.IndexByte(kv, '='); i > 0 {
			out = append(out, kv[:i]+"="+set[kv[:i]])
			continue
		}
		out = append(out, kv)
	}
	return out
}

// mergeJSON lays the keys of over on top of base, both JSON objects. Either
// one unreadable leaves over as it is.
func mergeJSON(base, over string) string {
	var b, o map[string]any
	if json.Unmarshal([]byte(base), &b) != nil || json.Unmarshal([]byte(over), &o) != nil || b == nil {
		return over
	}
	for k, v := range o {
		b[k] = v
	}
	out, err := json.Marshal(b)
	if err != nil {
		return over
	}
	return string(out)
}
