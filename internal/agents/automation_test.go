package agents

import (
	"context"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A spawn with automation: true marks the session for Second Brain in the
// same transaction that records it as owned; an ordinary spawn leaves no
// mark.
func TestSpawnAutomationMarksTheSessionForSecondBrain(t *testing.T) {
	for _, auto := range []bool{true, false} {
		m, st, _ := newMgr(t)
		ag, err := m.Spawn(context.Background(), SpawnRequest{Cwd: t.TempDir(), Automation: auto})
		if err != nil {
			t.Fatal(err)
		}
		marked, err := store.BrainAutomation(context.Background(), st.DB(), ag.SessionID)
		if err != nil || marked != auto {
			t.Errorf("automation %v: marked %v (%v)", auto, marked, err)
		}
		m.Shutdown()
	}
}
