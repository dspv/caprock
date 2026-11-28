package talks

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// The engine: every state change of every Talk on this side, the turn loop
// and the outbox.
//
// Turns alternate. The side that starts a Talk sends the goal (a KindState
// envelope, EnvOpen) and its agent's first message; each message received
// makes it this side's turn; each message sent makes it theirs. A turn that
// would pass a cap, a message the guard catches, a message the agent flags
// for its owner and a turn that fails each hold the Talk for this side's
// owner, who answers from the hold (SendHeld, EditHeld, DropHeld,
// Continue, End). Both agents saying done finishes it.
//
// The outbox delivers each Talk's envelopes in order, one at a time, and
// retries while the other Caprock is offline: the relay stores nothing
// (ADR-058), so neither does anything between the two machines.

// Deliver carries one envelope to a person's Caprock (POST /v1/talks/inbox
// there, through the person link) and returns the HTTP status and body.
type Deliver func(ctx context.Context, person string, body []byte) (status int, answer []byte, err error)

// Person is what the engine needs to know of a linked person.
type Person struct {
	Name     string
	LetStart bool
}

// Notice is a hold for this side's owner: what the desktop, the phone and
// Telegram say (ADR-110: notifications only for a hold).
type Notice struct {
	Talk   string
	Person string
	Hold   string
	Title  string
	Body   string
}

// Options configure an Engine.
type Options struct {
	DB     *sql.DB
	Agent  Agent
	Ground Grounding
	// Deliver sends to the other side; People finds a linked person.
	Deliver Deliver
	People  func(id string) (Person, bool)
	// Settings are Settings → Talks, read on every use.
	Settings func() Settings
	// Notify tells the owner of a hold; Changed says a Talk changed (a
	// screen re-reads it). Either may be nil.
	Notify  func(Notice)
	Changed func(talk, why string)
	Log     *slog.Logger
	Now     func() time.Time
	// Retry overrides how long a failed delivery waits first, for tests.
	Retry time.Duration
}

// Engine runs the Talks of this side.
type Engine struct {
	opt Options
	log *slog.Logger

	mu      sync.Mutex
	running map[string]bool
	wake    chan struct{}
	base    context.Context
	wg      sync.WaitGroup
}

// New makes an engine; Start runs its loops.
func New(opt Options) *Engine {
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Settings == nil {
		opt.Settings = func() Settings { return Settings{} }
	}
	if opt.Retry <= 0 {
		opt.Retry = 5 * time.Second
	}
	return &Engine{opt: opt, log: opt.Log, running: map[string]bool{}, wake: make(chan struct{}, 1), base: context.Background()}
}

// Start resumes the Talks whose turn it is and runs the outbox until ctx
// ends.
func (e *Engine) Start(ctx context.Context) {
	e.mu.Lock()
	e.base = ctx
	e.mu.Unlock()
	if ids, err := store.TalkIDsInState(ctx, e.opt.DB, StateMyTurn); err == nil {
		for _, id := range ids {
			e.kick(id)
		}
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		e.outboxLoop(ctx)
	}()
}

// Wait waits for the loops and the turns in flight to end.
func (e *Engine) Wait() { e.wg.Wait() }

func (e *Engine) now() int64 { return e.opt.Now().UnixMilli() }

func (e *Engine) changed(id, why string) {
	if e.opt.Changed != nil {
		e.opt.Changed(id, why)
	}
}

// View is a Talk as GET /v1/talks/{id} answers it.
type View struct {
	store.Talk
	// Transcript is every envelope, both sides, decoded.
	Transcript []Entry `json:"transcript"`
	// Waiting is how many of this side's envelopes the other side has not
	// taken, and Offline the last delivery failure's words while any wait.
	Waiting int    `json:"waiting"`
	Offline string `json:"offline,omitempty"`
}

// Entry is one envelope in a View.
type Entry struct {
	Side string `json:"side"`
	store.TalkEnvelope
	Envelope Envelope `json:"envelope"`
}

// List is every Talk, newest change first.
func (e *Engine) List(ctx context.Context) ([]store.Talk, error) {
	return store.ListTalks(ctx, e.opt.DB, 500)
}

