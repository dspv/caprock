// The pairing endpoints, from the two sides they are written for.
//
// The split is the whole point: the owner sits at the machine on loopback and
// may issue codes, list devices and revoke them; a device on the network holds
// nothing and may do exactly one thing — exchange a code for a token, once. A
// paired tablet that could issue a code would be a second control room, and one
// that could revoke would be able to lock the laptop out of its own daemon.
// None of that is enforced by the gate in lanauth.go, which lets the pairing
// paths through by design, so it is enforced in these handlers and asserted
// here.
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
)

// pairEnv is a server with LAN access on, addressable both as the owner
// (loopback) and as a device on the network (a synthetic RemoteAddr the kernel
// would set and a caller cannot forge).
type pairEnv struct {
	s       *Server
	ps      *pairing.Store
	dataDir string
}

func newPairEnv(t *testing.T) *pairEnv {
	t.Helper()
	ps := pairing.New()
	dir := t.TempDir()
	s := New(Deps{Version: "test", Token: "tok", Pairing: ps, LANURL: "http://192.168.1.10:4173", DataDir: dir})
	return &pairEnv{s: s, ps: ps, dataDir: dir}
}

// do sends a request from a given address, shaped the way the dashboard sends
// it: Sec-Fetch-Site names it a same-origin browser request, which is what the
// forgery guard in csrf.go looks for before it starts demanding a JSON content
// type on a bodiless DELETE.
func (e *pairEnv) do(t *testing.T, method, path, from, body string) *httptest.ResponseRecorder {
	t.Helper()
	return serveAs(e.s, method, path, from, body)
}

