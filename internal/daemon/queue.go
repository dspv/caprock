package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// The message queue (ADR-053). The chat field sends through it: a Claude
// Code session Caprock started that sits at its prompt gets the message
// typed in at once; one whose turn is still running, or that shows a
// prompt, gets it held here and typed in when the turn ends — one message
// per turn, oldest first.
//
// "The turn ended" is the session's own Stop hook, recorded, on the main
// thread, and not turned back into a running turn by the task runner's
// Stop-loop. Nothing else delivers: not a quiet minute (a long build is
// quiet), not a StopFailure (a rate limit would eat the queue one message
// at a time). The user's Send now types one in regardless, except into a
// prompt.

const (
	// queueSettle is the pause after a Stop before the next message is
	// typed: Claude Code runs the Stop hook before it draws the prompt
	// again, and the state is read again once the pause is over.
	queueSettle = 700 * time.Millisecond
	// queueTypedHold is how long a message Caprock typed counts as a turn
	// that started, until the session's next hook says so itself.
	queueTypedHold = 15 * time.Second
	// queueTurnScan is how many of the main thread's turn events are read
	// to find the newest one the hooks recorded.
	queueTurnScan = 40
	// queueTypeGap is the pause between a message and the Enter that sends
	// it: in one write a TUI reads the pair as a paste.
	queueTypeGap = 200 * time.Millisecond
)

// turnKinds are the events that open or close a turn on the main thread.
var turnKinds = []string{
	string(event.KindTurnUser), string(event.KindToolPre), string(event.KindToolPost),
	string(event.KindPermissionPrompt), string(event.KindContextCompact),
	string(event.KindAgentStop), string(event.KindAgentSpawn), string(event.KindContextClear),
	string(event.KindSessionContinue), string(event.KindThrottle), string(event.KindSessionEnd),
}

type msgQueue struct {
	d      *Daemon
	sess   queueSessions
	settle time.Duration
	gap    time.Duration

	mu    sync.Mutex
	locks map[string]*sync.Mutex
	// continued marks a session whose last Stop the task runner answered
	// with "keep going": its turn did not end.
	continued map[string]bool
	// typed is when Caprock last typed a message into a session, until the
	// session's next main-thread hook arrives.
	typed map[string]time.Time
	// inflight is the queued message Caprock typed into a session, until
	// the Stop that ends its turn; delivered keeps the last ones typed, for
	// the Queue view to mark a finished turn as a queued message's.
	inflight  map[string]string
	delivered []deliveredMsg
	// onDone is told when a queued message's turn ends (phone and app
	// notification, queueboard.go); nil sends nothing.
	onDone func(ev event.Event, text string)

	// The Queue view's estimates, by project (queueboard.go).
	estMu sync.Mutex
	est   map[string]estEntry
	now   func() time.Time
}

// deliveredMsg is one queued message Caprock typed in.
type deliveredMsg struct {
	session, text string
}

// deliveredKeep is how many typed-in queued messages are remembered.
const deliveredKeep = 200

func newMsgQueue(d *Daemon) *msgQueue {
	q := &msgQueue{
		d: d, settle: queueSettle, gap: queueTypeGap,
		locks: map[string]*sync.Mutex{}, continued: map[string]bool{}, typed: map[string]time.Time{},
		inflight: map[string]string{}, est: map[string]estEntry{}, now: time.Now,
	}
	if d.mgr != nil {
		q.sess = d.mgr
	}
	return q
}

// queueSessions is what the queue needs from the agent manager.
type queueSessions interface {
	Get(id string) (*agents.Agent, bool)
	IsShell(id string) bool
	PendingPermission(id string) (*agents.Permission, bool)
	Input(id string, data []byte) error
	OwnedRunning() []string
}

