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
	// it: in one write a TUI reads the pair as a paste. A long message gets
	// more (enterGap).
	queueTypeGap = 200 * time.Millisecond
	// queueConfirmAfter is how long after the Enter the screen is read to
	// see whether the message went (confirmSent).
	queueConfirmAfter = 1500 * time.Millisecond
)

// turnKinds are the events that open or close a turn on the main thread.
var turnKinds = []string{
	string(event.KindTurnUser), string(event.KindToolPre), string(event.KindToolPost),
	string(event.KindPermissionPrompt), string(event.KindContextCompact),
	string(event.KindAgentStop), string(event.KindAgentSpawn), string(event.KindContextClear),
	string(event.KindSessionContinue), string(event.KindThrottle), string(event.KindSessionEnd),
}

type msgQueue struct {
	d       *Daemon
	sess    queueSessions
	settle  time.Duration
	gap     time.Duration
	confirm time.Duration

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
	// onTyped is told when a queued message is typed in (the Telegram bot
	// says a held forward went, ADR-081); nil tells no one.
	onTyped func(m store.QueuedMessage)
	// via marks the prompt Caprock just typed into a session as one from
	// elsewhere ("telegram"), until the session's next UserPromptSubmit
	// carries it into the chat (annotate).
	via map[string]viaMark

	// The Queue view's estimates, by project (queueboard.go).
	estMu sync.Mutex
	est   map[string]estEntry
	// todos is each session's summed-up task list, kept while the
	// session records nothing new (queueboard.go, todo).
	todos map[string]todoEntry
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
		d: d, settle: queueSettle, gap: queueTypeGap, confirm: queueConfirmAfter,
		locks: map[string]*sync.Mutex{}, continued: map[string]bool{}, typed: map[string]time.Time{},
		inflight: map[string]string{}, est: map[string]estEntry{}, todos: map[string]todoEntry{}, now: time.Now,
		via: map[string]viaMark{},
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
	OwnedRunning() []string
	promptTyper
}

// promptTyper is what typing a message into a session's prompt needs from
// the agent manager (typeMessage).
type promptTyper interface {
	PendingPermission(id string) (*agents.Permission, bool)
	Input(id string, data []byte) error
	PasteMode(id string) bool
	PromptHolds(id, text string) bool
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
	if _, ok := q.sess.PendingPermission(a.Current()); ok {
		return api.WaitingPermission, nil
	}
	q.mu.Lock()
	at, typed := q.typed[a.Current()]
	continued := q.continued[a.Current()]
	q.mu.Unlock()
	if typed && time.Since(at) < queueTypedHold {
		return api.WaitingTurn, nil
	}
	evs, err := store.LastEventsFiltered(ctx, q.d.store.DB(), a.Current(), queueTurnScan, store.EventFilter{MainOnly: true, Kinds: turnKinds})
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
	v := api.QueueView{SessionID: a.Current()}
	msgs, err := store.ListQueued(ctx, q.d.store.DB(), a.Current())
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
	return q.SendVia(ctx, id, text, "")
}

// SendVia is Send for a message that came from elsewhere: via ("telegram")
// is kept on a queued row and put on the prompt's event once it is typed.
func (q *msgQueue) SendVia(ctx context.Context, id, text, via string) (api.SendResult, error) {
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
	return q.sendLocked(ctx, id, text, via, v)
}

