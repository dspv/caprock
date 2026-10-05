package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

func (e *env) remove(t *testing.T, req RemoveRequest) (int, RemoveResult) {
	t.Helper()
	b, _ := json.Marshal(req)
	r, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/sessions/remove", bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var res RemoveResult
	_ = json.NewDecoder(resp.Body).Decode(&res)
	return resp.StatusCode, res
}

// A dry run lists and changes nothing; the real run takes the session out of
// the totals by exactly its cost, at once rather than after a cache refresh.
func TestRemoveSessions(t *testing.T) {
	e := newEnv(t)
	dir := t.TempDir()
	e.seed(t, dir)
	if _, err := e.st.DB().Exec(`UPDATE sessions SET status = 'ended' WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}
	var before store.Summary
	e.get(t, "/v1/stats/summary?range=all", &before)
	if before.CostUSD == 0 {
		t.Fatal("the seed costs nothing; the test would prove nothing")
	}

	code, dry := e.remove(t, RemoveRequest{CwdPrefix: dir, DryRun: true})
	if code != http.StatusOK || !dry.DryRun || len(dry.Sessions) != 1 || dry.Sessions[0].SessionID != "s1" || dry.CostUSD != before.CostUSD {
		t.Fatalf("dry run: %d %+v", code, dry)
	}
	var still store.Summary
	e.get(t, "/v1/stats/summary?range=all", &still)
	if still.CostUSD != before.CostUSD {
		t.Fatal("a dry run changed the totals")
	}

	code, done := e.remove(t, RemoveRequest{IDs: []string{"s1"}})
	if code != http.StatusOK || done.DryRun || len(done.Sessions) != 1 || done.UnmatchedUSD != 0 {
		t.Fatalf("remove: %d %+v", code, done)
	}
	var after store.Summary
	e.get(t, "/v1/stats/summary?range=all", &after)
	if after.CostUSD != before.CostUSD-done.CostUSD || after.Sessions != before.Sessions-1 {
		t.Fatalf("summary after: $%v, %d sessions; before: $%v, %d", after.CostUSD, after.Sessions, before.CostUSD, before.Sessions)
	}
	if code := e.get(t, "/v1/sessions/s1", nil); code != http.StatusNotFound {
		t.Fatalf("the removed session still answers: %d", code)
	}
}

// A session still running is skipped, not removed.
func TestRemoveSkipsARunningSession(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	code, res := e.remove(t, RemoveRequest{IDs: []string{"s1"}})
	if code != http.StatusOK || len(res.Sessions) != 0 || len(res.Skipped) != 1 {
		t.Fatalf("%d %+v", code, res)
	}
	if code := e.get(t, "/v1/sessions/s1", nil); code != http.StatusOK {
		t.Fatalf("a running session was removed: %d", code)
	}
	if code, _ := e.remove(t, RemoveRequest{}); code != http.StatusBadRequest {
		t.Fatalf("an empty filter: %d", code)
	}
}

// Removing is done on the machine: a phone gets 403 whatever its role
// (ADR-037), at the gate and again in the handler.
func TestRemovingSessionsIsTheMachinesAlone(t *testing.T) {
	s, _, viewer, controller := pairedPhones(t, Deps{})
	for _, dev := range []string{viewer.Token, controller.Token} {
		if got, _ := s.gate(phoneRequest("POST /v1/sessions/remove", dev)); got != http.StatusForbidden {
			t.Fatalf("a paired device reached the remove route: %d", got)
		}
	}
	if viewerMay["POST /v1/sessions/remove"] || controllerMayAlso["POST /v1/sessions/remove"] {
		t.Fatal("the role tables let a phone remove sessions")
	}
}
