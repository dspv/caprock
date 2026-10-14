// A code carries the role the owner chose when showing it (ADR-034, amended
// 2026-10-14). The owner's phone (translated): "I scan it with the phone,
// install the app, go in — and I can't do anything, and say I've already left
// the house." A newly paired phone was a viewer until a second click on the
// machine; now the tick beside Show a code is that click, made first.
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/pairing"
)

// asDevice sends a request from the tablet holding token.
func (e *pairEnv) asDevice(method, path, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set(deviceTokenHeader, token)
	r.RemoteAddr = tablet
	r.Host = "127.0.0.1:4173"
	w := httptest.NewRecorder()
	e.s.ServeHTTP(w, r)
	return w
}

// savedDevice is the device with id as devices.json holds it.
func (e *pairEnv) savedDevice(t *testing.T, id string) pairing.Device {
	t.Helper()
	saved, err := config.ReadDevices(e.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range saved {
		if d.ID == id {
			return d
		}
	}
	t.Fatalf("device %s is not saved: %+v", id, saved)
	return pairing.Device{}
}

func (e *pairEnv) codeAs(t *testing.T, body string) (code, role string) {
	t.Helper()
	w := e.do(t, http.MethodPost, "/v1/pair/code", owner, body)
	if w.Code != http.StatusOK {
		t.Fatalf("issue a code with %q: %d %s", body, w.Code, w.Body)
	}
	var got struct {
		Code string `json:"code"`
		Role string `json:"role"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Code, got.Role
}

func (e *pairEnv) redeem(t *testing.T, code string) pairResponse {
	t.Helper()
	w := e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+code+`","name":"Android phone · Chrome"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("redeem: %d %s", w.Code, w.Body)
	}
	var got pairResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestACodeCarriesTheRoleTheOwnerTicked(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
	}{
		{"ticked", `{"role":"controller"}`, pairing.RoleController},
		{"unticked", `{"role":"viewer"}`, pairing.RoleViewer},
		{"no role (an older dashboard, caprock pair)", `{}`, pairing.RoleViewer},
		{"no body", "", pairing.RoleViewer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newPairEnv(t)
			code, role := e.codeAs(t, tc.body)
			if role != tc.want {
				t.Errorf("the code says role %q, want %q", role, tc.want)
			}
			// The owner's panel sees what the outstanding code pairs as.
			var st pairState
			if err := json.Unmarshal(e.do(t, http.MethodGet, "/v1/pair/state", owner, "").Body.Bytes(), &st); err != nil {
				t.Fatal(err)
			}
			if st.CodeRole != tc.want {
				t.Errorf("state code_role %q, want %q", st.CodeRole, tc.want)
			}
			dev := e.redeem(t, code)
			if got := e.ps.RoleOf(dev.Token); got != tc.want {
				t.Errorf("paired as %q, want %q", got, tc.want)
			}
			// The role is saved with the device: it holds after a restart.
			if got := e.savedDevice(t, dev.ID).Role; got != tc.want {
				t.Errorf("devices.json holds role %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAControllerCodeLetsThePhoneTypeAtOnce(t *testing.T) {
	e := newPairEnv(t)
	code, _ := e.codeAs(t, `{"role":"controller"}`)
	dev := e.redeem(t, code)
	r := phoneRequest("POST /v1/agents", dev.Token)
	if got, _ := e.s.gate(r); got != 0 {
		t.Errorf("a phone paired with a ticked code was refused a controller route: %d", got)
	}
	// And the other way: an unticked code makes a viewer the gate refuses.
	code, _ = e.codeAs(t, `{"role":"viewer"}`)
	dev = e.redeem(t, code)
	r = phoneRequest("POST /v1/agents", dev.Token)
	if got, _ := e.s.gate(r); got != http.StatusForbidden {
		t.Errorf("a phone paired with an unticked code: %d, want 403", got)
	}
}

func TestOnlyTheMachineChoosesACodesRole(t *testing.T) {
	e := newPairEnv(t)
	if w := e.do(t, http.MethodPost, "/v1/pair/code", tablet, `{"role":"controller"}`); w.Code == http.StatusOK || e.ps.CodeRole() != "" {
		t.Errorf("a device issued a controller code: %d", w.Code)
	}
	for _, body := range []string{`{"role":"owner"}`, `not json`} {
		if w := e.do(t, http.MethodPost, "/v1/pair/code", owner, body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", body, w.Code)
		}
	}
	// The device's own request names no role: what it sends is ignored.
	code, _ := e.codeAs(t, `{"role":"viewer"}`)
	w := e.do(t, http.MethodPost, "/v1/pair", tablet, `{"code":"`+code+`","name":"x","role":"controller"}`)
	var got pairResponse
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if e.ps.RoleOf(got.Token) != pairing.RoleViewer {
		t.Error("a device chose its own role")
	}
}

func TestThePhoneReportsTheInstalledApp(t *testing.T) {
	e := newPairEnv(t)
	code, _ := e.codeAs(t, `{"role":"controller"}`)
	dev := e.redeem(t, code)
	me := func(q string) pairMe {
		t.Helper()
		w := e.asDevice(http.MethodGet, "/v1/pair/me"+q, dev.Token)
		var m pairMe
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil || w.Code != 200 {
			t.Fatalf("pair/me%s: %d %s", q, w.Code, w.Body)
		}
		return m
	}
	installed := func() bool {
		for _, d := range e.ps.Devices() {
			if d.ID == dev.ID {
				return d.App
			}
		}
		t.Fatal("device gone")
		return false
	}
	if m := me(""); m.Installed || installed() {
		t.Error("installed before the phone said so")
	}
	if m := me("?app=1"); !m.Installed || !installed() {
		t.Error("?app=1 was not recorded")
	}
	if !e.savedDevice(t, dev.ID).App {
		t.Error("the installed app is not saved with the device")
	}
	if me("?app=nonsense"); !installed() {
		t.Error("an unknown value changed it")
	}
	if m := me("?app=0"); m.Installed || installed() {
		t.Error("?app=0 was not recorded")
	}
}
