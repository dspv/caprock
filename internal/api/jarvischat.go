package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/jarvisbrain"
	"github.com/dspv/caprock/internal/store"
)

// Jarvis V2's chat and brain (ADR-097, .ai/03-contracts.md § Jarvis thread):
// GET /v1/jarvis/thread, POST /v1/jarvis/say, the digest's `brain` object
// and the watcher the daemon ticks (RunJarvis). The logic is
// internal/jarvisbrain's; this file feeds it the digest, the queue and the
// session starter.

// JarvisBrainDeps is what the daemon gives the brain. Nil in Deps leaves the
// thread and say routes answering 501 and the digest's brain "unchosen".
type JarvisBrainDeps struct {
	// Runner runs the user's own claude or codex; nil leaves only
	// deterministic routing.
	Runner jarvisbrain.Runner
	// Setting is the stored jarvis_brain, ok false when never set. Cheap:
	// it is read on every digest and every tick.
	Setting func() (jarvisbrain.Setting, bool)
	// Check says whether the brain can run on a setting: "" when it can,
	// else a state (signed-out, error) and a note.
	Check func(jarvisbrain.Setting) (string, string)
	// Answer and Record are the Jarvis V2 core's answer path and Handled log.
	// A nil Answer uses this server's own (AnswerJarvis); a nil Record
	// leaves auto-answers out of the log.
	Answer jarvisbrain.Answerer
	Record jarvisbrain.Recorder
	// Context outlives requests: brain runs end with it.
	Context context.Context
}

// newJarvisEngine builds the engine over this server.
func (s *Server) newJarvisEngine() *jarvisbrain.Engine {
	jd := s.d.JarvisBrain
	answer := jd.Answer
	if answer == nil {
		answer = serverAnswerer{s}
	}
	return jarvisbrain.New(jd.Context, jarvisbrain.Deps{
		DB:        s.d.Store.DB(),
		Snapshot:  s.jarvisSnapshot,
		Send:      s.jarvisSend,
		Start:     s.jarvisStart,
		LastWords: s.jarvisLastWords,
		Runner:    jd.Runner,
		Setting:   jd.Setting,
		Check:     jd.Check,
		Answer:    answer,
		Record:    jd.Record,
		Publish: func(_ string, data any) {
			if s.d.Bus != nil {
				s.d.Bus.Publish(bus.Frame{Type: bus.FrameJarvis, Data: data})
			}
		},
		Now: s.d.Now,
		Log: s.d.Log,
	})
}

// JarvisTick runs the Jarvis watchers once — "Done:" messages and auto-answer —
// every few seconds until ctx ends. Each tick costs nothing while there is
// nothing to watch (Engine.Busy).
func (s *Server) JarvisTick(ctx context.Context) {
	if s.jarvis != nil {
		s.jarvis.Tick(ctx)
	}
}

// JarvisSettle settles replies a restart left pending; called once at start.
func (s *Server) JarvisSettle(ctx context.Context) {
	if s.jarvis != nil {
		s.jarvis.Settle(ctx)
	}
}

// jarvisBrainStatus is the digest's `brain` object.
func (s *Server) jarvisBrainStatus(ctx context.Context) jarvisbrain.Status {
	if s.jarvis == nil {
		return jarvisbrain.Status{State: jarvisbrain.StateUnchosen, AutoAnswer: jarvisbrain.AutoRoutine}
	}
	return s.jarvis.Status(ctx)
}