// Get is one Talk with its transcript.
func (e *Engine) Get(ctx context.Context, id string) (View, error) {
	t, err := store.GetTalk(ctx, e.opt.DB, id)
	if err != nil {
		return View{}, err
	}
	envs, err := store.TalkEnvelopes(ctx, e.opt.DB, id)
	if err != nil {
		return View{}, err
	}
	v := View{Talk: t, Transcript: make([]Entry, 0, len(envs))}
	for _, env := range envs {
		var en Envelope
		_ = json.Unmarshal([]byte(env.Raw), &en)
		v.Transcript = append(v.Transcript, Entry{Side: env.Side, TalkEnvelope: env, Envelope: en})
	}
	v.Waiting, v.Offline, _ = store.TalkOutboxWaiting(ctx, e.opt.DB, id)
	if v.Waiting == 0 {
		v.Offline = ""
	}
	return v, nil
}

// StartTalk opens a Talk with a linked person: the goal goes first, then this
// side's agent takes the first turn.
func (e *Engine) StartTalk(ctx context.Context, person, goal string) (store.Talk, error) {
	p, ok := e.opt.People(person)
	if !ok {
		return store.Talk{}, ErrNoPerson
	}
	if open, err := store.TalksWith(ctx, e.opt.DB, person, StateInvited, StateMyTurn, StateWaiting, StateHeld); err != nil {
		return store.Talk{}, err
	} else if len(open) >= MaxOpenPerPerson {
		return store.Talk{}, ErrTooMany
	}
	goal = cleanLine(goal, MaxGoal)
	if goal == "" {
		return store.Talk{}, ErrGoal
	}
	set := e.opt.Settings()
	if _, caught := Guard(goal, set.NeverShare); caught.Total() > 0 {
		return store.Talk{}, fmt.Errorf("%w: %s", ErrCaught, caught.String())
	}
	n, usd := set.Caps()
	now := e.now()
	t := store.Talk{ID: newID(), Person: person, PersonName: p.Name, Goal: goal, StartedBy: ByMe, State: StateMyTurn,
		Brief: set.BriefOrDefault(), Agent: set.Agent, Model: set.Model, MaxMessages: n, MaxUSD: usd, CreatedAt: now, UpdatedAt: now}
	if err := store.InsertTalk(ctx, e.opt.DB, t); err != nil {
		return store.Talk{}, err
	}
	if _, err := e.send(ctx, &t, Envelope{Kind: KindState, State: EnvOpen, Body: goal, Author: e.person(set)}, HowTyped, ""); err != nil {
		return store.Talk{}, err
	}
	e.log.Info("a talk started", "component", "talks", "talk", t.ID, "person", person)
	e.changed(t.ID, "started")
	e.kick(t.ID)
	return t, nil
}

func (e *Engine) person(set Settings) Author {
	return Author{Kind: "person", Name: set.Name}
}

// update runs fn on a Talk's row inside a transaction and saves it.
func (e *Engine) update(ctx context.Context, id string, fn func(q store.Querier, t *store.Talk) error) (store.Talk, error) {
	tx, err := e.opt.DB.BeginTx(ctx, nil)
	if err != nil {
		return store.Talk{}, err
	}
	defer func() { _ = tx.Rollback() }()
	t, err := store.GetTalk(ctx, tx, id)
	if err != nil {
		return store.Talk{}, err
	}
	if err := fn(tx, &t); err != nil {
		return store.Talk{}, err
	}
	t.UpdatedAt = e.now()
	if err := store.SaveTalk(ctx, tx, t); err != nil {
		return store.Talk{}, err
	}
	return t, tx.Commit()
}

// send appends one of this side's envelopes to a Talk and queues it.
func (e *Engine) send(ctx context.Context, t *store.Talk, env Envelope, how, caught string) (store.TalkEnvelope, error) {
	tx, err := e.opt.DB.BeginTx(ctx, nil)
	if err != nil {
		return store.TalkEnvelope{}, err
	}
	defer func() { _ = tx.Rollback() }()
	row, err := e.sendTx(ctx, tx, t, env, how, caught, 0)
	if err != nil {
		return row, err
	}
	if err := store.SaveTalk(ctx, tx, *t); err != nil {
		return row, err
	}
	if err := tx.Commit(); err != nil {
		return row, err
	}
	e.wakeOutbox()
	return row, nil
}

