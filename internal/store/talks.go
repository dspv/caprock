package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Talks (migration 0097, ADR-110): a Talk between this side's agent and
// another person's, each side holding its own row, the envelopes both sent,
// and the outbox of what the other side has not taken yet. internal/talks
// decides every state; these only read and write rows.

// The sides of an envelope.
const (
	TalkSideMe   = "me"
	TalkSideThem = "them"
)

// Talk is one row of talks.
type Talk struct {
	ID           string   `json:"id"`
	Person       string   `json:"person"`
	PersonName   string   `json:"person_name"`
	Goal         string   `json:"goal"`
	StartedBy    string   `json:"started_by"`
	State        string   `json:"state"`
	Hold         string   `json:"hold,omitempty"`
	EndedBy      string   `json:"ended_by,omitempty"`
	Brief        string   `json:"brief"`
	Agent        string   `json:"agent,omitempty"`
	Model        string   `json:"model,omitempty"`
	MaxMessages  int      `json:"max_messages"`
	MaxUSD       float64  `json:"max_usd"`
	Sent         int      `json:"sent"`
	CostUSD      float64  `json:"cost_usd"`
	TheirCostUSD *float64 `json:"their_cost_usd,omitempty"`
	// The held message, while Hold is redaction or needs_owner: as the agent
	// wrote it, as it would go with redaction applied, and what was caught.
	Draft         string `json:"draft,omitempty"`
	DraftRedacted string `json:"draft_redacted,omitempty"`
	DraftCaught   string `json:"draft_caught,omitempty"`
	DraftDone     bool   `json:"draft_done,omitempty"`
	// Note is the agent's last private note to its owner: never sent.
	Note string `json:"note,omitempty"`
	// Steer is what the next turn is told first (a dropped draft's reason).
	Steer     string `json:"-"`
	LastError string `json:"last_error,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// TalkEnvelope is one row of talk_envelopes.
type TalkEnvelope struct {
	Talk        string  `json:"talk"`
	Side        string  `json:"side"`
	Seq         int64   `json:"seq"`
	Kind        string  `json:"kind"`
	Hash        string  `json:"hash"`
	Raw         string  `json:"-"`
	How         string  `json:"how,omitempty"`
	Caught      string  `json:"caught,omitempty"`
	CostUSD     float64 `json:"cost_usd,omitempty"`
	At          int64   `json:"at"`
	DeliveredAt int64   `json:"delivered_at,omitempty"`
}

// TalkOutboxRow is one envelope waiting for the other side.
type TalkOutboxRow struct {
	Talk      string
	Seq       int64
	Person    string
	Tries     int
	NextAt    int64
	LastError string
}

const talkCols = `id, person, person_name, goal, started_by, state, hold, ended_by, brief, agent, model,
	max_messages, max_usd, sent, cost_usd, their_cost_usd, draft, draft_redacted, draft_caught, draft_done,
	note, steer, last_error, created_at, updated_at`

func scanTalk(sc interface{ Scan(...any) error }) (Talk, error) {
	var t Talk
	var their sql.NullFloat64
	var done int
	err := sc.Scan(&t.ID, &t.Person, &t.PersonName, &t.Goal, &t.StartedBy, &t.State, &t.Hold, &t.EndedBy, &t.Brief,
		&t.Agent, &t.Model, &t.MaxMessages, &t.MaxUSD, &t.Sent, &t.CostUSD, &their, &t.Draft, &t.DraftRedacted,
		&t.DraftCaught, &done, &t.Note, &t.Steer, &t.LastError, &t.CreatedAt, &t.UpdatedAt)
	if their.Valid {
		v := their.Float64
		t.TheirCostUSD = &v
	}
	t.DraftDone = done != 0
	return t, err
}

// ErrNoTalk is a Talk this side does not hold.
var ErrNoTalk = errors.New("no such talk")

// InsertTalk adds a Talk.
func InsertTalk(ctx context.Context, q Querier, t Talk) error {
	_, err := q.ExecContext(ctx, `INSERT INTO talks (`+talkCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.Person, t.PersonName, t.Goal, t.StartedBy, t.State, t.Hold, t.EndedBy, t.Brief, t.Agent, t.Model,
		t.MaxMessages, t.MaxUSD, t.Sent, t.CostUSD, t.TheirCostUSD, t.Draft, t.DraftRedacted, t.DraftCaught, boolInt(t.DraftDone),
		t.Note, t.Steer, t.LastError, t.CreatedAt, t.UpdatedAt)
	return err
}

// SaveTalk writes every column of a Talk but its id, person and created_at.
func SaveTalk(ctx context.Context, q Querier, t Talk) error {
	res, err := q.ExecContext(ctx, `UPDATE talks SET person_name = ?, goal = ?, state = ?, hold = ?, ended_by = ?, brief = ?,
		agent = ?, model = ?, max_messages = ?, max_usd = ?, sent = ?, cost_usd = ?, their_cost_usd = ?, draft = ?,
		draft_redacted = ?, draft_caught = ?, draft_done = ?, note = ?, steer = ?, last_error = ?, updated_at = ?
		WHERE id = ?`,
		t.PersonName, t.Goal, t.State, t.Hold, t.EndedBy, t.Brief, t.Agent, t.Model, t.MaxMessages, t.MaxUSD, t.Sent,
		t.CostUSD, t.TheirCostUSD, t.Draft, t.DraftRedacted, t.DraftCaught, boolInt(t.DraftDone), t.Note, t.Steer,
		t.LastError, t.UpdatedAt, t.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNoTalk
	}
	return nil
}

// GetTalk reads one Talk.
func GetTalk(ctx context.Context, q Querier, id string) (Talk, error) {
	t, err := scanTalk(q.QueryRowContext(ctx, `SELECT `+talkCols+` FROM talks WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Talk{}, ErrNoTalk
	}
	return t, err
}

