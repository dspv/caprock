package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeLinkSender struct {
	ready bool
	sent  []string
	err   error
}

func (f *fakeLinkSender) PhoneLinkReady() bool { return f.ready }
func (f *fakeLinkSender) SendPhoneLink(_ context.Context, app string) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, app)
	return nil
}

func localPost(path string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
	r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
	r.Header.Set("Content-Type", "application/json")
	return r
}

// Vova, 2026-10-15 (translated): he opened the phone app, closed the tab,
// and next day did not remember the link. "Send the link to my phone" puts
// the phone's page in his Telegram — the daemon's own address, never one
// the request names, sent only from the machine.
func TestSendLinkSendsThePhonesPageFromTheMachineOnly(t *testing.T) {
	link := &fakeLinkSender{ready: true}
	s, _, viewer, controller := pairedPhones(t, Deps{Remote: &fakeRemote{on: true}, PhoneLink: link})

	w := httptest.NewRecorder()
	s.ServeHTTP(w, localPost("/v1/pair/send-link"))
	if w.Code != http.StatusOK {
		t.Fatalf("from the machine: %d %s", w.Code, w.Body)
	}
	if len(link.sent) != 1 || link.sent[0] != "https://m.caprock.dev" {
		t.Fatalf("sent %v, want the phone's page", link.sent)
	}

	for name, tok := range map[string]string{"viewer": viewer.Token, "controller": controller.Token} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, phoneRequest("POST /v1/pair/send-link", tok))
		if w.Code != http.StatusForbidden {
			t.Errorf("from a %s phone: %d, want 403", name, w.Code)
		}
	}
	w = httptest.NewRecorder()
	s.ServeHTTP(w, relayedRequest("POST /v1/pair/send-link", controller.Token, "Via", "1.1 caprock-remote"))
	if w.Code != http.StatusForbidden {
		t.Errorf("through the relay: %d, want 403", w.Code)
	}
	if len(link.sent) != 1 {
		t.Fatalf("a phone sent a message: %v", link.sent)
	}
}

func TestSendLinkSaysWhyItCannot(t *testing.T) {
	for _, tc := range []struct {
		name string
		deps Deps
		want int
	}{
		{"no relay in this build", Deps{PhoneLink: &fakeLinkSender{ready: true}}, http.StatusNotImplemented},
		{"no sender", Deps{Remote: &fakeRemote{on: true}}, http.StatusNotImplemented},
		{"no bot set up", Deps{Remote: &fakeRemote{on: true}, PhoneLink: &fakeLinkSender{}}, http.StatusConflict},
		{"telegram refused", Deps{Remote: &fakeRemote{on: true}, PhoneLink: &fakeLinkSender{ready: true, err: errors.New("chat not found")}}, http.StatusBadGateway},
	} {
		s, _, _, _ := pairedPhones(t, tc.deps)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, localPost("/v1/pair/send-link"))
		if w.Code != tc.want {
			t.Errorf("%s: %d %s, want %d", tc.name, w.Code, w.Body, tc.want)
		}
	}
}

// The panel offers the button only when there is a chat to send to.
func TestPairStateSaysWhetherTelegramIsSetUp(t *testing.T) {
	for _, ready := range []bool{false, true} {
		s, _, _, _ := pairedPhones(t, Deps{Remote: &fakeRemote{on: true}, PhoneLink: &fakeLinkSender{ready: ready}})
		r := httptest.NewRequest(http.MethodGet, "/v1/pair/state", nil)
		r.RemoteAddr, r.Host = "127.0.0.1:51000", "127.0.0.1:22776"
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		var st struct {
			Telegram bool `json:"telegram"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != http.StatusOK {
			t.Fatalf("state: %d %s", w.Code, w.Body)
		}
		if st.Telegram != ready {
			t.Errorf("telegram %v with a bot set up %v", st.Telegram, ready)
		}
	}
}
