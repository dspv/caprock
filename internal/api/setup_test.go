package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/readiness"
)

type fakeSetup struct{ in readiness.Inputs }

func (f *fakeSetup) SetupFacts(*http.Request) (readiness.Inputs, error) { return f.in, nil }

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
	if code != 200 || rep.OS != "windows" || len(rep.Items) != 5 {
		t.Fatalf("setup: %d %+v", code, rep)
	}
	if it := link(rep); it.State != readiness.Missing {
		t.Fatalf("nothing linked: %+v", it)
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
	if code, rep = read(fromDevice("GET", "/v1/setup", "", waiting.Token)); code != 200 || len(rep.Items) != 5 {
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
