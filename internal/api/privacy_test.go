package api

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// pidAgents is fakeAgents that knows one session's pid.
type pidAgents struct {
	*fakeAgents
	pids map[string]int
}

func (a *pidAgents) SessionPID(id string) int { return a.pids[id] }

// privacyEnv is a server whose session "s1" is this test process, with the
// pane opener recorded instead of run: no test may raise an OS window.
func privacyEnv(t *testing.T, goos string) (url string, client *http.Client, opened *[][2]string) {
	t.Helper()
	e := newEnv(t)
	ag := &pidAgents{fakeAgents: &fakeAgents{avail: true}, pids: map[string]int{"s1": os.Getpid()}}
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: ag})
	prevOS, prevOpen := privacyGOOS, openPrivacy
	var got [][2]string
	privacyGOOS = goos
	openPrivacy = func(pane, reveal string) error { got = append(got, [2]string{pane, reveal}); return nil }
	t.Cleanup(func() { privacyGOOS, openPrivacy = prevOS, prevOpen })
	return e.srv.URL, e.srv.Client(), &got
}

func TestPrivacyRoutesAreMacOSOnly(t *testing.T) {
	url, c, opened := privacyEnv(t, "linux")
	r, err := c.Get(url + "/v1/sessions/s1/privacy")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("GET = %d; want 404 off macOS", r.StatusCode)
	}
	r, err = c.Post(url+"/v1/sessions/s1/privacy/open", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusNotFound || len(*opened) != 0 {
		t.Fatalf("POST = %d, opened %v; want 404 and nothing opened", r.StatusCode, *opened)
	}
}

// The open route opens the pane asked for, the Full Disk Access list by
// default, and only one of the two it knows; it answers who macOS asks
// about, read from the session's running process where the kernel can say.
func TestPrivacyOpenOpensThePaneAndNamesTheProgram(t *testing.T) {
	url, c, opened := privacyEnv(t, "darwin")
	post := func(body string) (int, privacyAnswer) {
		r, err := c.Post(url+"/v1/sessions/s1/privacy/open", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var a privacyAnswer
		_ = json.NewDecoder(r.Body).Decode(&a)
		return r.StatusCode, a
	}
	if code, _ := post(`{"pane":"camera"}`); code != http.StatusBadRequest {
		t.Fatalf("unknown pane = %d; want 400", code)
	}
	if len(*opened) != 0 {
		t.Fatalf("a refused pane opened %v", *opened)
	}
	code, a := post(`{}`)
	if code != http.StatusOK || len(*opened) != 1 || (*opened)[0][0] != paneFullDisk {
		t.Fatalf("default = %d %v; want the Full Disk Access pane", code, *opened)
	}
	if code, _ = post(`{"pane":"files"}`); code != http.StatusOK || (*opened)[1][0] != paneFiles {
		t.Fatalf("files = %d %v", code, *opened)
	}
	if runtime.GOOS == "darwin" {
		// This test process is a real process: the kernel names its
		// responsible program, and Finder is pointed at it.
		if !a.Live || a.Name == "" || a.Program == "" || (*opened)[0][1] != a.Reveal {
			t.Fatalf("answer %+v, revealed %q", a, (*opened)[0][1])
		}
	}
}

func TestPrivacyNamesNothingLiveForASessionNotHeld(t *testing.T) {
	url, c, _ := privacyEnv(t, "darwin")
	r, err := c.Get(url + "/v1/sessions/nope/privacy")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var a privacyAnswer
	if err := json.NewDecoder(r.Body).Decode(&a); err != nil || r.StatusCode != http.StatusOK {
		t.Fatalf("GET = %d %v", r.StatusCode, err)
	}
	// No helper beside a test binary: nothing to name.
	if a.Live || a.Name != "" {
		t.Fatalf("answer %+v; want nothing for a session not held", a)
	}
}
