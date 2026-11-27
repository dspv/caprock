package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/peers"
)

type fakeServers struct {
	got []ServerScriptRequest
	err error
}

func (f *fakeServers) NewServerScript(_ context.Context, req ServerScriptRequest) (ServerScript, error) {
	f.got = append(f.got, req)
	if f.err != nil {
		return ServerScript{}, f.err
	}
	return ServerScript{
		JoinState: peers.JoinState{State: peers.JoinWaiting, ExpiresAt: 1, Server: true},
		Script:    "#!/bin/sh\nCAPROCK_JOIN_KEY='cj1-test'\n",
		Version:   "0.201.0",
	}, nil
}

// ADR-109: the script is made on the machine itself, answered once and not
// cached, and no paired device may ask for one.
func TestServerScriptFromTheMachineOnly(t *testing.T) {
	fs := &fakeServers{}
	s, _, viewer, controller := pairedPhones(t, Deps{Servers: fs})

	w := serve(s, local("POST", "/v1/machines/server-script", `{"ssh_key":true}`))
	var out ServerScript
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 {
		t.Fatalf("make: %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" || !out.Server || !strings.Contains(out.Script, "cj1-test") || out.Version != "0.201.0" {
		t.Fatalf("answer: %s", w.Body)
	}
	if len(fs.got) != 1 || !fs.got[0].SSHKey {
		t.Fatalf("request reached the maker as %+v", fs.got)
	}
	if w := serve(s, local("POST", "/v1/machines/server-script", "")); w.Code != 200 || fs.got[1].SSHKey {
		t.Fatalf("no body: %d %s %+v", w.Code, w.Body, fs.got)
	}
	if w := serve(s, local("POST", "/v1/machines/server-script", "not json")); w.Code != 400 {
		t.Fatalf("a bad body: %d", w.Code)
	}

	fs.err = fmt.Errorf("%w: GitHub said 503", ErrNoRelease)
	if w := serve(s, local("POST", "/v1/machines/server-script", "{}")); w.Code != 502 {
		t.Fatalf("no release: %d %s", w.Code, w.Body)
	}
	fs.err = peers.ErrNoIdentity
	if w := serve(s, local("POST", "/v1/machines/server-script", "{}")); w.Code != 409 {
		t.Fatalf("no identity: %d %s", w.Code, w.Body)
	}

	for _, tok := range []string{viewer.Token, controller.Token} {
		if w := serve(s, fromDevice("POST", "/v1/machines/server-script", "{}", tok)); w.Code != 403 && w.Code != 401 {
			t.Errorf("from a phone: %d", w.Code)
		}
	}

	none, _, _, _ := pairedPhones(t, Deps{})
	if w := serve(none, local("POST", "/v1/machines/server-script", "{}")); w.Code != 501 {
		t.Fatalf("without the feature: %d", w.Code)
	}
}
