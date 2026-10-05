package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A machine on Wi-Fi and Tailscale answers on both addresses and on the
// MagicDNS name (WP-15). The pairing panel lists each with its kind; a phone
// that opened any of them pairs and is served; a name the daemon was not told
// about is still refused (DNS rebinding), and turning network access off
// forgets them all.
func TestTheTailscaleAddressAndNameAreServedBesideTheLANOne(t *testing.T) {
	e := newPairEnv(t)
	const tsURL, nameURL = "http://100.101.102.103:4173", "http://studio-mac.tail1234.ts.net:4173"
	e.s.SetLANAlternates([]string{tsURL, nameURL})

	var st pairState
	w := e.do(t, http.MethodGet, "/v1/pair/state", owner, "")
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	want := []pairAddress{{"http://192.168.1.10:4173", "lan"}, {tsURL, "tailscale"}, {nameURL, "magicdns"}}
	if len(st.Addresses) != len(want) {
		t.Fatalf("addresses: %+v", st.Addresses)
	}
	for i := range want {
		if st.Addresses[i] != want[i] {
			t.Errorf("address %d: %+v, want %+v", i, st.Addresses[i], want[i])
		}
	}

	// A code is redeemed by a phone that opened the MagicDNS name off the Wi-Fi.
	code := issueCode(t, e)
	host := "studio-mac.tail1234.ts.net:4173"
	w = browserRequest(e.s, http.MethodPost, "/v1/pair", "100.64.0.9:51000", host, "http://"+host, `{"code":"`+code+`","name":"iPhone"}`, "")
	if w.Code != http.StatusOK {
		t.Fatalf("redeem over MagicDNS: %d %s", w.Code, w.Body)
	}
	var paired pairResponse
	_ = json.Unmarshal(w.Body.Bytes(), &paired)
	for _, h := range []string{host, "100.101.102.103:4173", "192.168.1.10:4173"} {
		if w := browserRequest(e.s, http.MethodGet, "/v1/pair/me", "100.64.0.9:51000", h, "http://"+h, "", paired.Token); w.Code != http.StatusOK {
			t.Errorf("paired phone at %s: %d %s", h, w.Code, w.Body)
		}
	}
	// A name nobody named: the rebinding guard still holds.
	if w := browserRequest(e.s, http.MethodGet, "/v1/pair/me", "100.64.0.9:51000", "evil.example:4173", "http://evil.example:4173", "", paired.Token); w.Code != http.StatusForbidden {
		t.Errorf("unnamed host: %d, want 403", w.Code)
	}

	// Off forgets the alternates; and they cannot be set while off.
	e.s.SetLAN(nil, "")
	e.s.SetLANAlternates([]string{tsURL})
	if got := e.s.lanHosts(); len(got) != 0 {
		t.Errorf("hosts while off: %v", got)
	}
}

func issueCode(t *testing.T, e *pairEnv) string {
	t.Helper()
	w := e.do(t, http.MethodPost, "/v1/pair/code", owner, `{}`)
	var issued struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &issued); err != nil || issued.Code == "" {
		t.Fatalf("code: %d %s", w.Code, w.Body)
	}
	return issued.Code
}

// browserRequest is a request as a phone's browser sends it to host.
func browserRequest(s *Server, method, path, from, host, origin, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Origin", origin)
	if token != "" {
		r.Header.Set(deviceTokenHeader, token)
	}
	r.RemoteAddr, r.Host = from, host
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