func (s *Server) handleJarvisThread(w http.ResponseWriter, r *http.Request) {
	if s.jarvis == nil {
		http.Error(w, "Jarvis's chat is not available in this build", http.StatusNotImplemented)
		return
	}
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 200 {
			s.failCode(w, http.StatusBadRequest, errors.New("limit is a number from 1 to 200"))
			return
		}
		limit = n
	}
	msgs, err := s.jarvis.Thread(r.Context(), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

// jarvisPhoneKey marks a say from a paired phone: a new agent it starts is
// held to the phone's limits (controllerSpawnRefusal).
type jarvisPhoneKey struct{}

func (s *Server) handleJarvisSay(w http.ResponseWriter, r *http.Request) {
	if s.jarvis == nil {
		http.Error(w, "Jarvis's chat is not available in this build", http.StatusNotImplemented)
		return
	}
	var req struct {
		Text    string `json:"text"`
		Project string `json:"project"`
		Via     string `json:"via"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		s.failCode(w, http.StatusBadRequest, errors.New("the body is {text, project?, via?}"))
		return
	}
	ctx := r.Context()
	if phoneLimited(r) {
		ctx = context.WithValue(ctx, jarvisPhoneKey{}, true)
	}
	res, err := s.jarvis.Say(ctx, req.Text, req.Project, req.Via)
	if errors.Is(err, jarvisbrain.ErrInput) {
		s.failCode(w, http.StatusBadRequest, errors.New(strings.TrimPrefix(err.Error(), jarvisbrain.ErrInput.Error()+": ")))
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// jarvisSnapshot is what a message is routed by: the digest's needs (with a
// question dialog's options) and agents, and every listed project's folder.
func (s *Server) jarvisSnapshot(ctx context.Context) (jarvisbrain.Snapshot, error) {
	d, err := s.Jarvis(ctx)
	if err != nil {
		return jarvisbrain.Snapshot{}, err
	}
	snap := jarvisbrain.Snapshot{Dirs: map[string]string{}}
	for _, a := range d.Agents {
		snap.Agents = append(snap.Agents, jarvisbrain.Agent{SessionID: a.SessionID, Project: a.Project, Dir: a.Dir, Title: a.Title,
			State: a.State, Now: a.Now, LastActivityAt: a.LastActivityAt, Controllable: a.Controllable})
	}
	for _, n := range d.NeedsYou {
		need := jarvisbrain.Need{Kind: n.Kind, SessionID: n.SessionID, Project: n.Project, Title: n.Title, Since: n.Since, Controllable: n.Controllable}
		for _, o := range n.Options {
			need.Options = append(need.Options, jarvisbrain.Option{Label: o.Display, Description: o.Description, Recommended: o.Recommended})
		}
		need.MoreQuestions = n.MoreQuestions
		need.Answerable = n.Answerable
		snap.Needs = append(snap.Needs, need)
	}
	if ps, err := store.ListProjects(ctx, s.d.Store.DB(), false); err == nil {
		for _, p := range ps {
			if p.Name != "" && p.Root != "" {
				if _, ok := snap.Dirs[p.Name]; !ok {
					snap.Dirs[p.Name] = p.Root
				}
			}
		}
	}
	return snap, nil
}

// jarvisSend queues text for a session Caprock started, as the chat field
// does (ADR-053).
func (s *Server) jarvisSend(ctx context.Context, sessionID, text string) error {
	if s.d.Queue == nil {
		return errors.New("this Caprock has no message queue")
	}
	_, err := s.d.Queue.Send(ctx, sessionID, text)
	return err
}

// jarvisStart starts a new agent in dir with text, as Jarvis's command line
// did from the screen: the default agent, in the stated permission mode.
func (s *Server) jarvisStart(ctx context.Context, _ string, dir, text string) (string, error) {
	req := map[string]any{"cwd": dir, "prompt": text}
	if phone, _ := ctx.Value(jarvisPhoneKey{}).(bool); phone {
		s.defaultSpawnMode(ctx, req)
		if msg := s.controllerSpawnRefusal(req); msg != "" {
			return "", errors.New(msg)
		}
	}
	id, err := s.StartSession(ctx, req)
	if errors.Is(err, ErrBypassConsent) {
		return "", errors.New("new sessions start in bypass here, which needs a one-time consent on this computer: start this one from New agent")
	}
	return id, err
}

// jarvisLastWords is a session's last prose, for a "Done:" message.
func (s *Server) jarvisLastWords(ctx context.Context, sessionID string) string {
	notes, err := store.SessionNotes(ctx, s.d.Store.DB(), sessionID, 1)
	if err != nil || len(notes) == 0 {
		return ""
	}
	return notes[0].Text
}

// JarvisSettingChanged sends the brain's new state on the live socket.
func (s *Server) JarvisSettingChanged(ctx context.Context) {
	if s.jarvis != nil {
		s.jarvis.PublishStatus(ctx)
	}
}

// serverAnswerer is the core's answer path (POST /v1/jarvis/answer's) as the
// brain's Answerer: the same screen check before a key is pressed.
type serverAnswerer struct{ s *Server }

func (a serverAnswerer) AnswerQuestion(ctx context.Context, sessionID string, option int) error {
	return a.s.AnswerJarvis(ctx, sessionID, option, "")
}
