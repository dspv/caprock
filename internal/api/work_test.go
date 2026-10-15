package api

import (
	"context"
	"net/http"
	"testing"
)

type fakeWork struct{ w Work }

func (f fakeWork) Work(context.Context) (Work, error) { return f.w, nil }

// GET /v1/work answers the daemon's board as is, with absent fields left
// out rather than zero; without one, 501.
func TestWorkEndpoint(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/work", nil); code != http.StatusNotImplemented {
		t.Fatalf("no board: %d", code)
	}
	ahead := 4
	e.api.d.Work = fakeWork{w: Work{
		Now: 10, DayStart: 1, Hive: "off",
		Sessions: []WorkSession{{
			SessionID: "s1", Agent: "claude", State: WorkWorking, Project: "p", TurnLeft: &ETA{LoMs: 1, MidMs: 2, HiMs: 3},
			PRs: []WorkPR{{Number: 7, URL: "u"}}, Link: LinkRecorded, TodayUSD: 1.5,
		}},
		Queued: []WorkQueued{{SessionID: "s1", Position: 1, Text: "next"}},
		Repos: []WorkRepo{{Root: "/r", Name: "r", ViaSession: "s1", Live: 1,
			Unreleased: &WorkUnreleased{Ref: "origin/main", Items: []string{"a"}, Count: 1},
			Tags:       &WorkTags{Last: &WorkTag{Name: "v1", At: 5}, Gaps: 2}, AheadOfTag: &ahead}},
		Totals: WorkTotals{Live: 1, Working: 1, TodayUSD: 1.5, MachineTodayUSD: 2},
	}}
	var got map[string]any
	if code := e.get(t, "/v1/work", &got); code != 200 {
		t.Fatalf("work: %d", code)
	}
	if _, ok := got["tasks"]; ok {
		t.Fatalf("tasks present with the runner off: %v", got["tasks"])
	}
	s := got["sessions"].([]any)[0].(map[string]any)
	if s["state"] != "working" || s["turn_left"].(map[string]any)["mid_ms"] != float64(2) || s["link"] != "recorded" {
		t.Fatalf("session = %v", s)
	}
	if _, ok := s["estimate"]; ok {
		t.Fatalf("an absent estimate was sent: %v", s)
	}
	r := got["repos"].([]any)[0].(map[string]any)
	tags := r["tags"].(map[string]any)
	if r["ahead_of_tag"] != float64(4) || tags["gaps"] != float64(2) || tags["gap_median_ms"] != nil {
		t.Fatalf("repo = %v", r)
	}
	if got["totals"].(map[string]any)["machine_today_usd"] != float64(2) {
		t.Fatalf("totals = %v", got["totals"])
	}
}