// lock serialises everything one session's queue does: a send deciding
// "type it now" and a delivery after a Stop must not both type.
func (q *msgQueue) lock(id string) func() {
	q.mu.Lock()
	l := q.locks[id]
	if l == nil {
		l = &sync.Mutex{}
		q.locks[id] = l
	}
	q.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// owned is the session when Caprock started it and it still runs (rule 7).
func (q *msgQueue) owned(id string) (*agents.Agent, bool) {
	if q.sess == nil {
		return nil, false
	}
	a, ok := q.sess.Get(id)
	if !ok || q.sess.IsShell(id) {
		return nil, false
	}
	return a, true
}

// waiting says what keeps a message from being typed into an owned session
// now: a prompt on its screen, a question, or a running turn; "" when it is
// at its prompt. Only Claude Code with its hooks recording says when a turn
// ends; for anything else it is "" and the message is typed at once, as the
// field always did.
func (q *msgQueue) waiting(ctx context.Context, a *agents.Agent) (string, error) {
	if a.Kind != "" && a.Kind != agents.AgentClaude {
		return "", nil
	}
	if _, ok := q.sess.PendingPermission(a.SessionID); ok {
		return api.WaitingPermission, nil
	}
	q.mu.Lock()
	at, typed := q.typed[a.SessionID]
	continued := q.continued[a.SessionID]
	q.mu.Unlock()
	if typed && time.Since(at) < queueTypedHold {
		return api.WaitingTurn, nil
	}
	evs, err := store.LastEventsFiltered(ctx, q.d.store.DB(), a.SessionID, queueTurnScan, store.EventFilter{MainOnly: true, Kinds: turnKinds})
	if err != nil {
		return "", err
	}
	w, hooked := turnWaiting(evs)
	if !hooked {
		return "", nil
	}
	if w == "" && continued {
		return api.WaitingTurn, nil
	}
	return w, nil
}

// turnWaiting reads the newest turn event the hooks recorded (events oldest
// first): whether a turn runs, and whether any hook event was there at all.
// A transcript's events are skipped — they arrive late and none of them
// says a turn ended. A compaction is the turn's when Claude Code started it
// (trigger "auto"), and the SessionStart that follows any compaction is not
// a new session at its prompt.
func turnWaiting(evs []event.Event) (string, bool) {
	for i := len(evs) - 1; i >= 0; i-- {
		e := evs[i]
		if e.Source != event.SourceHook {
			continue
		}
		switch e.Kind {
		case event.KindAgentSpawn:
			if payloadString(e.Payload, "source") == "compact" {
				continue
			}
			return "", true
		case event.KindContextCompact:
			if payloadString(e.Payload, "trigger") == "manual" {
				continue
			}
			return api.WaitingTurn, true
		case event.KindPermissionPrompt:
			if e.Tool == "AskUserQuestion" {
				return api.WaitingQuestion, true
			}
			// The live prompt is the manager's; this one was answered
			// and its call is running.
			return api.WaitingTurn, true
		case event.KindTurnUser, event.KindToolPre, event.KindToolPost:
			return api.WaitingTurn, true
		default:
			return "", true
		}
	}
	return "", false
}

func payloadString(raw json.RawMessage, key string) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

// view is the queue as the API and the frame show it. Caller holds the lock.
func (q *msgQueue) view(ctx context.Context, a *agents.Agent) (api.QueueView, error) {
	v := api.QueueView{SessionID: a.SessionID}
	msgs, err := store.ListQueued(ctx, q.d.store.DB(), a.SessionID)
	if err != nil {
		return v, err
	}
	v.Messages = msgs
	if v.Waiting, err = q.waiting(ctx, a); err != nil {
		return v, err
	}
	return v, nil
}

func (q *msgQueue) publish(v api.QueueView) {
	if q.d.bus != nil {
		q.d.bus.Publish(bus.Frame{Type: bus.FrameQueue, Data: v})
	}
}

// View is GET /v1/agents/{id}/queue. A session that is not Caprock's or has
// ended has no queue; rows it left are dropped.
func (q *msgQueue) View(ctx context.Context, id string) (api.QueueView, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		q.dropLocked(ctx, id)
		return api.QueueView{SessionID: id, Messages: []store.QueuedMessage{}}, nil
	}
	return q.view(ctx, a)
}

