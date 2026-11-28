package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/pairing"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/talks"
)

// What a person linked for Talks may do (ADR-110), written out here rather
// than read from personRoutes, so a route added to that map without a
// decision shows up as a failing test.
var personMayOnly = map[string]bool{
	"POST /v1/talks/inbox": true, "GET /v1/talks/inbox/{talk}": true,
	"GET /v1/pair/me": true, "DELETE /v1/pair/me": true,
}

// pairedPerson adds to ps a person whose token is bound to key, as a Talks
// invitation makes one.
func pairedPerson(t *testing.T, ps *pairing.Store, name, key string) *pairing.Device {
	t.Helper()
	code, err := ps.NewCodeForKeyKind(key, pairing.KindPerson)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := ps.RedeemFrom(code, name, key)
	if err != nil {
		t.Fatal(err)
	}
	if dev.Kind != pairing.KindPerson || dev.Role != pairing.RoleTalk || dev.Pending || dev.Key != key {
		t.Fatalf("the person paired as %+v", dev)
	}
	return dev
}

func personRequest(pattern, token, key string) *http.Request {
	r := phoneRequest(pattern, token)
	if key != "" {
		remote.SetPeerKey(r.Header, key)
	}
	return r
}

// Every endpoint, for a person: personRoutes and nothing else — not a
// phone's reads, not a controller's or a computer's routes — and only on
// the channel that proves the person's key.
func TestEveryEndpointForAPerson(t *testing.T) {
	s, ps, _, _ := pairedPhones(t, Deps{})
	ana := pairedPerson(t, ps, "Ana", "key-ana")
	have := map[string]bool{}
	for _, pattern := range registeredRoutes(t) {
		have[pattern] = true
		want := http.StatusForbidden
		if personMayOnly[pattern] || pattern == "POST /v1/pair" || (!strings.Contains(pattern, " /v1/") && !strings.Contains(pattern, " /x/")) {
			want = 0
		}
		if got, why := s.gate(personRequest(pattern, ana.Token, "key-ana")); got != want {
			t.Errorf("%s: person %d, want %d (%s)", pattern, got, want, why)
		}
	}
	for p := range personMayOnly {
		if !have[p] {
			t.Errorf("the test names %q, which api.go does not register", p)
		}
		if !personRoutes[p] {
			t.Errorf("%q is in the test's table but not in personRoutes", p)
		}
	}
	for p := range personRoutes {
		if !personMayOnly[p] {
			t.Errorf("personRoutes has %q, which the test does not name", p)
		}
	}
	// The token works only on the channel that proves Ana's key.
	for _, key := range []string{"", "key-other"} {
		if got, _ := s.gate(personRequest("POST /v1/talks/inbox", ana.Token, key)); got != http.StatusUnauthorized {
			t.Errorf("the person's token with key %q: %d, want 401", key, got)
		}
	}
	// Never moved to a viewer or a controller.
	if ps.SetRole(ana.ID, pairing.RoleController) {
		t.Error("a person was made a controller")
	}
	// The inbox is a person's: a phone, a computer and the machine itself
	// are refused there by the gate or the handler.
	mac := pairedComputer(t, ps, "MacBook", true)
	if got, _ := s.gate(phoneRequest("POST /v1/talks/inbox", mac.Token)); got != http.StatusForbidden {
		t.Errorf("a computer reached the inbox: %d", got)
	}
	if w := serve(s, local("POST", "/v1/talks/inbox", `{"envelope":{}}`)); w.Code != http.StatusForbidden {
		t.Errorf("the machine itself delivered into the inbox: %d", w.Code)
	}
}

// fakeTalks is TalksControl over a real engine and a fixed person.
type fakeTalks struct {
	eng  *talks.Engine
	left []string
}