// sendLocked types text in when nothing waits in v, or queues it. Caller
// holds the session's lock and read v under it.
func (q *msgQueue) sendLocked(ctx context.Context, id, text, via string, v api.QueueView) (api.SendResult, error) {
	if v.Waiting == "" && len(v.Messages) == 0 {
		if err := q.typeLocked(id, text, via); err != nil {
			return api.SendResult{}, err
		}
		v.Waiting = api.WaitingTurn
		q.publish(v)
		return api.SendResult{Sent: true, Queue: v}, nil
	}
	if len(v.Messages) >= api.QueueMax {
		return api.SendResult{}, api.ErrQueueFull
	}
	m, err := store.AddQueuedVia(ctx, q.d.store.DB(), id, text, via, time.Now())
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
	if err := q.typeLocked(id, m.Text, m.Via); err != nil {
		return api.QueueView{}, err
	}
	q.markInflight(id, m.Text)
	q.typedQueued(m)
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

// typeLocked types a message and presses Enter (typeMessage), then checks a
// moment later that it went (confirmSent). via, when set, marks the prompt
// it becomes. Caller holds the session's lock.
func (q *msgQueue) typeLocked(id, text, via string) error {
	at, err := typeMessage(q.sess, id, text, q.gap, func(at time.Time) {
		q.mu.Lock()
		q.typed[id] = at
		if via != "" {
			q.via[id] = viaMark{via: via, at: at}
		}
		q.mu.Unlock()
	})
	if err != nil {
		return err
	}
	go q.confirmSent(id, text, at)
	return nil
}

// confirmSent presses Enter once more when the prompt still holds a message
// Caprock typed q.confirm ago: the first Enter was read as part of the paste
// (ADR-053, 2026-10-17 amendment). Not when a hook has come from the session
// since — the turn started — nor after another message went in, nor into a
// menu (confirmMessage).
func (q *msgQueue) confirmSent(id, text string, at time.Time) {
	time.Sleep(q.confirm)
	unlock := q.lock(id)
	defer unlock()
	if _, ok := q.owned(id); !ok {
		return
	}
	q.mu.Lock()
	typedAt, still := q.typed[id]
	q.mu.Unlock()
	if !still || !typedAt.Equal(at) {
		return
	}
	if confirmMessage(q.sess, id, text) && q.d.log != nil {
		q.d.log.Info("queue: the prompt still held the message; pressed Enter again", "component", "queue", "session_id", id)
	}
}

// typeMessage types text into a session's prompt and then presses Enter, as
// two writes with a pause between them. A session whose output turned
// bracketed paste on gets the text as a paste (ESC[200~ … ESC[201~), so the
// Enter after it is a key however the TUI's reads fall; any other gets it
// typed, each line break as ESC CR. typed, when set, is told the moment the
// text went in, which is also returned.
func typeMessage(s promptTyper, id, text string, gap time.Duration, typed func(time.Time)) (time.Time, error) {
	body := messageBytes(text, s.PasteMode(id))
	if err := s.Input(id, []byte(body)); err != nil {
		return time.Time{}, err
	}
	at := time.Now()
	if typed != nil {
		typed(at)
	}
	time.Sleep(enterGap(gap, len(body)))
	return at, s.Input(id, []byte("\r"))
}

// confirmMessage presses Enter when the session's prompt still shows text
// and nothing waits for an answer, and says whether it did.
func confirmMessage(s promptTyper, id, text string) bool {
	if _, waiting := s.PendingPermission(id); waiting {
		return false
	}
	if !s.PromptHolds(id, text) {
		return false
	}
	return s.Input(id, []byte("\r")) == nil
}

// enterGap is the pause before the Enter: gap, plus 25 ms for every quarter
// KiB of a long message, which a TUI takes longer to read in — at most a
// second (or gap, if that is longer).
func enterGap(gap time.Duration, n int) time.Duration {
	return min(gap+time.Duration(n/256)*25*time.Millisecond, max(gap, time.Second))
}

// messageBytes is a message as written to a session's prompt: wrapped in
// bracketed paste, with line breaks as CR as a terminal pastes them, when
// paste is on; typed, with line breaks as ESC CR, when not.
func messageBytes(text string, paste bool) string {
	if paste {
		return "\x1b[200~" + promptText(text, "\r") + "\x1b[201~"
	}
	return promptText(text, "\x1b\r")
}

// promptBytes is text as typed into a TUI's prompt, without paste.
func promptBytes(text string) string { return promptText(text, "\x1b\r") }

// promptText is text as written into a TUI's prompt, each line break as nl.
// Control characters are dropped — an escape sequence in the text would be a
// key, and an ESC would end a paste early — and a tab is two spaces (Tab
// switches modes in Claude Code). A message ending in an @file mention gets
// a space after it: Claude Code's file menu is open there, and the Enter
// that follows would pick from the menu, not send.
func promptText(text, nl string) string {
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
			b.WriteString(nl)
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
	if err := q.typeLocked(id, m.Text, m.Via); err != nil {
		q.d.log.Warn("queue: could not type a queued message", "component", "queue", "session_id", id, "err", err)
	} else {
		q.markInflight(id, m.Text)
		q.typedQueued(m)
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
	delete(q.via, id)
	q.mu.Unlock()
}

// typedQueued tells onTyped a queued message went in.
func (q *msgQueue) typedQueued(m store.QueuedMessage) {
	if q.onTyped != nil {
		go q.onTyped(m)
	}
}

// viaMark is a message from elsewhere typed into a session, waiting for its
// prompt event.
type viaMark struct {
	via string
	at  time.Time
}

// viaWindow is how long after typing a message its prompt event may come
// and still be marked: Claude Code's UserPromptSubmit follows the Enter in
// well under a second, and a prompt the owner typed a minute later is not
// the forward's.
const viaWindow = 30 * time.Second

// markVia marks the next prompt of a session Caprock just started with a
// message from elsewhere (a new chat started from Telegram).
func (q *msgQueue) markVia(id, via string) {
	q.mu.Lock()
	q.via[id] = viaMark{via: via, at: q.now()}
	q.mu.Unlock()
}

// annotate puts `via` on the payload of the prompt a message from elsewhere
// became, before it is recorded (hookd.Handler.Annotate): the chat reads it
// to mark the message "from Telegram".
func (q *msgQueue) annotate(ev *event.Event) {
	if ev.Kind != event.KindTurnUser || ev.SessionID == "" {
		return
	}
	q.mu.Lock()
	m, ok := q.via[ev.SessionID]
	if ok {
		delete(q.via, ev.SessionID)
	}
	q.mu.Unlock()
	if !ok || q.now().Sub(m.at) > viaWindow {
		return
	}
	if p, ok := withVia(ev.Payload, m.via); ok {
		ev.Payload = p
	}
}

// withVia is a JSON object payload with "via" set; false when it is not an
// object (a payload cut at the size cap stays as it is).
func withVia(raw json.RawMessage, via string) (json.RawMessage, bool) {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return raw, false
	}
	v, err := json.Marshal(via)
	if err != nil {
		return raw, false
	}
	m["via"] = v
	out, err := json.Marshal(m)
	if err != nil {
		return raw, false
	}
	return out, true
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
