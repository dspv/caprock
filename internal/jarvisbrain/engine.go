package jarvisbrain

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
)

// MaxText bounds a message to Jarvis.
const MaxText = 4000

// AnswerGrace is how long a question dialog stays on screen before the
// brain may answer it, so a person looking at it answers first.
const AnswerGrace = 5 * time.Second

// doneWatchFor is how long Jarvis waits for an agent it gave work to.
const doneWatchFor = 12 * time.Hour

// errorFor is how long a failed run keeps the brain's state at "error".
const errorFor = 10 * time.Minute

// RestartNote replaces a reply a restart left pending.
const RestartNote = "Caprock restarted before the brain answered this one. Say it again if it still matters."

// ErrInput is a message Jarvis cannot take (empty, too long, bad via).
var ErrInput = errors.New("bad message")

// Handled is one thing Jarvis did on its own, for the Handled log (the core
// branch's store.HandledItem; Recorder converts).
type Handled struct {
	At        int64
	Kind      string // "auto_answer"
	SessionID string
	Project   string
	Text      string
	Reason    string
}

// Answerer presses option (0-based) of the question dialog on a session's
// screen: POST /v1/jarvis/answer's path. An error that says the dialog is
// gone is not worth retrying.
type Answerer interface {
	AnswerQuestion(ctx context.Context, sessionID string, option int) error
}

// Recorder adds an item to the Handled log.
type Recorder interface {
	RecordHandled(ctx context.Context, h Handled) error
}

// Deps is what the engine works with. Every function may be nil except DB
// and Snapshot.
type Deps struct {
	DB       store.Querier
	Snapshot func(ctx context.Context) (Snapshot, error)
	// Send queues text for a live session Caprock started.
	Send func(ctx context.Context, sessionID, text string) error
	// Start starts a new agent in dir with text as its first prompt.
	Start func(ctx context.Context, project, dir, text string) (string, error)
	// LastWords is a session's last prose, "" when none.
	LastWords func(ctx context.Context, sessionID string) string
	Runner    Runner
	// Setting is the stored jarvis_brain; ok is false when it was never set.
	Setting func() (set Setting, ok bool)
	// Check says whether the brain can run on set before trying: "" when it
	// can, else the state (StateSignedOut or StateError) and a note.
	Check func(set Setting) (state, note string)
	// Answer and Record are the core branch's answer path and Handled log;
	// nil leaves auto-answer and "answer" actions off.
	Answer Answerer
	Record Recorder
	// Publish sends a live "jarvis" frame: op "thread" or "brain".
	Publish func(op string, data any)
	Now     func() time.Time
	Log     *slog.Logger
}

// Engine is Jarvis's chat, brain and watchers.
type Engine struct {
	d Deps

	mu        sync.Mutex
	watches   map[string]*watch // session id → an agent Jarvis gave work to
	seen      map[string]time.Time
	inflight  map[string]bool // session ids an auto-answer is deciding on
	lastErr   string
	lastErrAt time.Time
	lastSent  string // the brain status last published
	runs      chan struct{}
	bg        context.Context
}

type watch struct {
	project, title string
	since          time.Time
	sawWork        bool
}

// New makes an engine. bg is the daemon's context: brain runs outlive the
// request that started them.
func New(bg context.Context, d Deps) *Engine {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if bg == nil {
		bg = context.Background()
	}
	return &Engine{d: d, watches: map[string]*watch{}, seen: map[string]time.Time{}, inflight: map[string]bool{},
		runs: make(chan struct{}, 2), bg: bg}
}

// Message is a thread row as GET /v1/jarvis/thread and the live frame send
// it.
type Message struct {
	ID        int64    `json:"id"`
	At        int64    `json:"at"`
	Role      string   `json:"role"`
	Text      string   `json:"text"`
	Project   string   `json:"project,omitempty"`
	SessionID string   `json:"session_id,omitempty"`
	Via       string   `json:"via,omitempty"`
	Pending   bool     `json:"pending,omitempty"`
	CostUSD   *float64 `json:"cost_usd,omitempty"`
}

func messageOf(m store.JarvisMessage) Message {
	out := Message{ID: m.ID, At: m.At, Role: m.Role, Text: m.Text, Project: m.Project, SessionID: m.SessionID, Via: m.Via, Pending: m.Pending}
	if m.Brain && m.CostUSD > 0 {
		c := m.CostUSD
		out.CostUSD = &c
	}
	return out
}