// ListTalks is every Talk, the most recently changed first, at most limit.
func ListTalks(ctx context.Context, q Querier, limit int) ([]Talk, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+talkCols+` FROM talks ORDER BY updated_at DESC, id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Talk{}
	for rows.Next() {
		t, err := scanTalk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TalksWith is every Talk with a person that is in one of states, read in
// one query so a Talk changing state meanwhile is counted once.
func TalksWith(ctx context.Context, q Querier, person string, states ...string) ([]Talk, error) {
	out := []Talk{}
	if len(states) == 0 {
		return out, nil
	}
	args := []any{person}
	marks := make([]string, len(states))
	for i, st := range states {
		marks[i] = "?"
		args = append(args, st)
	}
	rows, err := q.QueryContext(ctx, `SELECT `+talkCols+` FROM talks WHERE person = ? AND state IN (`+strings.Join(marks, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		t, err := scanTalk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TalkIDsInState is the ids of the Talks in state: what a daemon starting up
// resumes.
func TalkIDsInState(ctx context.Context, q Querier, state string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM talks WHERE state = ? ORDER BY updated_at`, state)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

const envCols = `talk, side, seq, kind, hash, raw, how, caught, cost_usd, at, delivered_at`

func scanEnvelope(sc interface{ Scan(...any) error }) (TalkEnvelope, error) {
	var e TalkEnvelope
	err := sc.Scan(&e.Talk, &e.Side, &e.Seq, &e.Kind, &e.Hash, &e.Raw, &e.How, &e.Caught, &e.CostUSD, &e.At, &e.DeliveredAt)
	return e, err
}

// InsertTalkEnvelope adds an envelope.
func InsertTalkEnvelope(ctx context.Context, q Querier, e TalkEnvelope) error {
	_, err := q.ExecContext(ctx, `INSERT INTO talk_envelopes (`+envCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		e.Talk, e.Side, e.Seq, e.Kind, e.Hash, e.Raw, e.How, e.Caught, e.CostUSD, e.At, e.DeliveredAt)
	return err
}

// TalkEnvelopes is a Talk's envelopes, both sides, in the order they were
// stored.
func TalkEnvelopes(ctx context.Context, q Querier, talk string) ([]TalkEnvelope, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+envCols+` FROM talk_envelopes WHERE talk = ? ORDER BY at, side, seq`, talk)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []TalkEnvelope{}
	for rows.Next() {
		e, err := scanEnvelope(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LastTalkEnvelope is the newest envelope of one side of a Talk; ok false
// when that side sent none.
func LastTalkEnvelope(ctx context.Context, q Querier, talk, side string) (TalkEnvelope, bool, error) {
	e, err := scanEnvelope(q.QueryRowContext(ctx, `SELECT `+envCols+` FROM talk_envelopes WHERE talk = ? AND side = ? ORDER BY seq DESC LIMIT 1`, talk, side))
	if errors.Is(err, sql.ErrNoRows) {
		return TalkEnvelope{}, false, nil
	}
	return e, err == nil, err
}

// GetTalkEnvelope is one envelope.
func GetTalkEnvelope(ctx context.Context, q Querier, talk, side string, seq int64) (TalkEnvelope, bool, error) {
	e, err := scanEnvelope(q.QueryRowContext(ctx, `SELECT `+envCols+` FROM talk_envelopes WHERE talk = ? AND side = ? AND seq = ?`, talk, side, seq))
	if errors.Is(err, sql.ErrNoRows) {
		return TalkEnvelope{}, false, nil
	}
	return e, err == nil, err
}

// MarkTalkDelivered records when the other side took one of this side's
// envelopes, and takes it out of the outbox.
func MarkTalkDelivered(ctx context.Context, q Querier, talk string, seq, at int64) error {
	if _, err := q.ExecContext(ctx, `UPDATE talk_envelopes SET delivered_at = ? WHERE talk = ? AND side = 'me' AND seq = ?`, at, talk, seq); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `DELETE FROM talk_outbox WHERE talk = ? AND seq = ?`, talk, seq)
	return err
}

// QueueTalkOutbox puts one of this side's envelopes in the outbox.
func QueueTalkOutbox(ctx context.Context, q Querier, talk string, seq int64, person string, now int64) error {
	_, err := q.ExecContext(ctx, `INSERT OR IGNORE INTO talk_outbox (talk, seq, person, next_at) VALUES (?, ?, ?, ?)`, talk, seq, person, now)
	return err
}

// DueTalkOutbox is, per Talk, the oldest envelope waiting whose next try is
// due: the outbox delivers each Talk's envelopes in order.
func DueTalkOutbox(ctx context.Context, q Querier, now int64) ([]TalkOutboxRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT o.talk, o.seq, o.person, o.tries, o.next_at, o.last_error FROM talk_outbox o
		WHERE o.seq = (SELECT MIN(seq) FROM talk_outbox WHERE talk = o.talk) AND o.next_at <= ?
		ORDER BY o.next_at, o.talk`, now)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []TalkOutboxRow
	for rows.Next() {
		var r TalkOutboxRow
		if err := rows.Scan(&r.Talk, &r.Seq, &r.Person, &r.Tries, &r.NextAt, &r.LastError); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// FailTalkOutbox counts one failed delivery and sets the next try.
func FailTalkOutbox(ctx context.Context, q Querier, talk string, seq, next int64, why string) error {
	_, err := q.ExecContext(ctx, `UPDATE talk_outbox SET tries = tries + 1, next_at = ?, last_error = ? WHERE talk = ? AND seq = ?`, next, why, talk, seq)
	return err
}

// TalkOutboxWaiting is how many of a Talk's envelopes wait, and the last
// failure's words.
func TalkOutboxWaiting(ctx context.Context, q Querier, talk string) (int, string, error) {
	var n int
	var why sql.NullString
	err := q.QueryRowContext(ctx, `SELECT COUNT(*), MAX(last_error) FROM talk_outbox WHERE talk = ?`, talk).Scan(&n, &why)
	return n, why.String, err
}

// DropTalkOutboxFor empties the outbox toward a person: the link is gone.
func DropTalkOutboxFor(ctx context.Context, q Querier, person string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM talk_outbox WHERE person = ?`, person)
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
