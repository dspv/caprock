package brain

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

func TestCleanExcludeKeepsAbsoluteFoldersOnly(t *testing.T) {
	got, err := CleanExclude([]string{" /Users/u/dev/ops/ ", "", "/Users/u/dev/ops", "/Users/u/dev/web"})
	if err != nil || len(got) != 2 || got[0] != "/Users/u/dev/ops" || got[1] != "/Users/u/dev/web" {
		t.Fatalf("clean: %v %v", got, err)
	}
	for _, bad := range [][]string{{"dev/ops"}, {"/"}, {"/Users/u/dev\nops"}, {strings.Repeat("/a", 600)}} {
		if _, err := CleanExclude(bad); !errors.Is(err, ErrExclude) {
			t.Errorf("%q: %v, want ErrExclude", bad, err)
		}
	}
	many := make([]string, ExcludeMax+1)
	for i := range many {
		many[i] = "/Users/u/dev/p" + strings.Repeat("x", i%7) + string(rune('a'+i%26))
	}
	if _, err := CleanExclude(many); !errors.Is(err, ErrExclude) {
		t.Errorf("over the limit: %v", err)
	}
	if dir, ok := ExcludedFolder(got, "/Users/u/dev/ops/briefs", ""); !ok || dir != "/Users/u/dev/ops" {
		t.Errorf("under: %q %v", dir, ok)
	}
	if _, ok := ExcludedFolder(got, "/Users/u/dev/opsx", ""); ok {
		t.Error("a sibling with the same prefix is not under it")
	}
	if dir, ok := ExcludedFolder(got, "/Users/u/dev/web/ui", "/Users/u/dev/web"); !ok || dir != "/Users/u/dev/web" {
		t.Errorf("by the repository root: %q %v", dir, ok)
	}
	if _, ok := ExcludedFolder(nil, "/Users/u/dev/ops", ""); ok {
		t.Error("nothing is excluded by an empty list")
	}
	if p := ExcludedProjects([]string{"/Users/u/dev/ops", "/Users/u/old/ops"}); len(p) != 1 || p[0] != "ops" {
		t.Errorf("projects: %v", p)
	}
}

// A session in an excluded folder is recorded as skipped with the folder,
// its cursor moved, and never sent; the estimate leaves it out; a session
// elsewhere is read as before.
func TestAnExcludedFolderIsSkippedWithTheReason(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	// A session's folder; its last event stays where session() put it (an
	// upsert without one would stamp it now and make the session busy).
	place := func(id, cwd string, ago time.Duration) {
		t.Helper()
		if err := store.UpsertSession(ctx, e.st.DB(), id, store.SessionPatch{Cwd: cwd, LastEventAt: e.now.Add(-ago).UnixMilli()}); err != nil {
			t.Fatal(err)
		}
	}
	e.session(t, "scout", "ops", time.Hour, [2]string{"Your whole task is in the brief", long})
	place("scout", "/Users/u/dev/ops/briefs", time.Hour)
	e.session(t, "work", "web", time.Hour, [2]string{"q", long})
	place("work", "/Users/u/dev/web", time.Hour)
	e.cfg.Exclude = []string{"/Users/u/dev/ops"}

	est, err := e.eng.EstimateFrom(ctx, e.cfg.Since)
	if err != nil || est.Sessions != 1 {
		t.Fatalf("estimate counts the excluded session: %+v %v", est, err)
	}
	if n, err := e.eng.Wake(ctx); err != nil || n != 1 || e.calls != 1 {
		t.Fatalf("wake: %d calls=%d %v; only the other session is read", n, e.calls, err)
	}
	if strings.Contains(e.reqs[0].Prompt, "whole task") {
		t.Fatal("the excluded session's prose was sent")
	}
	runs, err := store.BrainRunsOf(ctx, e.st.DB(), "scout")
	if err != nil || len(runs) != 1 || runs[0].Status != store.BrainRunSkipped || runs[0].Error != store.BrainSkipExcluded+": /Users/u/dev/ops" {
		t.Fatalf("the skip is recorded with its reason: %+v %v", runs, err)
	}
	if cands, _ := e.eng.candidates(ctx, 10); len(cands) != 0 {
		t.Fatalf("still waiting: %+v", cands)
	}
	// Taken off the list, the folder is read again once it has new events.
	e.cfg.Exclude = nil
	e.session(t, "scout", "ops", 30*time.Minute, [2]string{"more", long})
	place("scout", "/Users/u/dev/ops/briefs", 30*time.Minute)
	if n, _ := e.eng.Wake(ctx); n != 1 || e.calls != 2 {
		t.Fatalf("after the exclusion is lifted: %d calls=%d", n, e.calls)
	}
}

// A session started with automation: true is marked at its spawn and never
// becomes a candidate: nothing is sent, nothing waits, the estimate leaves
// it out, and the status counts it.
func TestAnAutomationSessionIsNeverRead(t *testing.T) {
	e := newEnv(t, twoMemories)
	ctx := context.Background()
	if err := store.MarkBrainAutomation(ctx, e.st.DB(), "job", e.now.Add(-2*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkBrainAutomation(ctx, e.st.DB(), "job", e.now.Add(-2*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	e.session(t, "job", "web", time.Hour, [2]string{"You are the scout", long})
	e.session(t, "person", "web", time.Hour, [2]string{"q", long})
	if ok, err := store.BrainAutomation(ctx, e.st.DB(), "job"); err != nil || !ok {
		t.Fatalf("marked: %v %v", ok, err)
	}
	if ok, _ := store.BrainAutomation(ctx, e.st.DB(), "person"); ok {
		t.Fatal("a person's session is not marked")
	}
	if runs, _ := store.BrainRunsOf(ctx, e.st.DB(), "job"); len(runs) != 1 {
		t.Fatalf("one mark, not two: %+v", runs)
	}
	est, _ := e.eng.EstimateFrom(ctx, e.cfg.Since)
	if est.Sessions != 1 {
		t.Fatalf("estimate: %+v", est)
	}
	if n, _ := e.eng.Wake(ctx); n != 1 || e.calls != 1 || strings.Contains(e.reqs[0].Prompt, "scout") {
		t.Fatalf("wake: %d calls=%d", n, e.calls)
	}
	st := e.eng.Status(ctx)
	if st.Pending != 0 || st.Automation24h != 1 || st.Build == nil || st.Build.Read != 1 {
		t.Fatalf("status: pending %d automation %d build %+v", st.Pending, st.Automation24h, st.Build)
	}
	if len(st.Exclude) != 0 {
		t.Errorf("exclude is [] by default: %v", st.Exclude)
	}
}
