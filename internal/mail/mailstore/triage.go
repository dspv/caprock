package mailstore

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Triage is the assistant's label for one conversation.
type Triage struct {
	AccountID int64  `json:"-"`
	ThreadKey string `json:"-"`
	MessageID int64  `json:"-"`
	Category  string `json:"category"`
	Reply     bool   `json:"reply,omitempty"`
	Summary   string `json:"summary,omitempty"`
	Model     string `json:"model,omitempty"`
	User      bool   `json:"user,omitempty"` // the user gave this label
	At        int64  `json:"at"`
}

// TriageTodo is an inbox conversation that needs sorting: never sorted, or
// grown since (and not labelled by the user).
type TriageTodo struct {
	AccountID int64
	ThreadKey string
	Newest    int64 // the highest message row id of the conversation
}

// TriagePending lists, newest first, the conversations among the newest
// window inbox conversations that need sorting.
func (s *Store) TriagePending(ctx context.Context, window int) ([]TriageTodo, error) {
	rows, err := s.db.QueryContext(ctx, `WITH conv AS (
		SELECT m.account_id, m.thread_key, MAX(m.date) AS d, MAX(m.id) AS newest
		FROM messages m JOIN folders f ON f.id = m.folder_id
		WHERE f.role = 'inbox' GROUP BY m.account_id, m.thread_key
		HAVING MAX(m.junk) = 0 -- the junk filter's catch is never sent to an AI
		ORDER BY d DESC LIMIT ?)
		SELECT c.account_id, c.thread_key, c.newest FROM conv c
		LEFT JOIN triage t ON t.account_id = c.account_id AND t.thread_key = c.thread_key
		WHERE t.thread_key IS NULL OR (t.user_set = 0 AND t.message_id < c.newest)
		ORDER BY c.d DESC`, window)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TriageTodo
	for rows.Next() {
		var t TriageTodo
		if err := rows.Scan(&t.AccountID, &t.ThreadKey, &t.Newest); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ThreadMail is the newest n messages of a conversation in an inbox, with
// whatever body is stored (no server call), newest last.
func (s *Store) ThreadMail(ctx context.Context, accountID int64, key string, n int) ([]Message, error) {
	ms, err := s.queryMessages(ctx, `JOIN folders f ON f.id=m.folder_id WHERE m.account_id=? AND m.thread_key=? AND f.role NOT IN ('trash','junk')
		ORDER BY m.date DESC, m.id DESC LIMIT ?`, accountID, key, n)
	if err != nil {
		return nil, err
	}
	for i := range ms {
		_ = s.db.QueryRowContext(ctx, `SELECT body_text FROM messages WHERE id=?`, ms[i].ID).Scan(&ms[i].BodyText)
	}
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
	return ms, nil
}

// SaveTriage stores the model's label. A row the user labelled is left as
// it is; a spam verdict for a sender the user cleared takes the user's label.
func (s *Store) SaveTriage(ctx context.Context, t Triage, sender string) error {
	if t.Category == "spam" && sender != "" {
		var cat string
		err := s.db.QueryRowContext(ctx, `SELECT category FROM triage_senders WHERE account_id=? AND addr=?`, t.AccountID, strings.ToLower(sender)).Scan(&cat)
		if err == nil && cat != "" {
			t.Category = cat
		}
	}
	if t.At == 0 {
		t.At = time.Now().Unix()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO triage (account_id, thread_key, message_id, category, reply, summary, model, user_set, at)
		VALUES (?,?,?,?,?,?,?,0,?)
		ON CONFLICT(account_id, thread_key) DO UPDATE SET message_id=excluded.message_id, category=excluded.category,
			reply=excluded.reply, summary=excluded.summary, model=excluded.model, at=excluded.at
		WHERE triage.user_set = 0`,
		t.AccountID, t.ThreadKey, t.MessageID, t.Category, b2i(t.Reply), t.Summary, t.Model, t.At)
	if err != nil {
		return err
	}
	return s.RecountInbox(ctx, t.AccountID) // unread leaves spam out
}

// LabelTriage is the user's own label for a conversation, kept from then on.
// A label other than spam also clears the sender, so their later mail is
// never sorted as spam.
func (s *Store) LabelTriage(ctx context.Context, accountID int64, key, category, sender string) error {
	now := time.Now().Unix()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO triage (account_id, thread_key, category, model, user_set, at)
		VALUES (?,?,?,'user',1,?)
		ON CONFLICT(account_id, thread_key) DO UPDATE SET category=excluded.category, user_set=1, at=excluded.at,
			reply=CASE WHEN excluded.category='important' THEN triage.reply ELSE 0 END`,
		accountID, key, category, now); err != nil {
		return err
	}
	if err := s.RecountInbox(ctx, accountID); err != nil {
		return err
	}
	if sender == "" {
		return nil
	}
	if category == "spam" {
		_, err := s.db.ExecContext(ctx, `DELETE FROM triage_senders WHERE account_id=? AND addr=?`, accountID, strings.ToLower(sender))
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO triage_senders (account_id, addr, category) VALUES (?,?,?)
		ON CONFLICT(account_id, addr) DO UPDATE SET category=excluded.category`, accountID, strings.ToLower(sender), category)
	return err
}

// UnspamTriage is the AI's half of the user's "Not spam": a conversation the
// AI labelled spam takes the user's label "important", and the sender's
// later mail is never sorted as spam. A conversation the AI sorted otherwise
// keeps its label.
func (s *Store) UnspamTriage(ctx context.Context, accountID int64, key, sender string) error {
	if t, err := s.TriageOf(ctx, accountID, key); err == nil && t.Category == "spam" {
		return s.LabelTriage(ctx, accountID, key, "important", sender)
	}
	if sender == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO triage_senders (account_id, addr, category) VALUES (?,?,'important')
		ON CONFLICT(account_id, addr) DO NOTHING`, accountID, strings.ToLower(sender))
	return err
}

// TriageOf loads one conversation's label; ErrNotFound when it has none.
func (s *Store) TriageOf(ctx context.Context, accountID int64, key string) (Triage, error) {
	t := Triage{AccountID: accountID, ThreadKey: key}
	err := s.db.QueryRowContext(ctx, `SELECT message_id, category, reply, summary, model, user_set, at FROM triage WHERE account_id=? AND thread_key=?`,
		accountID, key).Scan(&t.MessageID, &t.Category, &t.Reply, &t.Summary, &t.Model, &t.User, &t.At)
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// attachTriage puts each message's conversation label on it.
func (s *Store) attachTriage(ctx context.Context, ms []Message) error {
	type k struct {
		a int64
		t string
	}
	byKey := map[k]*Triage{}
	for _, m := range ms {
		kk := k{m.AccountID, m.ThreadKey}
		if _, ok := byKey[kk]; ok {
			continue
		}
		t, err := s.TriageOf(ctx, m.AccountID, m.ThreadKey)
		if errors.Is(err, ErrNotFound) {
			byKey[kk] = nil
			continue
		}
		if err != nil {
			return err
		}
		byKey[kk] = &t
	}
	for i := range ms {
		ms[i].AI = byKey[k{ms[i].AccountID, ms[i].ThreadKey}]
	}
	return nil
}

// TriageCount is how many inbox conversations of an account carry a label.
type TriageCount struct {
	AccountID int64  `json:"account_id"`
	Category  string `json:"category"`
	N         int    `json:"n"`
}

// TriageCounts counts labelled conversations that still have mail in an
// inbox, by category.
func (s *Store) TriageCounts(ctx context.Context) ([]TriageCount, error) {
	// Spam is the junk filter's catch and the AI's together, one count; a
	// conversation the filter caught counts as spam whatever the AI said.
	rows, err := s.db.QueryContext(ctx, `WITH conv AS (
		SELECT m.account_id, m.thread_key, MAX(m.junk) AS junk
		FROM messages m JOIN folders f ON f.id=m.folder_id WHERE f.role='inbox'
		GROUP BY m.account_id, m.thread_key)
		SELECT c.account_id, CASE WHEN c.junk=1 THEN 'spam' ELSE t.category END AS cat, COUNT(*)
		FROM conv c LEFT JOIN triage t ON t.account_id=c.account_id AND t.thread_key=c.thread_key
		WHERE c.junk=1 OR t.category IS NOT NULL
		GROUP BY c.account_id, cat`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TriageCount{}
	for rows.Next() {
		var c TriageCount
		if err := rows.Scan(&c.AccountID, &c.Category, &c.N); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
