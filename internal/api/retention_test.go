package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRetentionOffersAndKeeps(t *testing.T) {
	e := newEnv(t)
	days, set := 30, false
	var bad error
	var asked int
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: &fakeAgents{avail: true},
		ReadRetention: func() (int, bool, error) { return days, set, nil },
		KeepTranscripts: func(d int) error {
			if bad != nil {
				return bad
			}
			asked, days, set = d, d, true
			return nil
		},
	})
	do := func(method string) (int, Retention) {
		req := httptest.NewRequest(method, "/v1/claude/retention", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		var r Retention
		_ = json.Unmarshal(rr.Body.Bytes(), &r)
		return rr.Code, r
	}
	if code, r := do("GET"); code != http.StatusOK || !r.Offer || r.Days != 30 || r.Set || r.KeepDays != 36500 {
		t.Fatalf("unset: %d %+v", code, r)
	}
	days, set = 90, true
	if _, r := do("GET"); !r.Offer {
		t.Fatalf("90 days is still offered: %+v", r)
	}
	days = 91
	if _, r := do("GET"); r.Offer {
		t.Fatalf("a period over 90 days is the user's own choice: %+v", r)
	}
	days, set = 30, false
	bad = errors.New("parse settings.json: invalid character")
	if code, _ := do("POST"); code != http.StatusConflict || asked != 0 {
		t.Fatalf("invalid file: %d, asked %d", code, asked)
	}
	bad = nil
	if code, r := do("POST"); code != http.StatusOK || asked != 36500 || r.Offer || r.Days != 36500 {
		t.Fatalf("keep: %d %+v asked %d", code, r, asked)
	}
}

func TestRetentionNotWiredIs501(t *testing.T) {
	e := newEnv(t)
	e.srv.Config.Handler = New(Deps{Store: e.st, Version: "t", Token: "tok", Now: func() time.Time { return e.now }, Agents: &fakeAgents{avail: true}})
	for _, m := range []string{"GET", "POST"} {
		req := httptest.NewRequest(m, "/v1/claude/retention", bytes.NewBufferString(`{}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		e.srv.Config.Handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusNotImplemented {
			t.Fatalf("%s: got %d", m, rr.Code)
		}
	}
}