// SayAction is one thing a message made happen.
type SayAction struct {
	Kind      string `json:"kind"` // sent | started | answered | none
	SessionID string `json:"session_id,omitempty"`
	Project   string `json:"project,omitempty"`
}

// SayResult is POST /v1/jarvis/say's answer.
type SayResult struct {
	Message Message     `json:"message"`
	Replies []Message   `json:"replies"`
	Actions []SayAction `json:"actions"`
}

// Thread is the newest limit messages, oldest first.
func (e *Engine) Thread(ctx context.Context, limit int) ([]Message, error) {
	rows, err := store.JarvisThread(ctx, e.d.DB, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(rows))
	for _, r := range rows {
		out = append(out, messageOf(r))
	}
	return out, nil
}

// Settle turns replies a restart left pending into a note; called once when
// the daemon starts.
func (e *Engine) Settle(ctx context.Context) {
	if _, err := store.SettleJarvisPending(ctx, e.d.DB, RestartNote); err != nil {
		e.d.Log.Warn("jarvis: settle pending replies", "err", err)
	}
}

// Say takes a message: stored, then routed — by the brain when it is ready
// (its reply arrives later as a "thread" frame), else deterministically.
func (e *Engine) Say(ctx context.Context, text, project, via string) (SayResult, error) {
	text = strings.TrimSpace(text)
	switch {
	case text == "":
		return SayResult{}, fmt.Errorf("%w: say something", ErrInput)
	case utf8.RuneCountInString(text) > MaxText:
		return SayResult{}, fmt.Errorf("%w: a message is at most %d characters", ErrInput, MaxText)
	}
	switch via {
	case "", "text", "voice":
	default:
		return SayResult{}, fmt.Errorf(`%w: via is "text" or "voice"`, ErrInput)
	}
	if via == "" {
		via = "text"
	}
	snap, err := e.d.Snapshot(ctx)
	if err != nil {
		return SayResult{}, err
	}
	project = strings.TrimSpace(project)
	if p, ok := snap.Known(project); ok {
		project = p
	}
	user, err := e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleUser, Kind: store.JarvisKindSay, Text: text, Project: project, Via: via})
	if err != nil {
		return SayResult{}, err
	}
	res := SayResult{Message: user, Replies: []Message{}, Actions: []SayAction{}}

	if set, ok := e.ready(); ok {
		pending, err := e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleJarvis, Kind: store.JarvisKindReply, Text: "Thinking…", Project: project, Pending: true, Brain: true})
		if err != nil {
			return res, err
		}
		res.Replies = append(res.Replies, pending)
		go e.think(set, pending, text, project, snap)
		return res, nil
	}
	reply, act := e.route(ctx, snap, text, project)
	m, err := e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleJarvis, Kind: store.JarvisKindReply, Text: reply, Project: act.Project, SessionID: act.SessionID})
	if err != nil {
		return res, err
	}
	res.Replies = append(res.Replies, m)
	res.Actions = append(res.Actions, act)
	return res, nil
}

// ready is the setting when the brain may run now.
func (e *Engine) ready() (Setting, bool) {
	if e.d.Runner == nil || e.d.Setting == nil {
		return Setting{}, false
	}
	set, ok := e.d.Setting()
	if !ok || !set.On() {
		return Setting{}, false
	}
	if e.d.Check != nil {
		if st, _ := e.d.Check(set); st != "" {
			return Setting{}, false
		}
	}
	return set, true
}

// append stores a row and publishes it.
func (e *Engine) append(ctx context.Context, m store.JarvisMessage) (Message, error) {
	m.At = e.d.Now().UnixMilli()
	id, err := store.AppendJarvisMessage(ctx, e.d.DB, m)
	if err != nil {
		return Message{}, err
	}
	m.ID = id
	out := messageOf(m)
	e.publish("thread", map[string]any{"message": out})
	return out, nil
}

func (e *Engine) publish(op string, data map[string]any) {
	if e.d.Publish == nil {
		return
	}
	data["op"] = op
	e.d.Publish(op, data)
}