func serveAs(s *Server, method, path, from, body string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.RemoteAddr = from
	r.Host = "127.0.0.1:4173"
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

const (
	owner   = "127.0.0.1:51000"
	tablet  = "192.168.1.50:51000"
	tablet6 = "[fd00::5]:51000"
)

// Everything an owner does is refused off-loopback. This is the list of things
// a device that has already paired must still not be able to do.
func TestOnlyTheOwnerManagesPairing(t *testing.T) {
	e := newPairEnv(t)
	code, err := e.ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := e.ps.Redeem(code, "tablet")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"read the device list", http.MethodGet, "/v1/pair/state", ""},
		{"issue a new code", http.MethodPost, "/v1/pair/code", `{}`},
		{"revoke one device", http.MethodDelete, "/v1/pair/devices/some-id", ""},
		{"revoke every device", http.MethodDelete, "/v1/pair/devices/all", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, from := range []string{tablet, tablet6} {
				// Two layers refuse these, and either is a pass: the gate in
				// lanauth.go answers 401 for a request off the network that
				// carries no device token, and the handler's own loopback check
				// answers 403 for one that does. What must never happen is a
				// 2xx.
				w := e.do(t, tc.method, tc.path, from, tc.body)
				if w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
					t.Errorf("from %s: status %d; want a refusal — a device off the network is not a second control room", from, w.Code)
				}
			}
			// The case the handlers exist for. This device holds a token the
			// gate accepts, so the gate waves it through and only the
			// handler's own loopback check stands between a paired tablet and
			// the ability to admit a third device or revoke the laptop that
			// let it in. It must be a 403, not merely "not a 2xx".
			paired := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				paired.Header.Set("Content-Type", "application/json")
			}
			paired.Header.Set("Sec-Fetch-Site", "same-origin")
			paired.Header.Set(deviceTokenHeader, dev.Token)
			paired.RemoteAddr = tablet
			paired.Host = "127.0.0.1:4173"
			pw := httptest.NewRecorder()
			e.s.ServeHTTP(pw, paired)
			if pw.Code != http.StatusForbidden {
				t.Errorf("a paired device got %d for %s %s; want 403 — pairing is managed from the machine Caprock runs on", pw.Code, tc.method, tc.path)
			}

			// The same call from the machine itself is allowed.
			w := e.do(t, tc.method, tc.path, owner, tc.body)
			if w.Code == http.StatusForbidden || w.Code == http.StatusUnauthorized {
				t.Errorf("the owner on loopback was refused with %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

// The owner's view: whether the listener is up, at what address, the live code
// and its countdown, and every paired device — without the tokens, which the UI
// must never see again after the moment of pairing.
func TestPairStateShowsTheOwnerWhatTheyNeed(t *testing.T) {
	e := newPairEnv(t)

	var before pairState
	w := e.do(t, http.MethodGet, "/v1/pair/state", owner, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	if !before.Enabled {
		t.Error("Enabled is false while a pairing store exists; the screen would say network access is off")
	}
	if before.URL != "http://192.168.1.10:4173" {
		t.Errorf("URL = %q; want the address to type into the other device", before.URL)
	}
	if before.Code != "" || before.ExpiresInSec != 0 {
		t.Errorf("a code is shown before one was issued: %q", before.Code)
	}
	// Never null: the dashboard maps over this, and null renders as a crash
	// rather than an empty list.
	if before.Devices == nil {
		t.Error("Devices is null rather than an empty array")
	}

	// After issuing a code, the owner sees it and its countdown.
	w = e.do(t, http.MethodPost, "/v1/pair/code", owner, `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("new code: status %d: %s", w.Code, w.Body)
	}
	var issued struct {
		Code      string `json:"code"`
		ExpiresIn int    `json:"expires_in_sec"`
		URL       string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	if issued.Code == "" {
		t.Fatal("no code was issued")
	}
	if issued.ExpiresIn <= 0 {
		t.Errorf("expires_in_sec = %d; the screen counts down from this", issued.ExpiresIn)
	}
	if issued.URL != "http://192.168.1.10:4173" {
		t.Errorf("url = %q; the pairing screen encodes this into its QR code", issued.URL)
	}

	var after pairState
	w = e.do(t, http.MethodGet, "/v1/pair/state", owner, "")
	if err := json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if after.Code != issued.Code {
		t.Errorf("state shows code %q; want the one just issued (%q) — the owner reads it off this screen", after.Code, issued.Code)
	}
	if after.ExpiresInSec <= 0 {
		t.Errorf("expires_in_sec = %d in the state view", after.ExpiresInSec)
	}
}

// The one thing a device may do before it is trusted, and the guarantees around
// it: a code works once, a wrong code says nothing useful, and the token comes
// back exactly once.
func TestRedeemingACode(t *testing.T) {
	e := newPairEnv(t)
	w := e.do(t, http.MethodPost, "/v1/pair/code", owner, `{}`)
	var issued struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}

	// The device redeems from the network — this is the only pairing path that
	// works off-loopback, and it has to, or there is no way in.
	w = e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+issued.Code+`","name":"kitchen tablet"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("a device could not redeem a valid code: %d %s", w.Code, w.Body)
	}
	var got pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Token == "" || got.ID == "" {
		t.Fatalf("redeem returned no credential: %+v", got)
	}
	if got.Name != "kitchen tablet" {
		t.Errorf("name = %q; want the one the device sent, so the revoke list is readable", got.Name)
	}

	// Once. A code someone read out loud in a room must not admit a second
	// listener.
	w = e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+issued.Code+`","name":"someone else"}`)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("the same code was redeemed twice: %d %s", w.Code, w.Body)
	}
}

// Wrong, expired, exhausted and never-issued all answer the same. Each
// distinction tells someone guessing how close they are, and the code is short
// enough to guess.
func TestEveryBadCodeGetsTheSameAnswer(t *testing.T) {
	e := newPairEnv(t)
	// A code that exists, so "never issued" and "wrong" are distinguishable
	// states inside the store even though the response must not distinguish
	// them.
	if _, err := e.ps.NewCode(); err != nil {
		t.Fatal(err)
	}

	var bodies []string
	var codes []int
	for _, body := range []string{
		`{"code":"000000","name":"guess"}`,
		`{"code":"","name":"empty"}`,
		`{"code":"not-a-code","name":"junk"}`,
	} {
		w := e.do(t, http.MethodPost, "/v1/pair", tablet, body)
		codes = append(codes, w.Code)
		bodies = append(bodies, w.Body.String())
	}
	for i, c := range codes {
		if c != http.StatusUnauthorized {
			t.Errorf("case %d: status %d; want 401", i, c)
		}
		if bodies[i] != bodies[0] {
			t.Errorf("case %d answers differently from case 0:\n%s\n%s\nthat difference is a hint to whoever is guessing", i, bodies[i], bodies[0])
		}
	}
}

// A device that sends no name still gets a readable row. The revoke list is
// only useful if a row says which thing it is, and nobody names a tablet
// unprompted.
func TestAnUnnamedDeviceStillGetsAName(t *testing.T) {
	e := newPairEnv(t)
	code, err := e.ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	w := e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+code+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var got pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(got.Name) == "" {
		t.Error("a device with no name got a blank row in the revoke list")
	}
}

// A malformed body is a client mistake, not a failed authentication: answering
// 401 would send the owner looking for a pairing problem that is not there.
func TestRedeemRejectsAMalformedBody(t *testing.T) {
	e := newPairEnv(t)
	for _, body := range []string{`{not json`, `[]`, `"just a string"`} {
		w := e.do(t, http.MethodPost, "/v1/pair", tablet, body)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body %q: status %d; want 400", body, w.Code)
		}
	}
}