// sendTx is send inside a caller's transaction; the caller saves t.
func (e *Engine) sendTx(ctx context.Context, q store.Querier, t *store.Talk, env Envelope, how, caught string, cost float64) (store.TalkEnvelope, error) {
	last, ok, err := store.LastTalkEnvelope(ctx, q, t.ID, store.TalkSideMe)
	if err != nil {
		return store.TalkEnvelope{}, err
	}
	env.V, env.Talk, env.Seq, env.Prev, env.At = 1, t.ID, 1, "", e.now()
	if ok {
		env.Seq, env.Prev = last.Seq+1, last.Hash
	}
	env.Body = cleanBody(env.Body)
	if env.Kind == KindMessage {
		t.Sent++
		if e.opt.Settings().SharesCost() {
			c := t.CostUSD
			env.CostUSD = &c
		}
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return store.TalkEnvelope{}, err
	}
	row := store.TalkEnvelope{Talk: t.ID, Side: store.TalkSideMe, Seq: env.Seq, Kind: env.Kind, Hash: Hash(raw), Raw: string(raw),
		How: how, Caught: caught, CostUSD: cost, At: env.At}
	if err := store.InsertTalkEnvelope(ctx, q, row); err != nil {
		return row, err
	}
	if err := store.QueueTalkOutbox(ctx, q, t.ID, env.Seq, t.Person, env.At); err != nil {
		return row, err
	}
	t.UpdatedAt = env.At
	return row, nil
}

// kick runs a Talk's turn if it is this side's and none runs.
func (e *Engine) kick(id string) {
	e.mu.Lock()
	if e.running[id] {
		e.mu.Unlock()
		return
	}
	e.running[id] = true
	base := e.base
	e.wg.Add(1)
	e.mu.Unlock()
	go func() {
		defer e.wg.Done()
		defer func() {
			e.mu.Lock()
			delete(e.running, id)
			e.mu.Unlock()
		}()
		e.turn(base, id)
	}()
}

// turn runs one turn of this side's agent, if it is this side's turn.
func (e *Engine) turn(ctx context.Context, id string) {
	t, err := store.GetTalk(ctx, e.opt.DB, id)
	if err != nil || t.State != StateMyTurn {
		return
	}
	if t.Sent >= t.MaxMessages || t.CostUSD >= t.MaxUSD {
		e.hold(ctx, id, HoldCap, "", "", "", false, 0, "")
		return
	}
	set := e.opt.Settings()
	turn, err := e.buildTurn(ctx, t, set)
	if err != nil {
		e.log.Warn("a talk turn could not be built", "component", "talks", "talk", id, "err", err)
		return
	}
	if e.opt.Agent == nil {
		e.hold(ctx, id, HoldError, "", "", "", false, 0, ErrNoAgent.Error())
		return
	}
	ans, err := e.opt.Agent.Turn(ctx, turn)
	if err != nil {
		if ctx.Err() != nil {
			return // the daemon stopping: the turn runs again at start
		}
		e.log.Info("a talk turn failed", "component", "talks", "talk", id, "err", err)
		e.hold(ctx, id, HoldError, "", "", "", false, 0, err.Error())
		return
	}
	msg := strings.TrimSpace(ans.Message)
	if msg == "" && !ans.Done && !ans.NeedsOwner {
		e.hold(ctx, id, HoldError, "", "", "", false, ans.CostUSD, "the agent answered with no message")
		return
	}
	red, caught := Guard(msg, set.NeverShare)
	switch {
	case ans.NeedsOwner:
		e.hold(ctx, id, HoldNeedsOwner, msg, red, caught.String(), ans.Done, ans.CostUSD, "", ans.Note)
	case caught.Total() > 0:
		e.hold(ctx, id, HoldRedaction, msg, red, caught.String(), ans.Done, ans.CostUSD, "", ans.Note)
	default:
		_, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
			t.CostUSD += ans.CostUSD
			t.Note, t.Steer, t.LastError = ans.Note, "", ""
			if ans.Agent != "" {
				t.Agent, t.Model = ans.Agent, ans.Model
			}
			if t.State != StateMyTurn {
				return nil // ended while the turn ran: the cost is kept, nothing goes
			}
			return e.sendMessage(ctx, q, t, msg, HowAuto, "", ans.Done, ans.CostUSD, ans.Agent, ans.Model, false)
		})
		if err != nil {
			e.log.Warn("a talk message could not be queued", "component", "talks", "talk", id, "err", err)
			return
		}
		e.wakeOutbox()
		e.changed(id, "sent")
	}
}

