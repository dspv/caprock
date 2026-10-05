package projects

import (
	"context"
	"path/filepath"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
)

// maxFollowed bounds the per-session maps follow keeps.
const maxFollowed = 2000

// follow reads the live bus for three things, none of which needs a timer:
// a session in a repository not yet listed (listed now, as the spec says a
// project is "the first time a session runs in a folder"), an agent's edit
// (which changes the working tree without touching `.git`, so git is asked
// again after editDebounce), and a session starting, stopping, asking or
// ending (a project frame with its live and waiting counts).
func (s *Service) follow(ctx context.Context, sub *bus.Subscriber) {
	defer sub.Unsubscribe()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-sub.C:
			if !ok {
				return
			}
			switch f.Type {
			case bus.FrameEvent:
				if ev, ok := f.Data.(event.Event); ok {
					s.noteEvent(ev)
				}
			case bus.FrameSession:
				if sf, ok := f.Data.(rollup.SessionFrame); ok {
					s.noteSession(ctx, sf.Session)
				}
			}
		}
	}
}

// noteEvent remembers what an event asks of its session's project, acted on
// when the session frame that follows it says which project that is.
func (s *Service) noteEvent(ev event.Event) {
	want := ""
	switch ev.Kind {
	case event.KindToolPost:
		switch ev.Tool {
		case "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "apply_patch", "shell":
			want = "git"
		}
	case event.KindAgentStop, event.KindPermissionPrompt, event.KindTurnUser, event.KindSessionEnd:
		want = "frame"
	}
	if want == "" {
		return
	}
	s.mu.Lock()
	if len(s.pending) > maxFollowed {
		s.pending = map[string]string{}
	}
	if s.pending[ev.SessionID] != "git" {
		s.pending[ev.SessionID] = want
	}
	s.mu.Unlock()
}

// noteSession lists a new repository, and schedules what noteEvent asked.
func (s *Service) noteSession(ctx context.Context, sess store.Session) {
	dir := sess.RepoRoot
	if dir == "" {
		dir = store.NormalizeDir(sess.Cwd)
	}
	if dir == "" {
		return
	}
	s.mu.Lock()
	prevDir, seen := s.sessRoot[sess.SessionID]
	if len(s.sessRoot) > maxFollowed {
		s.sessRoot = map[string]string{}
	}
	s.sessRoot[sess.SessionID] = dir + "|" + sess.Status
	want := s.pending[sess.SessionID]
	delete(s.pending, sess.SessionID)
	known := s.known[sess.RepoRoot]
	s.mu.Unlock()

	if sess.RepoRoot != "" && !known {
		s.mu.Lock()
		s.known[sess.RepoRoot] = true // asked once per root, eligible or not
		s.mu.Unlock()
		if _, dup := s.sameAsListed(ctx, filepath.FromSlash(sess.RepoRoot)); !dup && s.Eligible(sess.RepoRoot) {
			added, err := store.SeedProject(ctx, s.Store.DB(), store.Project{
				Root: sess.RepoRoot, Name: baseName(sess.RepoRoot), Kind: store.ProjectKindRepo, Source: store.ProjectSourceSession, AddedAt: s.Now().UnixMilli(),
			})
			if err == nil && added {
				if p, err := store.GetProjectByRoot(ctx, s.Store.DB(), sess.RepoRoot); err == nil {
					s.track(p)
					s.Log.Info("listed a project a session ran in", "component", "projects", "root", sess.RepoRoot)
				}
			}
		}
	}
	if !seen || prevDir != dir+"|"+sess.Status {
		if want == "" {
			want = "frame"
		}
	}
	if want == "" {
		return
	}
	p, ok := s.ProjectFor(dir)
	if !ok {
		return
	}
	if want == "git" && p.Kind == store.ProjectKindRepo {
		s.schedule(p.ID, "", editDebounce)
		return
	}
	s.scheduleFrame(p.ID)
}

// scheduleFrame sends a project frame after activityDebounce, once for a
// burst.
func (s *Service) scheduleFrame(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.frames[id]; t != nil {
		return
	}
	s.frames[id] = time.AfterFunc(activityDebounce, func() {
		s.mu.Lock()
		delete(s.frames, id)
		s.mu.Unlock()
		s.publish(id)
	})
}
