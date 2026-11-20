package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/readiness"
)

type fakeSetup struct {
	in     readiness.Inputs
	chosen map[string]bool
}

// SetupFacts resolves each agent's switch from what was chosen, as the
// daemon does.
func (f *fakeSetup) SetupFacts(*http.Request) (readiness.Inputs, error) {
	in := f.in
	in.Agents = nil
	for _, a := range f.in.Agents {
		a.On = readiness.AgentOn(a.ID, a.Installed, f.chosen)
		in.Agents = append(in.Agents, a)
	}
	return in, nil
}

func (f *fakeSetup) SetAgentSwitch(id string, on bool) error {
	if f.chosen == nil {
		f.chosen = map[string]bool{}
	}
	f.chosen[id] = on
	return nil
}

// GET /v1/setup words the daemon's facts and adds the link from the pairing
// state: a computer waiting for Allow is named, an allowed one ticks the
// item; a linked computer reads it, a waiting one and a phone do not.
func TestSetupReadsTheLinkFromThePairingState(t *testing.T) {
	rem := &fakeRemote{}
	fs := &fakeSetup{in: readiness.Inputs{GOOS: "windows", Agents: []readiness.Agent{{ID: "claude", Label: "Claude Code", Install: "irm https://claude.ai/install.ps1 | iex"}}}}
	s, ps, viewer, _ := pairedPhones(t, Deps{Remote: rem, Setup: fs})
	read := func(r *http.Request) (int, readiness.Report) {
		w := serve(s, r)
		var rep readiness.Report
		_ = json.Unmarshal(w.Body.Bytes(), &rep)
		return w.Code, rep
	}
	link := func(rep readiness.Report) readiness.Item {
		for _, it := range rep.Items {
			if it.Key == readiness.KeyLink {
				return it
			}
		}
		t.Fatalf("no link item in %+v", rep)
		return readiness.Item{}
	}

	code, rep := read(local("GET", "/v1/setup", ""))
	if code != 200 || rep.OS != "windows" || len(rep.Items) != 4 {
		t.Fatalf("setup: %d %+v", code, rep)
	}
	if it := link(rep); it.State != readiness.Missing {
		t.Fatalf("nothing linked: %+v", it)
	}
	// The project item says where a clone goes: ~/dev in full, with no
	// default folder set (owner, 2026-11-20).
	if home := homeRoot(); home != "" {
		want := "Optional. Clone a repository here into " + filepath.Join(home, "dev") + ","
		for _, it := range rep.Items {
			if it.Key == readiness.KeyProject && !strings.HasPrefix(it.Detail, want) {
				t.Fatalf("project: %q, want it to start %q", it.Detail, want)
			}
		}
	}

	waiting := pairedComputer(t, ps, "MacBook", false)
	if _, rep = read(local("GET", "/v1/setup", "")); link(rep).State != readiness.Missing || !strings.Contains(link(rep).Detail, "MacBook is waiting") {
		t.Fatalf("waiting: %+v", link(rep))
	}
	if !ps.Allow(waiting.ID) {
		t.Fatal("allow")
	}
	rem.on = true
	if _, rep = read(local("GET", "/v1/setup", "")); link(rep).State != readiness.OK {
		t.Fatalf("allowed: %+v", link(rep))
	}

	// The laptop reads it through its channel as a paired computer.
	if code, rep = read(fromDevice("GET", "/v1/setup", "", waiting.Token)); code != 200 || len(rep.Items) != 4 {
		t.Fatalf("from the allowed computer: %d", code)
	}
	if code, _ = read(fromDevice("GET", "/v1/setup", "", pairedComputer(t, ps, "Stranger", false).Token)); code != http.StatusForbidden {
		t.Fatalf("from a computer still waiting: %d", code)
	}
	if code, _ = read(fromDevice("GET", "/v1/setup", "", viewer.Token)); code != http.StatusForbidden {
		t.Fatalf("from a phone: %d", code)
	}
}

func TestSetupWithoutTheDaemonPartIs501(t *testing.T) {
	s, _, _, _ := pairedPhones(t, Deps{})
	if w := serve(s, local("GET", "/v1/setup", "")); w.Code != http.StatusNotImplemented {
		t.Fatalf("%d", w.Code)
	}
}

// The agents' switches (ADR-099 amendment, 2026-11-20): kept by this
// computer, answered with the checklist as it now reads; an agent the
// checklist does not list is 404; a linked laptop or a phone cannot switch.
func TestSetupAgentSwitch(t *testing.T) {
	fs := &fakeSetup{in: readiness.Inputs{GOOS: "linux", Agents: []readiness.Agent{
		{ID: "claude", Label: "Claude Code", Install: "curl -fsSL https://claude.ai/install.sh | bash"},
		{ID: "codex", Label: "Codex", Install: "npm install -g @openai/codex"},
	}}}
	s, ps, viewer, _ := pairedPhones(t, Deps{Remote: &fakeRemote{}, Setup: fs})
	rows := func(body []byte) map[string]readiness.AgentRow {
		var rep readiness.Report
		if err := json.Unmarshal(body, &rep); err != nil {
			t.Fatal(err)
		}
		out := map[string]readiness.AgentRow{}
		for _, a := range rep.Agents {
			out[a.ID] = a
		}
		return out
	}
	w := serve(s, local("GET", "/v1/setup", ""))
	if r := rows(w.Body.Bytes()); !r["claude"].On || r["codex"].On {
		t.Fatalf("defaults: %+v", r)
	}
	w = serve(s, local("PUT", "/v1/setup/agents/codex", `{"on":true}`))
	if w.Code != 200 {
		t.Fatalf("switch on: %d %s", w.Code, w.Body.String())
	}
	if r := rows(w.Body.Bytes()); !r["codex"].On || r["codex"].Step != readiness.StepInstall {
		t.Fatalf("codex on: %+v", r["codex"])
	}
	if r := rows(serve(s, local("GET", "/v1/setup", "")).Body.Bytes()); !r["codex"].On {
		t.Fatal("the switch did not stay")
	}
	if w = serve(s, local("PUT", "/v1/setup/agents/claude", `{"on":false}`)); w.Code != 200 || rows(w.Body.Bytes())["claude"].On {
		t.Fatalf("switch off: %d %s", w.Code, w.Body.String())
	}
	for _, c := range []struct{ path, body string }{
		{"/v1/setup/agents/nope", `{"on":true}`},
		{"/v1/setup/agents/codex", `{}`},
		{"/v1/setup/agents/codex", `not json`},
	} {
		if w := serve(s, local("PUT", c.path, c.body)); w.Code != 404 && w.Code != 400 {
			t.Errorf("%s %s: %d", c.path, c.body, w.Code)
		}
	}
	laptop := pairedComputer(t, ps, "MacBook", true)
	for _, tok := range []string{laptop.Token, viewer.Token} {
		if w := serve(s, fromDevice("PUT", "/v1/setup/agents/codex", `{"on":false}`, tok)); w.Code != 403 && w.Code != 401 {
			t.Errorf("from a device: %d", w.Code)
		}
	}
	if !fs.chosen["codex"] {
		t.Fatal("a device's switch got through")
	}
}