// Revoking is why the device list exists. Someone revokes a tablet because they
// lost it, so it has to take effect on this request — and the count has to be
// right, because that is what the screen reports back.
func TestRevokeRemovesADeviceAndReportsTheCount(t *testing.T) {
	e := newPairEnv(t)
	pair := func(name string) *pairing.Device {
		t.Helper()
		code, err := e.ps.NewCode()
		if err != nil {
			t.Fatal(err)
		}
		d, err := e.ps.Redeem(code, name)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	first := pair("tablet")
	pair("phone")

	// An id nobody holds is a 404, not a silent success — the screen would
	// otherwise report a revocation that never happened.
	if w := e.do(t, http.MethodDelete, "/v1/pair/devices/no-such-device", owner, ""); w.Code != http.StatusNotFound {
		t.Errorf("revoking an unknown id: status %d; want 404", w.Code)
	}

	w := e.do(t, http.MethodDelete, "/v1/pair/devices/"+first.ID, owner, "")
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: status %d: %s", w.Code, w.Body)
	}
	var n map[string]int
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil {
		t.Fatal(err)
	}
	if n["revoked"] != 1 {
		t.Errorf("revoked = %d; want 1", n["revoked"])
	}
	if len(e.ps.Devices()) != 1 {
		t.Errorf("%d devices remain; want the one that was not revoked", len(e.ps.Devices()))
	}

	// "all" is the panic button — the whole list, in one call.
	w = e.do(t, http.MethodDelete, "/v1/pair/devices/all", owner, "")
	if w.Code != http.StatusOK {
		t.Fatalf("revoke all: status %d: %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil {
		t.Fatal(err)
	}
	if n["revoked"] != 1 {
		t.Errorf("revoked = %d for the remaining device; want 1", n["revoked"])
	}
	if len(e.ps.Devices()) != 0 {
		t.Errorf("%d devices survived a revoke-all", len(e.ps.Devices()))
	}
}

// Pairing and revoking both write the guest list to disk, or a restart sends
// the user walking back to their tablet to pair it again — the failure that
// made devices.json exist in the first place.
func TestPairingSurvivesARestart(t *testing.T) {
	e := newPairEnv(t)
	code, err := e.ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	w := e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+code+`","name":"tablet"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", w.Code, w.Body)
	}
	var dev pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &dev); err != nil {
		t.Fatal(err)
	}

	saved, err := config.ReadDevices(e.dataDir)
	if err != nil {
		t.Fatalf("ReadDevices: %v", err)
	}
	if len(saved) != 1 || saved[0].ID != dev.ID {
		t.Fatalf("the paired device was not written to disk: %+v", saved)
	}
	if saved[0].Token != dev.Token {
		t.Error("the stored device has a different token; it would be locked out after a restart")
	}

	// And revoking must take it off disk too, or a lost tablet is readmitted by
	// the next restart — the same bug with much worse consequences.
	if w := e.do(t, http.MethodDelete, "/v1/pair/devices/"+dev.ID, owner, ""); w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body)
	}
	saved, err = config.ReadDevices(e.dataDir)
	if err != nil {
		t.Fatalf("ReadDevices after revoke: %v", err)
	}
	if len(saved) != 0 {
		t.Errorf("a revoked device is still on disk: %+v — it would be readmitted on restart", saved)
	}
}

// With LAN access off there is nothing to pair with, and every pairing call has
// to say so rather than half-working. 409 rather than 404: the endpoint exists,
// the daemon is simply not listening on the network.
func TestPairingIsAConflictWhenLanIsOff(t *testing.T) {
	s := New(Deps{Version: "test", Token: "tok"}) // no pairing store
	call := func(method, path, body string) *httptest.ResponseRecorder {
		return serveAs(s, method, path, owner, body)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/pair/code", `{}`},
		{http.MethodPost, "/v1/pair", `{"code":"123456"}`},
		{http.MethodDelete, "/v1/pair/devices/all", ""},
	} {
		if w := call(tc.method, tc.path, tc.body); w.Code != http.StatusConflict {
			t.Errorf("%s %s: status %d; want 409 with an explanation of how to turn LAN access on", tc.method, tc.path, w.Code)
		}
	}
	// State is the exception: it must answer, because it is what the screen
	// reads to decide whether to offer the feature at all.
	w := call(http.MethodGet, "/v1/pair/state", "")
	if w.Code != http.StatusOK {
		t.Fatalf("pair state: status %d; the screen cannot render without it", w.Code)
	}
	var st pairState
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Enabled {
		t.Error("Enabled is true on a loopback-only daemon")
	}
	if st.Devices == nil {
		t.Error("Devices is null rather than an empty array; the dashboard maps over it")
	}
}

// A code expires. The countdown on the owner's screen is not decoration — an
// expired code must stop working, or a code photographed off a screen last week
// still admits whoever has the photo.
func TestAnExpiredCodeNoLongerWorks(t *testing.T) {
	e := newPairEnv(t)
	// The store's clock is injectable, which is why this needs no sleeping.
	base := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	now := base
	e.ps.Now = func() time.Time { return now }

	code, err := e.ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	now = base.Add(pairing.CodeTTL + time.Second)

	if w := e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+code+`","name":"late"}`); w.Code != http.StatusUnauthorized {
		t.Errorf("an expired code was accepted: %d %s", w.Code, w.Body)
	}
	// And the owner's screen stops offering it.
	w := e.do(t, http.MethodGet, "/v1/pair/state", owner, "")
	var st pairState
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st.Code != "" {
		t.Errorf("state still shows the expired code %q", st.Code)
	}
}

// The device list shown to the owner must never carry the tokens. It is the one
// response that would otherwise hand every paired device's credential to
// whatever is rendering the page.
func TestTheDeviceListNeverCarriesTokens(t *testing.T) {
	e := newPairEnv(t)
	code, err := e.ps.NewCode()
	if err != nil {
		t.Fatal(err)
	}
	dev, err := e.ps.Redeem(code, "tablet")
	if err != nil {
		t.Fatal(err)
	}

	w := e.do(t, http.MethodGet, "/v1/pair/state", owner, "")
	body := w.Body.String()
	if strings.Contains(body, dev.Token) {
		t.Fatalf("a device token appears in the state response:\n%s", body)
	}
	// Asserted on the raw JSON as well as the typed struct, because the leak
	// this guards against is a field added to pairing.Public, which would
	// deserialise into no field here and pass a struct-level check.
	var raw struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Devices) != 1 {
		t.Fatalf("got %d devices; want 1", len(raw.Devices))
	}
	for k := range raw.Devices[0] {
		if strings.Contains(strings.ToLower(k), "token") || strings.Contains(strings.ToLower(k), "secret") {
			t.Errorf("the device list exposes a %q field", k)
		}
	}
}
