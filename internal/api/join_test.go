package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

type fakeJoin struct {
	key    string
	joined string
	err    error
}

func (f *fakeJoin) NewJoinKey() (peers.NewJoinKey, error) {
	return peers.NewJoinKey{JoinState: peers.JoinState{State: peers.JoinWaiting, ExpiresAt: 1}, Key: f.key}, nil
}

func (f *fakeJoin) JoinKeyState() peers.JoinState {
	return peers.JoinState{State: peers.JoinWaiting, ExpiresAt: 1}
}

func (f *fakeJoin) WithdrawJoinKey() {}

func (f *fakeJoin) Join(_ context.Context, key string) (JoinResult, error) {
	if f.err != nil {
		return JoinResult{}, f.err
	}
	f.joined = key
	return JoinResult{Joined: peers.Joined{ControllerName: "MacBook", Status: "online"}, Name: "mini"}, nil
}

// ADR-108: join keys are made and used on the machine itself, and the key is
// answered once.
func TestJoinKeysFromTheMachineOnly(t *testing.T) {
	_, jk, err := remote.MakeJoinKey(remote.DefaultRelay)
	if err != nil {
		t.Fatal(err)
	}
	fj := &fakeJoin{key: jk.String()}
	s, _, viewer, controller := pairedPhones(t, Deps{Join: fj})

	w := serve(s, local("POST", "/v1/machines/join-key", ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), jk.String()) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("make: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("GET", "/v1/machines/join-key", "")); w.Code != 200 || strings.Contains(w.Body.String(), jk.String()) {
		t.Fatalf("state repeats the key: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("POST", "/v1/join", `{"key":"not a key"}`)); w.Code != 400 {
		t.Fatalf("a bad key: %d %s", w.Code, w.Body)
	}
	w = serve(s, local("POST", "/v1/join", `{"key":"caprock join `+jk.String()+`"}`))
	var res JoinResult
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil || w.Code != 200 || res.ControllerName != "MacBook" || fj.joined == "" {
		t.Fatalf("join: %d %s", w.Code, w.Body)
	}
	fj.err = peers.ErrJoinGone
	if w := serve(s, local("POST", "/v1/join", `{"key":"`+jk.String()+`"}`)); w.Code != 404 {
		t.Fatalf("a gone key: %d %s", w.Code, w.Body)
	}

	// No paired device may make a key or make this machine join another.
	for _, tok := range []string{viewer.Token, controller.Token} {
		for _, r := range []struct{ method, path, body string }{
			{"POST", "/v1/machines/join-key", ""},
			{"GET", "/v1/machines/join-key", ""},
			{"DELETE", "/v1/machines/join-key", ""},
			{"POST", "/v1/join", `{"key":"` + jk.String() + `"}`},
		} {
			if w := serve(s, fromDevice(r.method, r.path, r.body, tok)); w.Code != 403 && w.Code != 401 {
				t.Errorf("%s %s from a phone: %d", r.method, r.path, w.Code)
			}
		}
	}
	if w := serve(New(Deps{}), local("POST", "/v1/machines/join-key", "")); w.Code != 501 {
		t.Fatalf("without join keys: %d", w.Code)
	}
}

// A join's code is redeemed through the relay by the computer whose key the
// channel proved, and that computer is allowed at once; from any other
// channel it pairs nothing.
func TestAJoinCodeIsRedeemedByItsKeyAlone(t *testing.T) {
	ps := pairing.New()
	s := New(Deps{Pairing: ps, LANURL: testLANURL, Remote: &fakeRemote{on: true}, DataDir: t.TempDir()})
	redeem := func(code, peer string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/pair", strings.NewReader(`{"code":"`+code+`","name":"MacBook"}`))
		r.RemoteAddr = "127.0.0.1:51000"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Via", "1.1 caprock-remote")
		if peer != "" {
			remote.SetPeerKey(r.Header, peer)
		}
		return serve(s, r)
	}

	code, _ := ps.NewCodeForKey("laptop-key")
	if w := redeem(code, "someone-else"); w.Code != 401 {
		t.Fatalf("another key redeemed a join code: %d %s", w.Code, w.Body)
	}
	if len(ps.Devices()) != 0 {
		t.Fatalf("devices = %+v", ps.Devices())
	}
	code, _ = ps.NewCodeForKey("laptop-key")
	w := redeem(code, "laptop-key")
	var tok pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &tok); err != nil || w.Code != 200 {
		t.Fatalf("redeem: %d %s", w.Code, w.Body)
	}
	ds := ps.Devices()
	if len(ds) != 1 || ds[0].Pending || ds[0].Kind != pairing.KindMachine || !ds[0].Bound || ds[0].Role != pairing.RoleController {
		t.Fatalf("the joined computer: %+v", ds)
	}
}