// sendMessage queues an agent message and moves the turn to the other side.
func (e *Engine) sendMessage(ctx context.Context, q store.Querier, t *store.Talk, body, how, caught string, done bool, cost float64, agent, model string, edited bool) error {
	set := e.opt.Settings()
	a := Author{Kind: "agent", Name: set.Name, Agent: agent, Model: model, Edited: edited}
	if _, err := e.sendTx(ctx, q, t, Envelope{Kind: KindMessage, Body: body, Done: done, Author: a}, how, caught, cost); err != nil {
		return err
	}
	t.State, t.Hold = StateWaiting, ""
	t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = "", "", "", false
	if done {
		last, ok, err := store.LastTalkEnvelope(ctx, q, t.ID, store.TalkSideThem)
		if err != nil {
			return err
		}
		if ok && envDone(last) {
			t.State = StateFinished
		}
	}
	return nil
}

func envDone(e store.TalkEnvelope) bool {
	var en Envelope
	return json.Unmarshal([]byte(e.Raw), &en) == nil && en.Done
}

// hold stops a Talk for its owner, with the draft when there is one, and
// tells the owner.
func (e *Engine) hold(ctx context.Context, id, why, draft, redacted, caught string, done bool, cost float64, errText string, note ...string) {
	t, err := e.update(ctx, id, func(_ store.Querier, t *store.Talk) error {
		t.CostUSD += cost
		if t.State != StateMyTurn {
			return nil
		}
		t.State, t.Hold = StateHeld, why
		t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = draft, redacted, caught, done
		t.LastError = errText
		if len(note) > 0 {
			t.Note = note[0]
		}
		return nil
	})
	if err != nil || t.State != StateHeld || t.Hold != why {
		return
	}
	e.log.Info("a talk is held for its owner", "component", "talks", "talk", id, "hold", why, "caught", caught)
	e.changed(id, "held")
	if e.opt.Notify != nil {
		e.opt.Notify(noticeFor(t))
	}
}

func noticeFor(t store.Talk) Notice {
	who := nameOr(t.PersonName, "your partner")
	n := Notice{Talk: t.ID, Person: t.Person, Hold: t.Hold, Title: "Talk with " + who + " is waiting for you"}
	switch t.Hold {
	case HoldRedaction:
		n.Body = "A message was held: it holds " + strings.ReplaceAll(strings.ReplaceAll(t.DraftCaught, "_", " "), "=", ": ") + ". Send it redacted, edit it or drop it."
	case HoldNeedsOwner:
		n.Body = "Your agent asks you before it goes on. Send, edit or drop its message."
	case HoldCap:
		n.Body = fmt.Sprintf("The cap was reached: %d messages or $%.2f on your side. Continue or end.", t.MaxMessages, t.MaxUSD)
	case HoldError:
		n.Body = "Your agent's turn failed: " + clipText(t.LastError, 160)
	}
	return n
}

