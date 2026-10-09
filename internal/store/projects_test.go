package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/event"
)

// A root is one row: adding it again lists it again rather than duplicating
// it, and seeding never brings back a project the owner unlisted.
func TestAProjectRootIsOneRow(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	db := s.DB()
	p, created, err := InsertProject(ctx, db, Project{Root: `C:\work\app\`, Name: "app", Kind: ProjectKindRepo, Source: ProjectSourceFolder, AddedAt: 1})
	if err != nil || !created || p.Root != "C:/work/app" {
		t.Fatalf("insert: %+v created=%v err=%v; the root is stored in sessions.repo_root's form", p, created, err)
	}
	if err := ArchiveProject(ctx, db, p.ID, 5); err != nil {
		t.Fatal(err)
	}
	if added, err := SeedProject(ctx, db, Project{Root: "C:/work/app", Name: "app", Kind: ProjectKindRepo, Source: ProjectSourceSession, AddedAt: 9}); err != nil || added {
		t.Fatalf("seeding re-added an unlisted project: added=%v err=%v", added, err)
	}
	if list, _ := ListProjects(ctx, db, false); len(list) != 0 {
		t.Fatalf("listed %d; an unlisted project showed", len(list))
	}
	again, created, err := InsertProject(ctx, db, Project{Root: "C:/work/app", Name: "other", Kind: ProjectKindRepo, Source: ProjectSourceFolder, AddedAt: 9})
	if err != nil || created || again.ID != p.ID || again.ArchivedAt != 0 || again.Name != "app" {
		t.Fatalf("re-add: %+v created=%v err=%v", again, created, err)
	}
	name, pinned := "App", true
	if err := UpdateProject(ctx, db, p.ID, ProjectPatch{Name: &name, Pinned: &pinned}); err != nil {
		t.Fatal(err)
	}
	if err := UpdateProject(ctx, db, 404, ProjectPatch{Name: &name}); !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
	got, _ := GetProject(ctx, db, p.ID)
	if got.Name != "App" || !got.Pinned {
		t.Fatalf("%+v", got)
	}
}

// Live, waiting and today's spend per directory: waiting is a live session
// whose newest event is a permission prompt or a main-thread Stop with no
// subagent still working, and an
// internal event's cost is in no total.
func TestProjectActivity(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	db := s.DB()
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	for _, id := range []string{"waits", "asks", "works", "subagent", "background", "ended"} {
		if err := UpsertSession(ctx, db, id, SessionPatch{Cwd: "/nowhere/proj"}); err != nil {
			t.Fatal(err)
		}
	}
	usd := func(v float64) *float64 { return &v }
	evs := []event.Event{
		{SessionID: "waits", Kind: event.KindTurnAssistant, Model: "claude-opus-4-1", CostUSD: usd(1.5), Ts: now.Add(-time.Minute)},
		{SessionID: "waits", Kind: event.KindAgentStop, Ts: now},
		{SessionID: "asks", Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: now},
		{SessionID: "works", Kind: event.KindToolPre, Tool: "Bash", Ts: now},
		{SessionID: "subagent", Kind: event.KindAgentStop, AgentID: "a1", Ts: now},
		// Its turn ended with a subagent still at work: not waiting on anyone.
		{SessionID: "background", Kind: event.KindToolPre, Tool: "Bash", AgentID: "a2", Ts: now.Add(-2 * time.Second)},
		{SessionID: "background", Kind: event.KindAgentStop, Ts: now.Add(-time.Second)},
		{SessionID: "works", Kind: event.KindTurnAssistant, Model: "codex-auto-review", CostUSD: usd(9), Ts: now},
		{SessionID: "ended", Kind: event.KindTurnAssistant, Model: "claude-opus-4-1", CostUSD: usd(0.25), Ts: midnight.Add(-time.Hour)},
	}
	for i := range evs {
		if _, err := InsertEvent(ctx, db, &evs[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err := SetExit(ctx, db, "ended", 0); err != nil {
		t.Fatal(err)
	}
	act, err := ProjectActivityByDir(ctx, db, midnight.UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	a := act["/nowhere/proj"]
	if a == nil {
		t.Fatalf("no activity for the folder: %v", act)
	}
	if a.Total != 6 || a.Live != 5 || a.Waiting != 2 {
		t.Fatalf("total %d live %d waiting %d; want 6, 5, 2", a.Total, a.Live, a.Waiting)
	}
	if a.CostToday != 1.5 {
		t.Fatalf("cost today %v; want 1.5 (yesterday's and the internal review's left out)", a.CostToday)
	}
}

func TestProjectWorthListing(t *testing.T) {
	for _, dir := range []string{"/", DefaultTempDirs()[0], "/x/repo/.caprock-worktrees/w1"} {
		if ProjectWorthListing(dir) {
			t.Errorf("%s would be listed", dir)
		}
	}
}