// Send types text in now when nothing waits, or queues it.
func (q *msgQueue) Send(ctx context.Context, id, text string) (api.SendResult, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return api.SendResult{}, api.ErrNotOwned
	}
	v, err := q.view(ctx, a)
	if err != nil {
		return api.SendResult{}, err
	}
	if v.Waiting == "" && len(v.Messages) == 0 {
		if err := q.typeLocked(id, text); err != nil {
			return api.SendResult{}, err
		}
		v.Waiting = api.WaitingTurn
		q.publish(v)
		return api.SendResult{Sent: true, Queue: v}, nil
	}
	if len(v.Messages) >= api.QueueMax {
		return api.SendResult{}, api.ErrQueueFull
	}
	m, err := store.AddQueued(ctx, q.d.store.DB(), id, text, time.Now())
	if err != nil {
		return api.SendResult{}, err
	}
	v.Messages = append(v.Messages, m)
	q.publish(v)
	return api.SendResult{Queued: &m, Queue: v}, nil
}

// Edit replaces a waiting message's text.
func (q *msgQueue) Edit(ctx context.Context, id string, mid int64, text string) (api.QueueView, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return api.QueueView{}, api.ErrNotOwned
	}
	if err := store.UpdateQueued(ctx, q.d.store.DB(), id, mid, text, time.Now()); err != nil {
		return api.QueueView{}, err
	}
	return q.changed(ctx, a)
}

// Cancel drops a waiting message.
func (q *msgQueue) Cancel(ctx context.Context, id string, mid int64) (api.QueueView, error) {
	unlock := q.lock(id)
	defer unlock()
	if err := store.DeleteQueued(ctx, q.d.store.DB(), id, mid); err != nil {
		return api.QueueView{}, err
	}
	a, ok := q.owned(id)
	if !ok {
		v := api.QueueView{SessionID: id, Messages: []store.QueuedMessage{}}
		q.publish(v)
		return v, nil
	}
	return q.changed(ctx, a)
}

// SendNow types one waiting message in at once, whatever the turn is doing
// — the way out when no Stop is coming (a turn interrupted with Esc may
// not send one). Never into a prompt: the text would answer it.
func (q *msgQueue) SendNow(ctx context.Context, id string, mid int64) (api.QueueView, error) {
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return api.QueueView{}, api.ErrNotOwned
	}
	m, err := store.GetQueued(ctx, q.d.store.DB(), id, mid)
	if err != nil {
		return api.QueueView{}, err
	}
	w, err := q.waiting(ctx, a)
	if err != nil {
		return api.QueueView{}, err
	}
	if w == api.WaitingPermission || w == api.WaitingQuestion {
		return api.QueueView{}, api.ErrPromptWaiting
	}
	if err := store.DeleteQueued(ctx, q.d.store.DB(), id, mid); err != nil {
		return api.QueueView{}, err
	}
	if err := q.typeLocked(id, m.Text); err != nil {
		return api.QueueView{}, err
	}
	q.markInflight(id, m.Text)
	return q.changed(ctx, a)
}

func (q *msgQueue) changed(ctx context.Context, a *agents.Agent) (api.QueueView, error) {
	v, err := q.view(ctx, a)
	if err != nil {
		return v, err
	}
	q.publish(v)
	return v, nil
}

// typeLocked types text and then Enter, as the chat field did: control
// characters out, a tab as two spaces (Tab switches modes in Claude Code),
// each line break as ESC CR. Caller holds the session's lock.
func (q *msgQueue) typeLocked(id, text string) error {
	body := promptBytes(text)
	if err := q.sess.Input(id, []byte(body)); err != nil {
		return err
	}
	q.mu.Lock()
	q.typed[id] = time.Now()
	q.mu.Unlock()
	time.Sleep(q.gap)
	return q.sess.Input(id, []byte("\r"))
}