// buildTurn is a turn's input from the transcript.
func (e *Engine) buildTurn(ctx context.Context, t store.Talk, set Settings) (Turn, error) {
	envs, err := store.TalkEnvelopes(ctx, e.opt.DB, t.ID)
	if err != nil {
		return Turn{}, err
	}
	turn := Turn{Goal: t.Goal, Brief: t.Brief, OwnerName: set.Name, PartnerName: t.PersonName, Steer: t.Steer, Agent: t.Agent, Model: t.Model}
	if set.Agent != "" {
		turn.Agent, turn.Model = set.Agent, set.Model
	}
	for _, env := range envs {
		var en Envelope
		if json.Unmarshal([]byte(env.Raw), &en) != nil || en.Kind == KindState || strings.TrimSpace(en.Body) == "" {
			continue
		}
		from := "you"
		switch {
		case env.Side == store.TalkSideThem && en.Kind == KindHuman:
			from = "partner"
		case env.Side == store.TalkSideThem:
			from = "them"
		case en.Kind == KindHuman:
			from = "owner"
		}
		turn.Transcript = append(turn.Transcript, Line{From: from, Text: en.Body})
	}
	if e.opt.Ground != nil {
		turn.Grounding, turn.Sources = e.opt.Ground.Ground(ctx, t.Goal)
	}
	return turn, nil
}

// Say sends what this side's owner typed into a Talk, marked as theirs
// (KindHuman), through the guard: text that is caught is refused. It does not
// move the turn: the next turn on either side reads it. In a finished Talk it
// is the other side's agent's turn again.
func (e *Engine) Say(ctx context.Context, id, text string) (store.Talk, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return store.Talk{}, errors.New("a message needs text")
	}
	if _, caught := Guard(text, e.opt.Settings().NeverShare); caught.Total() > 0 {
		return store.Talk{}, fmt.Errorf("%w: %s", ErrCaught, caught.String())
	}
	t, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
		if t.State == StateEnded {
			return ErrEnded
		}
		if t.State == StateInvited {
			return ErrState
		}
		if _, err := e.sendTx(ctx, q, t, Envelope{Kind: KindHuman, Body: text, Author: e.person(e.opt.Settings())}, HowTyped, "", 0); err != nil {
			return err
		}
		if t.State == StateFinished {
			t.State = StateWaiting
		}
		return nil
	})
	if err != nil {
		return t, err
	}
	e.wakeOutbox()
	e.changed(id, "sent")
	return t, nil
}

// SendHeld sends a held message as it would leave: with every value the
// guard caught replaced by its placeholder.
func (e *Engine) SendHeld(ctx context.Context, id string) (store.Talk, error) {
	t, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
		if t.State != StateHeld || (t.Hold != HoldRedaction && t.Hold != HoldNeedsOwner) {
			return ErrNotHeld
		}
		body := t.DraftRedacted
		if body == "" {
			body = t.Draft
		}
		return e.sendMessage(ctx, q, t, body, HowFromHold, t.DraftCaught, t.DraftDone, 0, t.Agent, t.Model, false)
	})
	if err != nil {
		return t, err
	}
	e.wakeOutbox()
	e.changed(id, "sent")
	return t, nil
}

// EditHeld sends the owner's text in place of a held message, marked as
// edited. It goes through the guard too: text that is caught is refused,
// and the owner changes it or sends the held one redacted.
func (e *Engine) EditHeld(ctx context.Context, id, text string) (store.Talk, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return store.Talk{}, errors.New("an edit needs text; drop the message to send nothing")
	}
	if _, caught := Guard(text, e.opt.Settings().NeverShare); caught.Total() > 0 {
		return store.Talk{}, fmt.Errorf("%w: %s", ErrCaught, caught.String())
	}
	t, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
		if t.State != StateHeld || (t.Hold != HoldRedaction && t.Hold != HoldNeedsOwner) {
			return ErrNotHeld
		}
		return e.sendMessage(ctx, q, t, text, HowEdited, "", t.DraftDone, 0, t.Agent, t.Model, true)
	})
	if err != nil {
		return t, err
	}
	e.wakeOutbox()
	e.changed(id, "sent")
	return t, nil
}