// route is the deterministic path (today's Jarvis command line, moved to
// the daemon): the project given, else the @mention, else the most recently
// active one; its most recently active agent Caprock started, through the
// queue; none, a new agent in its folder.
func (e *Engine) route(ctx context.Context, snap Snapshot, text, project string) (string, SayAction) {
	none := SayAction{Kind: "none", Project: project}
	mention, rest, unknown := ParseMention(text, snap.Projects())
	switch {
	case mention != "":
		project, text = mention, rest
	case unknown != "":
		return fmt.Sprintf("I do not know a project named %s.", unknown), none
	}
	if project == "" {
		project = MostRecentProject(snap.Agents)
	}
	if project == "" {
		return "Which project? Start with @ and its name: no agent is running, so I could not guess.", none
	}
	none.Project = project
	if text == "" {
		return fmt.Sprintf("Say what %s should do.", project), none
	}
	return e.dispatch(ctx, snap, project, text)
}

// dispatch gives text to project's agent, or starts one.
func (e *Engine) dispatch(ctx context.Context, snap Snapshot, project, text string) (string, SayAction) {
	r := RouteTo(snap, project)
	if r.Agent != nil {
		if e.d.Send == nil {
			return "This Caprock cannot send to agents.", SayAction{Kind: "none", Project: project}
		}
		if err := e.d.Send(ctx, r.Agent.SessionID, text); err != nil {
			return fmt.Sprintf("Could not give it to the agent in %s: %s.", project, strings.TrimSuffix(err.Error(), ".")), SayAction{Kind: "none", Project: project}
		}
		e.watch(r.Agent.SessionID, project, r.Agent.Title)
		reply := fmt.Sprintf("Gave it to the agent in %s.", project)
		if r.Agent.Title != "" {
			reply = fmt.Sprintf("Gave it to the agent in %s (%q).", project, r.Agent.Title)
		}
		if r.Of > 1 {
			reply += fmt.Sprintf(" It was the most recently active of %d there.", r.Of)
		}
		return reply, SayAction{Kind: "sent", SessionID: r.Agent.SessionID, Project: project}
	}
	if r.Dir == "" {
		return fmt.Sprintf("Caprock does not know %s's folder yet: add it as a project first.", project), SayAction{Kind: "none", Project: project}
	}
	if e.d.Start == nil {
		return "This Caprock cannot start agents.", SayAction{Kind: "none", Project: project}
	}
	id, err := e.d.Start(ctx, project, r.Dir, text)
	if err != nil {
		return fmt.Sprintf("Could not start an agent in %s: %s.", project, strings.TrimSuffix(err.Error(), ".")), SayAction{Kind: "none", Project: project}
	}
	e.watch(id, project, "")
	why := ""
	if r.Skipped > 0 {
		why = " (the one running there was not started by Caprock, so I left it alone)"
	}
	return fmt.Sprintf("No agent was free in %s, so I started a new one%s.", project, why), SayAction{Kind: "started", SessionID: id, Project: project}
}

// think runs the brain on a message and settles its pending reply.
func (e *Engine) think(set Setting, pending Message, text, project string, snap Snapshot) {
	ctx := e.bg
	e.runs <- struct{}{}
	defer func() { <-e.runs }()
	res, err := e.d.Runner.Run(ctx, set, PlanRequest(text, project, snap))
	var plan Plan
	if err == nil {
		plan, err = ParsePlan(res.JSON)
	}
	e.noteRun(err)
	row := store.JarvisMessage{ID: pending.ID, At: pending.At, Role: store.JarvisRoleJarvis, Kind: store.JarvisKindReply, Project: project, Brain: true}
	if res.CostKnown {
		row.CostUSD = res.CostUSD
	}
	if err != nil {
		e.d.Log.Info("jarvis: the brain failed, routing by itself", "err", err)
		reply, act := e.route(ctx, snap, text, project)
		row.Text = "The brain did not answer (" + strings.TrimSuffix(clip(err.Error(), 160), ".") + "), so I routed it myself: " + reply
		row.Project, row.SessionID = act.Project, act.SessionID
	} else {
		row.Text, row.Project, row.SessionID = e.carryOut(ctx, snap, plan, text, project)
	}
	if uerr := store.UpdateJarvisMessage(ctx, e.d.DB, row); uerr != nil {
		e.d.Log.Warn("jarvis: store the brain's reply", "err", uerr)
	}
	e.publish("thread", map[string]any{"message": messageOf(row)})
	e.PublishStatus(ctx)
}