// promptBytes is text as typed into a TUI's prompt. A message ending in an
// @file mention gets a space after it: Claude Code's file menu is open
// there, and the Enter that follows would pick from the menu, not send.
func promptBytes(text string) string {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	if f := strings.Fields(text); len(f) > 0 && strings.HasPrefix(f[len(f)-1], "@") && !strings.HasSuffix(text, " ") {
		if i := strings.LastIndexAny(text, " \n\t"); i < 0 || strings.HasPrefix(text[i+1:], "@") {
			text += " "
		}
	}
	var b strings.Builder
	for _, r := range text {
		switch {
		case r == '\n':
			b.WriteString("\x1b\r")
		case r == '\t':
			b.WriteString("  ")
		case r < 0x20, r == 0x7f, r >= 0x80 && r < 0xa0:
			// dropped: an escape sequence typed into a TUI is a key
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// afterMain is told every main-thread hook event once it is recorded
// (hookd.Handler.AfterMain).
func (q *msgQueue) afterMain(ev *event.Event, continued bool) {
	id := ev.SessionID
	if _, ok := q.owned(id); !ok {
		return // not Caprock's, or gone: nothing here types into it (its exit clears the rest)
	}
	q.mu.Lock()
	delete(q.typed, id)
	if ev.Kind == event.KindAgentStop {
		q.continued[id] = continued
	} else {
		delete(q.continued, id)
	}
	// The Stop (or StopFailure) that ends a queued message's turn: say so
	// before the next message goes in.
	text, wasQueued := q.inflight[id]
	ended := (ev.Kind == event.KindAgentStop && !continued) || ev.Kind == event.KindThrottle
	if ended && wasQueued {
		delete(q.inflight, id)
	}
	q.mu.Unlock()
	if ended && wasQueued && q.onDone != nil {
		q.onDone(*ev, text)
	}
	switch {
	case ev.Kind == event.KindAgentStop && !continued:
		go q.deliverSoon(id)
	case ev.Kind == event.KindSessionEnd:
		go q.ended(id)
	}
}

// deliverSoon types the oldest waiting message after the settle pause, if
// the session is still at its prompt then.
func (q *msgQueue) deliverSoon(id string) {
	time.Sleep(q.settle)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	unlock := q.lock(id)
	defer unlock()
	a, ok := q.owned(id)
	if !ok {
		return
	}
	msgs, err := store.ListQueued(ctx, q.d.store.DB(), id)
	if err != nil || len(msgs) == 0 {
		return
	}
	w, err := q.waiting(ctx, a)
	if err != nil || w != "" {
		return
	}
	m := msgs[0]
	if err := store.DeleteQueued(ctx, q.d.store.DB(), id, m.ID); err != nil {
		q.d.log.Warn("queue: could not take a message off", "component", "queue", "session_id", id, "err", err)
		return
	}
	if err := q.typeLocked(id, m.Text); err != nil {
		q.d.log.Warn("queue: could not type a queued message", "component", "queue", "session_id", id, "err", err)
	} else {
		q.markInflight(id, m.Text)
		q.d.log.Info("queue: typed a queued message in at the end of a turn", "component", "queue", "session_id", id, "left", len(msgs)-1)
	}
	_, _ = q.changed(ctx, a)
}

// ended drops what waited for a session whose process is gone.
func (q *msgQueue) ended(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	unlock := q.lock(id)
	defer unlock()
	q.dropLocked(ctx, id)
	q.mu.Lock()
	delete(q.typed, id)
	delete(q.continued, id)
	delete(q.inflight, id)
	q.mu.Unlock()
}

// markInflight records a queued message typed into a session.
func (q *msgQueue) markInflight(id, text string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.inflight[id] = text
	q.delivered = append(q.delivered, deliveredMsg{session: id, text: text})
	if n := len(q.delivered); n > deliveredKeep {
		q.delivered = append([]deliveredMsg(nil), q.delivered[n-deliveredKeep:]...)
	}
}

func (q *msgQueue) dropLocked(ctx context.Context, id string) {
	n, err := store.ClearQueued(ctx, q.d.store.DB(), id)
	if err != nil || n == 0 {
		return
	}
	q.d.log.Info("queue: dropped the messages of a session that ended", "component", "queue", "session_id", id, "count", n)
	q.publish(api.QueueView{SessionID: id, Messages: []store.QueuedMessage{}})
}

// startup settles the queues the last run left: a session that did not
// survive loses its rows; one that did gets its oldest message if it sits
// at its prompt (its Stop may have come while no daemon was listening).
func (q *msgQueue) startup(ctx context.Context) {
	ids, err := store.QueuedSessions(ctx, q.d.store.DB())
	if err != nil {
		return
	}
	for _, id := range ids {
		if _, ok := q.owned(id); !ok {
			q.ended(id)
			continue
		}
		go q.deliverSoon(id)
	}
}