// DropHeld throws a held message away: the agent is told it was not sent
// and why, and writes again.
func (e *Engine) DropHeld(ctx context.Context, id string) (store.Talk, error) {
	t, err := e.update(ctx, id, func(_ store.Querier, t *store.Talk) error {
		if t.State != StateHeld || (t.Hold != HoldRedaction && t.Hold != HoldNeedsOwner) {
			return ErrNotHeld
		}
		why := "your owner asked you to hold it"
		if t.Hold == HoldRedaction {
			why = "it held what may not leave (" + strings.ReplaceAll(t.DraftCaught, "_", " ") + ")"
		}
		t.Steer = "your last draft was not sent, because " + why + ". Write it again without that, or set done."
		t.State, t.Hold = StateMyTurn, ""
		t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = "", "", "", false
		return nil
	})
	if err != nil {
		return t, err
	}
	e.changed(id, "dropped")
	e.kick(id)
	return t, nil
}

// Continue answers a cap or a failed turn: a cap grows by the defaults
// again (Continue for 12 more), a failed turn runs again.
func (e *Engine) Continue(ctx context.Context, id string) (store.Talk, error) {
	set := e.opt.Settings()
	t, err := e.update(ctx, id, func(_ store.Querier, t *store.Talk) error {
		if t.State != StateHeld || (t.Hold != HoldCap && t.Hold != HoldError) {
			return ErrState
		}
		if t.Hold == HoldCap {
			n, usd := set.Caps()
			if t.Sent >= t.MaxMessages {
				t.MaxMessages = t.Sent + n
			}
			if t.CostUSD >= t.MaxUSD {
				t.MaxUSD = t.CostUSD + usd
			}
		}
		t.State, t.Hold, t.LastError = StateMyTurn, "", ""
		return nil
	})
	if err != nil {
		return t, err
	}
	e.changed(id, "continued")
	e.kick(id)
	return t, nil
}

// Accept starts on this side a Talk the other person started while *Let
// them start talks* was off.
func (e *Engine) Accept(ctx context.Context, id string) (store.Talk, error) {
	t, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
		if t.State != StateInvited {
			return ErrState
		}
		t.State = StateWaiting
		last, ok, err := store.LastTalkEnvelope(ctx, q, t.ID, store.TalkSideThem)
		if err != nil {
			return err
		}
		if ok && last.Kind != KindState {
			t.State = StateMyTurn
		}
		return nil
	})
	if err != nil {
		return t, err
	}
	e.changed(id, "accepted")
	e.kick(id)
	return t, nil
}

// End ends a Talk from this side, and tells the other side.
func (e *Engine) End(ctx context.Context, id string) (store.Talk, error) {
	t, err := e.update(ctx, id, func(q store.Querier, t *store.Talk) error {
		if t.State == StateEnded {
			return ErrEnded
		}
		t.State, t.Hold, t.EndedBy = StateEnded, "", ByMe
		t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = "", "", "", false
		_, err := e.sendTx(ctx, q, t, Envelope{Kind: KindState, State: EnvEnded, Author: e.person(e.opt.Settings())}, HowTyped, "", 0)
		return err
	})
	if err != nil {
		return t, err
	}
	e.wakeOutbox()
	e.changed(id, "ended")
	return t, nil
}

// PersonGone ends every Talk with a person whose link is gone — Removed
// here (byMe) or there — and empties the outbox toward them. Each side
// keeps its own copy of the transcript.
func (e *Engine) PersonGone(ctx context.Context, person, by string) error {
	list, err := store.TalksWith(ctx, e.opt.DB, person, StateInvited, StateMyTurn, StateWaiting, StateHeld, StateFinished)
	if err != nil {
		return err
	}
	for _, t := range list {
		if _, err := e.update(ctx, t.ID, func(_ store.Querier, t *store.Talk) error {
			t.State, t.Hold, t.EndedBy = StateEnded, "", by
			t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = "", "", "", false
			return nil
		}); err != nil {
			return err
		}
		e.changed(t.ID, "ended")
	}
	if err := store.DropTalkOutboxFor(ctx, e.opt.DB, person); err != nil {
		return err
	}
	e.log.Info("a person's talks ended with the link", "component", "talks", "person", person, "by", by, "talks", len(list))
	return nil
}

// Received is POST /v1/talks/inbox's answer: the newest of the sender's
// envelopes this side holds.
type Received struct {
	Have  int64  `json:"have"`
	State string `json:"state,omitempty"`
}