// carryOut does what the brain asked, checking every action against the
// snapshot: a session must be live and Caprock's (rule 7), a project known.
// It returns the reply, with a line for each action that could not be done.
func (e *Engine) carryOut(ctx context.Context, snap Snapshot, p Plan, text, project string) (string, string, string) {
	reply := p.Reply
	var notes []string
	sid := ""
	for _, a := range p.Actions {
		switch a.Kind {
		case ActSend:
			msg := firstNonEmpty(a.Text, text)
			ag, ok := findAgent(snap, a.SessionID)
			switch {
			case ok && ag.Controllable && e.d.Send != nil:
				if err := e.d.Send(ctx, ag.SessionID, msg); err != nil {
					notes = append(notes, fmt.Sprintf("Could not give it to the agent in %s: %s.", ag.Project, strings.TrimSuffix(err.Error(), ".")))
					continue
				}
				e.watch(ag.SessionID, ag.Project, ag.Title)
				sid, project = ag.SessionID, ag.Project
			case ok && !ag.Controllable:
				notes = append(notes, fmt.Sprintf("Caprock did not start the agent in %s, so I did not type into it.", ag.Project))
			default:
				pr := firstNonEmpty(a.Project, project)
				if known, ok := snap.Known(pr); ok {
					line, act := e.dispatch(ctx, snap, known, msg)
					notes = append(notes, line)
					if act.SessionID != "" {
						sid, project = act.SessionID, known
					}
				} else {
					notes = append(notes, "I could not tell which agent that was for, so I sent nothing.")
				}
			}
		case ActStart:
			known, ok := snap.Known(firstNonEmpty(a.Project, project))
			if !ok {
				notes = append(notes, "I could not tell which project to start an agent in, so I started none.")
				continue
			}
			dir := RouteTo(snap, known).Dir
			if dir == "" {
				notes = append(notes, fmt.Sprintf("Caprock does not know %s's folder yet: add it as a project first.", known))
				continue
			}
			if e.d.Start == nil {
				notes = append(notes, "This Caprock cannot start agents.")
				continue
			}
			id, err := e.d.Start(ctx, known, dir, firstNonEmpty(a.Text, text))
			if err != nil {
				notes = append(notes, fmt.Sprintf("Could not start an agent in %s: %s.", known, strings.TrimSuffix(err.Error(), ".")))
				continue
			}
			e.watch(id, known, "")
			sid, project = id, known
		case ActAnswer:
			n, ok := findNeed(snap, a.SessionID)
			switch {
			case !ok || !n.Answerable || a.Option == nil || *a.Option < 0 || *a.Option >= len(n.Options):
				notes = append(notes, "That question is not one Caprock can answer with a tap, so I left it for you.")
			case e.d.Answer == nil:
				notes = append(notes, "This Caprock cannot press an option yet, so I left the question for you.")
			default:
				if err := e.d.Answer.AnswerQuestion(ctx, n.SessionID, *a.Option); err != nil {
					notes = append(notes, fmt.Sprintf("Could not answer it: %s.", strings.TrimSuffix(err.Error(), ".")))
					continue
				}
				sid, project = n.SessionID, n.Project
			}
		}
	}
	out := strings.TrimSpace(strings.Join(append([]string{reply}, notes...), " "))
	if out == "" {
		out = "Done."
	}
	return out, project, sid
}

func findAgent(s Snapshot, id string) (Agent, bool) {
	for _, a := range s.Agents {
		if id != "" && a.SessionID == id {
			return a, true
		}
	}
	return Agent{}, false
}

