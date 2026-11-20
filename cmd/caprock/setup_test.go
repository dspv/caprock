package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/readiness"
)

// The terminal checklist says, for each missing item, the command to run,
// and ends on the one next step — never a list with nothing to do.
func TestPrintSetup(t *testing.T) {
	rep := readiness.Build(readiness.Inputs{
		GOOS: "linux",
		Git:  readiness.Git{Found: true, Fresh: true},
		Agents: []readiness.Agent{
			{ID: "claude", Label: "Claude Code", Install: "curl -fsSL https://claude.ai/install.sh | bash"},
			{ID: "codex", Label: "Codex", Install: "npm install -g @openai/codex"},
		},
		Link: readiness.Link{Supported: true},
	})
	var b bytes.Buffer
	printSetup(&b, rep, false)
	out := b.String()
	for _, want := range []string{
		"Running agents on this computer (Linux):",
		"[ok] Git",
		"[  ] Claude Code or Codex",
		"run: curl -fsSL https://claude.ai/install.sh | bash",
		"[  ] Link to your laptop",
		"Next: Claude Code or Codex",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	ready := readiness.Build(readiness.Inputs{
		GOOS:     "linux",
		Git:      readiness.Git{Found: true, Fresh: true},
		Agents:   []readiness.Agent{{ID: "claude", Label: "Claude Code", Installed: true, SignIn: readiness.OK}},
		Projects: 1,
		Link:     readiness.Link{Supported: true, On: true, Allowed: []string{"MacBook"}},
	})
	b.Reset()
	printSetup(&b, ready, false)
	if !strings.Contains(b.String(), "Ready. Start agents from your laptop") || strings.Contains(b.String(), "run:") {
		t.Fatalf("ready:\n%s", b.String())
	}

	onlyLink := ready
	onlyLink.Items = append([]readiness.Item(nil), ready.Items...)
	onlyLink.Items[4] = readiness.Item{Key: readiness.KeyLink, State: readiness.Missing, Label: "Link to your laptop", Detail: "x", Command: "caprock setup --link"}
	b.Reset()
	printSetup(&b, onlyLink, false)
	if !strings.Contains(b.String(), "caprock setup --link") {
		t.Fatalf("link next:\n%s", b.String())
	}
}