// Receive takes one envelope from person, the relay key its channel proved.
// Delivery is at least once, so an envelope already held answers as taken.
func (e *Engine) Receive(ctx context.Context, person string, raw []byte) (Received, error) {
	p, ok := e.opt.People(person)
	if !ok {
		return Received{}, ErrNoPerson
	}
	var env Envelope
	if len(raw) > MaxBody+8<<10 || json.Unmarshal(raw, &env) != nil || env.V != 1 || env.Talk == "" || len(env.Talk) > 64 || env.Seq < 1 {
		return Received{}, ErrBadEnvelope
	}
	switch env.Kind {
	case KindMessage, KindHuman, KindState:
	default:
		return Received{}, ErrBadEnvelope
	}
	if len(env.Body) > MaxBody {
		return Received{}, ErrBadEnvelope
	}
	h := Hash(raw)
	tx, err := e.opt.DB.BeginTx(ctx, nil)
	if err != nil {
		return Received{}, err
	}
	defer func() { _ = tx.Rollback() }()

	t, err := store.GetTalk(ctx, tx, env.Talk)
	isNew := errors.Is(err, store.ErrNoTalk)
	if err != nil && !isNew {
		return Received{}, err
	}
	if isNew {
		if env.Kind != KindState || env.State != EnvOpen || env.Seq != 1 || env.Prev != "" {
			return Received{}, ErrNotYours
		}
		if open, err := store.TalksWith(ctx, tx, person, StateInvited, StateMyTurn, StateWaiting, StateHeld); err != nil {
			return Received{}, err
		} else if len(open) >= MaxOpenPerPerson {
			return Received{}, ErrTooMany
		}
		set := e.opt.Settings()
		n, usd := set.Caps()
		now := e.now()
		state := StateWaiting
		if !p.LetStart {
			state = StateInvited
		}
		t = store.Talk{ID: env.Talk, Person: person, PersonName: p.Name, Goal: cleanLine(env.Body, MaxGoal), StartedBy: ByThem, State: state,
			Brief: set.BriefOrDefault(), Agent: set.Agent, Model: set.Model, MaxMessages: n, MaxUSD: usd, CreatedAt: now, UpdatedAt: now}
		if err := store.InsertTalk(ctx, tx, t); err != nil {
			return Received{}, err
		}
	} else if t.Person != person {
		return Received{}, ErrNotYours
	}

	last, has, err := store.LastTalkEnvelope(ctx, tx, t.ID, store.TalkSideThem)
	if err != nil {
		return Received{}, err
	}
	if has && env.Seq <= last.Seq {
		got, ok, err := store.GetTalkEnvelope(ctx, tx, t.ID, store.TalkSideThem, env.Seq)
		if err == nil && ok && got.Hash == h {
			return Received{Have: last.Seq, State: t.State}, nil // a retry of one already taken
		}
		return Received{Have: last.Seq, State: t.State}, ErrOutOfOrder
	}
	wantSeq, wantPrev := int64(1), ""
	if has {
		wantSeq, wantPrev = last.Seq+1, last.Hash
	}
	if env.Seq != wantSeq || env.Prev != wantPrev {
		return Received{Have: last.Seq, State: t.State}, ErrOutOfOrder
	}
	if err := store.InsertTalkEnvelope(ctx, tx, store.TalkEnvelope{Talk: t.ID, Side: store.TalkSideThem, Seq: env.Seq, Kind: env.Kind,
		Hash: h, Raw: string(raw), At: e.now()}); err != nil {
		return Received{}, err
	}
	if env.CostUSD != nil {
		c := *env.CostUSD
		t.TheirCostUSD = &c
	}
	run := false
	switch {
	case env.Kind == KindState && env.State == EnvEnded:
		if t.State != StateEnded {
			t.State, t.Hold, t.EndedBy = StateEnded, "", ByThem
			t.Draft, t.DraftRedacted, t.DraftCaught, t.DraftDone = "", "", "", false
		}
	case env.Kind == KindState:
		// The goal, received with the Talk above.
	case env.Kind == KindHuman:
		// The other person typed: read by the next turn on this side. It
		// moves no turn, except that a finished Talk is this side's again.
		if t.State == StateFinished {
			t.State = StateMyTurn
			run = true
		}
	case t.State == StateWaiting || t.State == StateFinished:
		t.State = StateMyTurn
		if env.Done {
			if mine, ok, err := store.LastTalkEnvelope(ctx, tx, t.ID, store.TalkSideMe); err == nil && ok && envDone(mine) {
				t.State = StateFinished
			}
		}
		run = t.State == StateMyTurn
	}
	t.UpdatedAt = e.now()
	if err := store.SaveTalk(ctx, tx, t); err != nil {
		return Received{}, err
	}
	if err := tx.Commit(); err != nil {
		return Received{}, err
	}
	e.changed(t.ID, "received")
	if run {
		e.kick(t.ID)
	}
	return Received{Have: env.Seq, State: t.State}, nil
}