func findNeed(s Snapshot, id string) (Need, bool) {
	for _, n := range s.Needs {
		if id != "" && n.SessionID == id && n.Kind == "question" {
			return n, true
		}
	}
	return Need{}, false
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// noteRun keeps the last failure for the brain's state.
func (e *Engine) noteRun(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err == nil {
		e.lastErr, e.lastErrAt = "", time.Time{}
		return
	}
	e.lastErr, e.lastErrAt = clip(err.Error(), 200), e.d.Now()
}

// watch remembers an agent Jarvis gave work to, for its "Done:" message.
func (e *Engine) watch(id, project, title string) {
	if id == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	w := &watch{project: project, title: title, since: e.d.Now()}
	if old, ok := e.watches[id]; ok && w.title == "" {
		w.title = old.title
	}
	e.watches[id] = w
}

// Busy reports whether Tick has anything to do: an agent to watch, or
// auto-answer on with a brain that can run.
func (e *Engine) Busy() bool {
	e.mu.Lock()
	n := len(e.watches)
	e.mu.Unlock()
	if n > 0 {
		return true
	}
	return e.autoOn()
}

func (e *Engine) autoOn() bool {
	if e.d.Answer == nil {
		return false
	}
	set, ok := e.ready()
	return ok && set.AutoAnswer != AutoOff
}

// Tick looks at the agents once: an agent Jarvis gave work to that has
// finished its turn gets a "Done:" message, and a routine question waiting
// in a session Caprock started may be answered.
func (e *Engine) Tick(ctx context.Context) {
	if !e.Busy() {
		return
	}
	snap, err := e.d.Snapshot(ctx)
	if err != nil {
		return
	}
	e.checkDone(ctx, snap)
	if e.autoOn() {
		e.autoAnswer(snap)
	}
}

// checkDone settles the watches: an agent seen at work that is now idle, or
// gone, finished.
func (e *Engine) checkDone(ctx context.Context, snap Snapshot) {
	now := e.d.Now()
	live := map[string]Agent{}
	for _, a := range snap.Agents {
		live[a.SessionID] = a
	}
	type fin struct {
		id string
		w  watch
	}
	var done []fin
	e.mu.Lock()
	for id, w := range e.watches {
		a, ok := live[id]
		switch {
		case ok && (a.State == "working" || a.State == "waiting" || a.State == "stuck"):
			w.sawWork = true
			if w.title == "" {
				w.title = a.Title
			}
		case ok && a.State == "idle" && w.sawWork:
			if a.Title != "" {
				w.title = a.Title
			}
			done = append(done, fin{id, *w})
			delete(e.watches, id)
		case !ok && w.sawWork:
			done = append(done, fin{id, *w})
			delete(e.watches, id)
		case now.Sub(w.since) > doneWatchFor || (!ok && now.Sub(w.since) > 10*time.Minute):
			delete(e.watches, id)
		}
	}
	e.mu.Unlock()
	for _, f := range done {
		title := firstNonEmpty(f.w.title, "The agent")
		text := fmt.Sprintf("Done: %s in %s finished.", title, f.w.project)
		if e.d.LastWords != nil {
			if words := oneLine(e.d.LastWords(ctx, f.id), 280); words != "" {
				text += " Last words: " + words
			}
		}
		_, _ = e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleJarvis, Kind: store.JarvisKindDone, Text: text, Project: f.w.project, SessionID: f.id})
	}
}

// autoAnswer starts a decision for each question that may be answered and
// was not considered before.
func (e *Engine) autoAnswer(snap Snapshot) {
	now := e.d.Now()
	titles := map[string]string{}
	for _, a := range snap.Agents {
		titles[a.SessionID] = a.Title
	}
	e.mu.Lock()
	for k, t := range e.seen {
		if now.Sub(t) > 24*time.Hour {
			delete(e.seen, k)
		}
	}
	var todo []Need
	for _, n := range snap.Needs {
		if !Eligible(n) || e.inflight[n.SessionID] {
			continue
		}
		if n.Since > 0 && now.Sub(time.UnixMilli(n.Since)) < AnswerGrace {
			continue
		}
		key := needKey(n)
		if _, ok := e.seen[key]; ok {
			continue
		}
		e.seen[key] = now
		if hit := NeedDenyHit(n); hit != "" {
			e.d.Log.Info("jarvis: left a question for the person", "session", n.SessionID, "deny_word", hit)
			continue
		}
		e.inflight[n.SessionID] = true
		todo = append(todo, n)
	}
	e.mu.Unlock()
	for _, n := range todo {
		go e.decide(n, titles[n.SessionID])
	}
}

func needKey(n Need) string {
	labels := make([]string, 0, len(n.Options))
	for _, o := range n.Options {
		labels = append(labels, o.Label)
	}
	return n.SessionID + "\x00" + n.Title + "\x00" + strings.Join(labels, "\x00")
}

