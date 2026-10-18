package api

import (
	"bytes"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

// pasteAgents is fakeAgents with bracketed paste on or off.
type pasteAgents struct {
	fakeAgents
	paste bool
}

func (p *pasteAgents) PasteMode(string) bool { return p.paste }

// The chat's photos go in as the desktop terminal types a dropped file
// (ui/src/lib/xtermInput.ts pathInput): each image its own bracketed paste
// when the session asked for one, then the words.
func TestAgentInputPaths(t *testing.T) {
	imageSettle = time.Millisecond
	t.Cleanup(func() { imageSettle = 150 * time.Millisecond })
	post := func(fa AgentController, body string) int {
		s := New(Deps{Version: "t", Token: "tok", Agents: fa})
		req := httptest.NewRequest("POST", "/v1/agents/s1/input", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, req)
		return rr.Code
	}
	const body = `{"paths":["/a b/1.jpg","/x/\"q\".PNG","/x/notes.txt","bad\npath"],"data":"look"}`

	on := &pasteAgents{fakeAgents: fakeAgents{avail: true}, paste: true}
	if c := post(on, body); c != 204 {
		t.Fatalf("status %d", c)
	}
	want := []string{
		"\x1b[200~\"/a b/1.jpg\"\x1b[201~",
		"\x1b[200~\"/x/\\\"q\\\".PNG\"\x1b[201~",
		"\"/x/notes.txt\" ",
		"look",
	}
	if !reflect.DeepEqual(on.inputs, want) {
		t.Fatalf("paste on:\n got %q\nwant %q", on.inputs, want)
	}

	// No bracketed paste (a shell, an agent that never asked): typed, quoted.
	off := &pasteAgents{fakeAgents: fakeAgents{avail: true}}
	if c := post(off, `{"paths":["/a b/1.jpg"]}`); c != 204 {
		t.Fatalf("status %d", c)
	}
	if want := []string{"\"/a b/1.jpg\" "}; !reflect.DeepEqual(off.inputs, want) {
		t.Fatalf("paste off: got %q want %q", off.inputs, want)
	}

	// A controller that cannot say (no PasteMode) is taken as off.
	plain := &fakeAgents{avail: true}
	if c := post(plain, `{"paths":["/p.png"],"data":"x"}`); c != 204 {
		t.Fatalf("status %d", c)
	}
	if want := []string{"\"/p.png\" ", "x"}; !reflect.DeepEqual(plain.inputs, want) {
		t.Fatalf("no PasteMode: got %q want %q", plain.inputs, want)
	}
}