func (f *fakeTalks) Engine() *talks.Engine { return f.eng }
func (f *fakeTalks) Invite(context.Context, string) (TalkInvite, error) {
	return TalkInvite{}, nil
}
func (f *fakeTalks) InviteState() peers.JoinState { return peers.JoinState{State: peers.JoinNone} }
func (f *fakeTalks) WithdrawInvite()              {}
func (f *fakeTalks) Accept(context.Context, string, string) (TalkPerson, error) {
	return TalkPerson{}, nil
}
func (f *fakeTalks) People() []TalkPerson                       { return nil }
func (f *fakeTalks) SetPerson(string, *string, *bool) error     { return nil }
func (f *fakeTalks) RemovePerson(context.Context, string) error { return nil }
func (f *fakeTalks) PersonLeft(_ context.Context, key string)   { f.left = append(f.left, key) }
func (f *fakeTalks) Settings() talks.Settings                   { return talks.Settings{} }
func (f *fakeTalks) SetSettings(talks.Settings) error           { return nil }

// A person delivers the opening of a Talk through the inbox, which the
// owner then lists; the sender is the key the token is bound to, so an
// envelope names no sender of its own; the person's withdrawal ends their
// Talks here.
func TestAPersonDeliversIntoTheInbox(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	eng := talks.New(talks.Options{DB: st.DB(), People: func(id string) (talks.Person, bool) {
		return talks.Person{Name: "Ana", LetStart: false}, id == "key-ana"
	}})
	ft := &fakeTalks{eng: eng}
	s, ps, viewer, _ := pairedPhones(t, Deps{Store: st, Talks: ft})
	ana := pairedPerson(t, ps, "Ana", "key-ana")
	env, _ := json.Marshal(talks.Envelope{V: 1, Kind: talks.KindState, State: talks.EnvOpen, Talk: "t_1", Seq: 1, Body: "Pick a date"})
	body := `{"envelope":` + string(env) + `}`
	r := fromDevice("POST", "/v1/talks/inbox", body, ana.Token)
	remote.SetPeerKey(r.Header, "key-ana")
	if w := serve(s, r); w.Code != http.StatusOK {
		t.Fatalf("deliver: %d %s", w.Code, w.Body)
	}
	if w := serve(s, fromDevice("POST", "/v1/talks/inbox", body, viewer.Token)); w.Code != http.StatusForbidden {
		t.Fatalf("a phone delivered: %d", w.Code)
	}
	w := serve(s, local("GET", "/v1/talks", ""))
	var list struct {
		Talks []store.Talk `json:"talks"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if w.Code != 200 || len(list.Talks) != 1 || list.Talks[0].State != talks.StateInvited || list.Talks[0].Person != "key-ana" || list.Talks[0].Goal != "Pick a date" {
		t.Fatalf("the owner's list: %d %s", w.Code, w.Body)
	}
	// The owner's routes are the machine's: a person cannot read the list.
	r = fromDevice("GET", "/v1/talks", "", ana.Token)
	remote.SetPeerKey(r.Header, "key-ana")
	if w := serve(s, r); w.Code != http.StatusForbidden {
		t.Fatalf("a person read the talks: %d", w.Code)
	}
	// Ana's Remove, from her side: her token here goes, and so do her Talks.
	r = fromDevice("DELETE", "/v1/pair/me", "", ana.Token)
	remote.SetPeerKey(r.Header, "key-ana")
	if w := serve(s, r); w.Code != http.StatusOK {
		t.Fatalf("withdraw: %d %s", w.Code, w.Body)
	}
	if len(ft.left) != 1 || ft.left[0] != "key-ana" {
		t.Fatalf("the daemon was told %v", ft.left)
	}
	r = fromDevice("POST", "/v1/talks/inbox", body, ana.Token)
	remote.SetPeerKey(r.Header, "key-ana")
	if w := serve(s, r); w.Code != http.StatusUnauthorized {
		t.Fatalf("after the Remove the person delivered: %d", w.Code)
	}
}

// Without Talks the owner's routes say so.
func TestTalksWithoutTheFeature(t *testing.T) {
	s := New(Deps{})
	if w := serve(s, local("GET", "/v1/talks", "")); w.Code != http.StatusNotImplemented {
		t.Fatalf("%d", w.Code)
	}
	if got := talkKeyOf(" https://caprock.dev/talk#cj1-abc "); got != "cj1-abc" {
		t.Fatalf("%q", got)
	}
}