// decide asks the brain about one question and answers it when routine.
func (e *Engine) decide(n Need, agentTitle string) {
	ctx := e.bg
	defer func() {
		e.mu.Lock()
		delete(e.inflight, n.SessionID)
		e.mu.Unlock()
	}()
	set, ok := e.ready()
	if !ok {
		return
	}
	e.runs <- struct{}{}
	res, err := e.d.Runner.Run(ctx, set, ChoiceRequest(n, agentTitle))
	<-e.runs
	var c Choice
	if err == nil {
		c, err = ParseChoice(res.JSON)
	}
	e.noteRun(err)
	cost := 0.0
	if res.CostKnown {
		cost = res.CostUSD
	}
	if err != nil {
		e.d.Log.Info("jarvis: auto-answer failed, left for the person", "session", n.SessionID, "err", err)
		e.PublishStatus(ctx)
		return
	}
	q := oneLine(n.Title, 160)
	if !c.Routine || c.Option < 0 || c.Option >= len(n.Options) {
		why := firstNonEmpty(c.Reason, "it is not routine")
		_, _ = e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleJarvis, Kind: store.JarvisKindAutoAnswer, Brain: true, CostUSD: cost,
			Text: fmt.Sprintf("Left a question in %s for you: %q. %s", n.Project, q, strings.TrimSpace(why)), Project: n.Project, SessionID: n.SessionID})
		e.PublishStatus(ctx)
		return
	}
	// Every option already passed the deny check (autoAnswer), the picked
	// one included.
	label, _ := StripRecommended(n.Options[c.Option].Label)
	if err := e.d.Answer.AnswerQuestion(ctx, n.SessionID, c.Option); err != nil {
		e.d.Log.Info("jarvis: auto-answer could not press the option", "session", n.SessionID, "err", err)
		e.PublishStatus(ctx)
		return
	}
	if e.d.Record != nil {
		if err := e.d.Record.RecordHandled(ctx, Handled{At: e.d.Now().UnixMilli(), Kind: "auto_answer", SessionID: n.SessionID, Project: n.Project,
			Text: fmt.Sprintf("Answered %q with %q", q, label), Reason: c.Reason}); err != nil {
			e.d.Log.Warn("jarvis: record the auto-answer", "err", err)
		}
	}
	_, _ = e.append(ctx, store.JarvisMessage{Role: store.JarvisRoleJarvis, Kind: store.JarvisKindAutoAnswer, Brain: true, CostUSD: cost,
		Text: fmt.Sprintf("Answered a question in %s for you: %q → %q. %s", n.Project, q, label, c.Reason), Project: n.Project, SessionID: n.SessionID})
	e.PublishStatus(ctx)
}

// Status is the digest's `brain` object.
func (e *Engine) Status(ctx context.Context) Status {
	st := Status{State: StateUnchosen, AutoAnswer: AutoRoutine}
	if e.d.Setting != nil {
		if set, ok := e.d.Setting(); ok {
			st.AutoAnswer = firstNonEmpty(set.AutoAnswer, AutoRoutine)
			if !set.On() {
				st.State = StateOff
			} else {
				st.State, st.Agent, st.Sub = StateReady, set.Agent, set.Sub
				if e.d.Runner == nil {
					st.State, st.Note = StateError, "This Caprock cannot run the brain."
				} else if e.d.Check != nil {
					if s, note := e.d.Check(set); s != "" {
						st.State, st.Note = s, note
					}
				}
				e.mu.Lock()
				if st.State == StateReady && e.lastErr != "" && e.d.Now().Sub(e.lastErrAt) < errorFor {
					st.State, st.Note = StateError, "The last run failed: "+e.lastErr
				}
				e.mu.Unlock()
			}
		}
	}
	now := e.d.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if usd, runs, err := store.JarvisBrainSpend(ctx, e.d.DB, midnight.UnixMilli()); err == nil {
		st.SpentTodayUSD, st.RunsToday = usd, runs
	}
	return st
}

// PublishStatus sends a "brain" frame when the status changed since the
// last one sent. Called after each run and when the setting changes.
func (e *Engine) PublishStatus(ctx context.Context) {
	st := e.Status(ctx)
	key := fmt.Sprintf("%s|%s|%s|%s|%s|%.6f|%d", st.State, st.Agent, st.Sub, st.AutoAnswer, st.Note, st.SpentTodayUSD, st.RunsToday)
	e.mu.Lock()
	same := key == e.lastSent
	e.lastSent = key
	e.mu.Unlock()
	if !same {
		e.publish("brain", map[string]any{"brain": st})
	}
}
