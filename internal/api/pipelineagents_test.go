package api

import (
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// /v1/pipeline/agents needs a folder, answers both figures' windows for
// one, and refuses a request naming more folders than a repository has.
func TestPipelineAgentsEndpoint(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	if code := e.get(t, "/v1/pipeline/agents", nil); code != 400 {
		t.Fatalf("no repo: %d, want 400", code)
	}
	var got store.RepoAgents
	if code := e.get(t, "/v1/pipeline/agents?repo=/nowhere", &got); code != 200 {
		t.Fatalf("one repo: %d", code)
	}
	if got.Days != store.RepoAgentDays || len(got.Rate.Series) != store.RepoAgentDays+1 || len(got.Team.Series) != store.RepoTeamDays+1 {
		t.Fatalf("answer = %+v", got)
	}
	if got.Rate.Usual != nil || got.Team.Now.Sessions != 0 {
		t.Fatalf("a folder with no session has figures: %+v", got)
	}
	q := "/v1/pipeline/agents?"
	for i := 0; i <= maxPipelineRoots; i++ {
		q += "repo=/r&"
	}
	if code := e.get(t, q, nil); code != 400 {
		t.Fatalf("too many folders: %d, want 400", code)
	}
}