// Delivery is GET /v1/talks/inbox/{talk}: what this side holds of the
// sender's envelopes in a Talk with them.
func (e *Engine) Delivery(ctx context.Context, person, id string) (Received, error) {
	t, err := store.GetTalk(ctx, e.opt.DB, id)
	if err != nil || t.Person != person {
		return Received{}, ErrNotYours
	}
	last, _, err := store.LastTalkEnvelope(ctx, e.opt.DB, id, store.TalkSideThem)
	if err != nil {
		return Received{}, err
	}
	return Received{Have: last.Seq, State: t.State}, nil
}

func (e *Engine) wakeOutbox() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// outboxLoop delivers what waits, on every send and every two seconds.
func (e *Engine) outboxLoop(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		e.deliverDue(ctx)
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		case <-t.C:
		}
	}
}

// deliverDue tries every Talk's oldest waiting envelope once.
func (e *Engine) deliverDue(ctx context.Context) {
	if e.opt.Deliver == nil {
		return
	}
	for {
		rows, err := store.DueTalkOutbox(ctx, e.opt.DB, e.now())
		if err != nil || len(rows) == 0 {
			return
		}
		progressed := false
		for _, r := range rows {
			if e.deliverOne(ctx, r) {
				progressed = true
			}
		}
		if !progressed || ctx.Err() != nil {
			return
		}
	}
}

// deliverOne delivers one envelope; true when it was taken.
func (e *Engine) deliverOne(ctx context.Context, r store.TalkOutboxRow) bool {
	env, ok, err := store.GetTalkEnvelope(ctx, e.opt.DB, r.Talk, store.TalkSideMe, r.Seq)
	if err != nil || !ok {
		_ = store.MarkTalkDelivered(ctx, e.opt.DB, r.Talk, r.Seq, 0)
		return false
	}
	body, _ := json.Marshal(map[string]json.RawMessage{"envelope": json.RawMessage(env.Raw)})
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	status, answer, err := e.opt.Deliver(cctx, r.Person, body)
	cancel()
	if err == nil && status == 200 {
		_ = store.MarkTalkDelivered(ctx, e.opt.DB, r.Talk, r.Seq, e.now())
		e.changed(r.Talk, "delivered")
		return true
	}
	if err == nil && status == 409 {
		var got Received
		if json.Unmarshal(answer, &got) == nil && got.Have >= r.Seq {
			_ = store.MarkTalkDelivered(ctx, e.opt.DB, r.Talk, r.Seq, e.now())
			return true
		}
	}
	if err == nil && status == 401 {
		// The other side removed this one: its token there is gone.
		_ = e.PersonGone(ctx, r.Person, ByThem)
		return false
	}
	why := ""
	switch {
	case err != nil:
		why = err.Error()
	default:
		var a struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(answer, &a)
		why = fmt.Sprintf("it answered %d %s", status, clipText(a.Error, 120))
	}
	wait := e.opt.Retry << min(r.Tries, 6)
	if wait > 5*time.Minute {
		wait = 5 * time.Minute
	}
	_ = store.FailTalkOutbox(ctx, e.opt.DB, r.Talk, r.Seq, e.now()+wait.Milliseconds(), why)
	if r.Tries == 0 {
		e.changed(r.Talk, "offline")
	}
	return false
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "t_" + hex.EncodeToString(b)
}

func clipText(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
