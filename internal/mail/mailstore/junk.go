package mailstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// The junk filter's storage (internal/mail/spam computes, this keeps): the
// per-message verdict, the classifier's token counts, which messages were
// learned, and the senders the user vouched for.

// JunkInput is a message as the junk filter reads it.
type JunkInput struct {
	ID        int64
	AccountID int64
	FolderID  int64
	UID       uint32
	Role      string // its folder's role
	MessageID string
	ThreadKey string
	Subject   string
	FromName  string
	FromAddr  string
	ReplyTo   string
	Seen      bool
	Flagged   bool
	Answered  bool
	BodyText  string
	BodyHTML  string
	BodyState int
	Hdr       string // JSON spam.Header, '' when not read yet
	Junk      bool
	JunkScore int
}

// JunkInputs loads messages with what the filter needs, bodies included.
func (s *Store) JunkInputs(ctx context.Context, ids []int64) ([]JunkInput, error) {
	out := []JunkInput{}
	for start := 0; start < len(ids); start += 500 {
		chunk := ids[start:min(start+500, len(ids))]
		ph := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, id := range chunk {
			args[i] = id
		}
		rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.account_id, m.folder_id, m.uid, f.role, m.message_id, m.thread_key,
			m.subject, m.from_name, m.from_addr, m.reply_to, m.seen, m.flagged, m.answered, m.body_text, m.body_html,
			m.body_state, m.junk_hdr, m.junk, m.junk_score
			FROM messages m JOIN folders f ON f.id=m.folder_id WHERE m.id IN (`+ph+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var r JunkInput
			if err := rows.Scan(&r.ID, &r.AccountID, &r.FolderID, &r.UID, &r.Role, &r.MessageID, &r.ThreadKey,
				&r.Subject, &r.FromName, &r.FromAddr, &r.ReplyTo, &r.Seen, &r.Flagged, &r.Answered, &r.BodyText, &r.BodyHTML,
				&r.BodyState, &r.Hdr, &r.Junk, &r.JunkScore); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, r)
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// SetJunkHeader stores the filter's header facts of a message stored before
// the filter existed.
func (s *Store) SetJunkHeader(ctx context.Context, id int64, hdr string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET junk_hdr=? WHERE id=?`, hdr, id)
	return err
}

// SetJunk records a verdict.
func (s *Store) SetJunk(ctx context.Context, id int64, junk bool, score int, why string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET junk=?, junk_score=?, junk_why=? WHERE id=?`, b2i(junk), score, why, id)
	return err
}

// UIDRow is a message's row id and UID.
type UIDRow struct {
	ID  int64
	UID uint32
}

// MissingJunkHeader lists a folder's messages, newest first, whose header the
// filter has not read (stored before it existed).
func (s *Store) MissingJunkHeader(ctx context.Context, folderID int64, limit int) ([]UIDRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, uid FROM messages WHERE folder_id=? AND junk_hdr='' ORDER BY date DESC LIMIT ?`, folderID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UIDRow{}
	for rows.Next() {
		var r UIDRow
		if err := rows.Scan(&r.ID, &r.UID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// InboxIDs lists the newest messages of every inbox, for judging again.
func (s *Store) InboxIDs(ctx context.Context, limit int) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id
		WHERE f.role='inbox' ORDER BY m.date DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// TokenCounts returns {spam, ham} for each token the classifier has seen.
func (s *Store) TokenCounts(ctx context.Context, tokens []string) (map[string][2]int, error) {
	out := make(map[string][2]int, len(tokens))
	for start := 0; start < len(tokens); start += 500 {
		chunk := tokens[start:min(start+500, len(tokens))]
		ph := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		args := make([]any, len(chunk))
		for i, t := range chunk {
			args[i] = t
		}
		rows, err := s.db.QueryContext(ctx, `SELECT token, spam, ham FROM junk_tokens WHERE token IN (`+ph+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var t string
			var c [2]int
			if err := rows.Scan(&t, &c[0], &c[1]); err != nil {
				rows.Close()
				return nil, err
			}
			out[t] = c
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return nil, err
		}
	}
	return out, nil
}

const (
	keySpamTotal = "junk_learned_spam"
	keyHamTotal  = "junk_learned_ham"
)

// JunkTotals is how many spam and ham messages the classifier has learned.
func (s *Store) JunkTotals(ctx context.Context) (nSpam, nHam int) {
	nSpam, _ = strconv.Atoi(s.Setting(ctx, keySpamTotal, "0"))
	nHam, _ = strconv.Atoi(s.Setting(ctx, keyHamTotal, "0"))
	return nSpam, nHam
}

// Learn teaches the classifier one message. A message already learned the
// same way is skipped; one learned the other way has its tokens moved
// across. An automatic lesson (byUser false) never overrides the user's.
// Reports whether anything changed.
func (s *Store) Learn(ctx context.Context, accountID int64, key string, tokens []string, spam, byUser bool) (bool, error) {
	if key == "" || len(tokens) == 0 {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var was, wasUser int
	err = tx.QueryRowContext(ctx, `SELECT spam, by_user FROM junk_trained WHERE account_id=? AND msg_key=?`, accountID, key).Scan(&was, &wasUser)
	learned := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if learned && (was == b2i(spam) || (wasUser == 1 && !byUser)) {
		if byUser && wasUser == 0 {
			_, err := tx.ExecContext(ctx, `UPDATE junk_trained SET by_user=1 WHERE account_id=? AND msg_key=?`, accountID, key)
			if err != nil {
				return false, err
			}
			return false, tx.Commit()
		}
		return false, nil
	}
	up, err := tx.PrepareContext(ctx, `INSERT INTO junk_tokens(token, spam, ham) VALUES(?, MAX(0, ?), MAX(0, ?))
		ON CONFLICT(token) DO UPDATE SET spam=MAX(0, spam+excluded.spam), ham=MAX(0, ham+excluded.ham)`)
	if err != nil {
		return false, err
	}
	defer up.Close()
	// Undoing the old lesson cannot go through excluded (an insert clamps to
	// zero), so it is its own statement.
	down, err := tx.PrepareContext(ctx, `UPDATE junk_tokens SET spam=MAX(0, spam-?), ham=MAX(0, ham-?) WHERE token=?`)
	if err != nil {
		return false, err
	}
	defer down.Close()
	ds, dh := 0, 1
	if spam {
		ds, dh = 1, 0
	}
	for _, t := range tokens {
		if learned {
			if _, err := down.ExecContext(ctx, dh, ds, t); err != nil {
				return false, err
			}
		}
		if _, err := up.ExecContext(ctx, t, ds, dh); err != nil {
			return false, err
		}
	}
	bump := func(key string, d int) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?, ?)
			ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(0, CAST(value AS INTEGER)+?) AS TEXT)`, key, strconv.Itoa(max(d, 0)), d)
		return err
	}
	addKey, subKey := keyHamTotal, keySpamTotal
	if spam {
		addKey, subKey = keySpamTotal, keyHamTotal
	}
	if err := bump(addKey, 1); err != nil {
		return false, err
	}
	if learned {
		if err := bump(subKey, -1); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO junk_trained(account_id, msg_key, spam, by_user, at) VALUES(?,?,?,?,?)
		ON CONFLICT(account_id, msg_key) DO UPDATE SET spam=excluded.spam, by_user=MAX(by_user, excluded.by_user), at=excluded.at`,
		accountID, key, b2i(spam), b2i(byUser), time.Now().Unix()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// PruneJunkTokens keeps the classifier bounded: past max tokens, the least
// seen are dropped down to nine tenths of max (a token seen once or twice
// says almost nothing; Robinson's smoothing already keeps it near 0.5).
func (s *Store) PruneJunkTokens(ctx context.Context, max int) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM junk_tokens`).Scan(&n); err != nil {
		return err
	}
	if n <= max {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM junk_tokens WHERE token IN
		(SELECT token FROM junk_tokens ORDER BY spam+ham ASC, token LIMIT ?)`, n-max*9/10)
	return err
}

// JunkTokenCount is the classifier's size, for tests and diagnostics.
func (s *Store) JunkTokenCount(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM junk_tokens`).Scan(&n)
	return n, err
}

func normAddr(a string) string { return strings.ToLower(strings.TrimSpace(a)) }

// KnownSender: the user vouched for the address (Not spam), wrote to it, or
// it is one of the user's own accounts. Mail from a known sender is never junk.
func (s *Store) KnownSender(ctx context.Context, addr string) (bool, error) {
	a := normAddr(addr)
	if a == "" {
		return false, nil
	}
	var known bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM junk_allow WHERE addr=?)
		OR EXISTS(SELECT 1 FROM contacts WHERE addr=? AND sent>0)
		OR EXISTS(SELECT 1 FROM accounts WHERE lower(email)=?)`, a, a, a).Scan(&known)
	return known, err
}

// AllowSender remembers that the user said "Not spam" for an address, and
// lifts the verdict from every inbox message it sent.
func (s *Store) AllowSender(ctx context.Context, addr string) error {
	a := normAddr(addr)
	if a == "" {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO junk_allow(addr, at) VALUES(?,?) ON CONFLICT(addr) DO NOTHING`, a, time.Now().Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET junk=0, junk_score=MIN(junk_score, 49), junk_why='known-sender'
		WHERE junk=1 AND lower(from_addr)=?`, a)
	return err
}

// LiftKnownJunk clears the verdict from inbox mail that turned out to come
// from a known sender: someone the user has since written to (the Sent folder
// syncs after the inbox), or a conversation the user has replied in. Returns
// the folders whose counts changed.
func (s *Store) LiftKnownJunk(ctx context.Context) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.folder_id FROM messages m WHERE m.junk=1 AND (
		lower(m.from_addr) IN (SELECT addr FROM contacts WHERE sent>0)
		OR lower(m.from_addr) IN (SELECT addr FROM junk_allow)
		OR (m.thread_key<>'' AND m.thread_key NOT LIKE 'subject:%' AND EXISTS(SELECT 1 FROM messages s JOIN folders f ON f.id=s.folder_id
			WHERE s.account_id=m.account_id AND s.thread_key=m.thread_key AND f.role='sent')))`)
	if err != nil {
		return nil, err
	}
	var ids []int64
	folders := map[int64]bool{}
	for rows.Next() {
		var id, f int64
		if err := rows.Scan(&id, &f); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		folders[f] = true
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `UPDATE messages SET junk=0, junk_score=MIN(junk_score, 49), junk_why='known-sender' WHERE id=?`, id); err != nil {
			return nil, err
		}
	}
	out := make([]int64, 0, len(folders))
	for f := range folders {
		out = append(out, f)
	}
	return out, nil
}

// DisallowSender forgets a vouched-for address (the user marked its mail as spam).
func (s *Store) DisallowSender(ctx context.Context, addr string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM junk_allow WHERE addr=?`, normAddr(addr))
	return err
}

// ThreadHasSent: the conversation includes a message the user sent.
func (s *Store) ThreadHasSent(ctx context.Context, accountID int64, threadKey string) (bool, error) {
	if threadKey == "" || strings.HasPrefix(threadKey, "subject:") {
		return false, nil
	}
	var has bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM messages m JOIN folders f ON f.id=m.folder_id
		WHERE m.account_id=? AND m.thread_key=? AND f.role='sent')`, accountID, threadKey).Scan(&has)
	return has, err
}

// backfillSent fills contacts.sent from the Sent folders already stored, once,
// for a mail.db that had contacts before the column existed.
func backfillSent(db *sql.DB) error {
	var done string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key='junk_sent_backfill'`).Scan(&done); err == nil && done == "1" {
		return nil
	}
	rows, err := db.Query(`SELECT m.to_json, m.cc_json FROM messages m JOIN folders f ON f.id=m.folder_id WHERE f.role='sent'`)
	if err != nil {
		return err
	}
	count := map[string]int{}
	for rows.Next() {
		var to, cc string
		if err := rows.Scan(&to, &cc); err != nil {
			rows.Close()
			return err
		}
		for _, js := range []string{to, cc} {
			var as []Address
			_ = json.Unmarshal([]byte(js), &as)
			for _, a := range as {
				if addr := normAddr(a.Addr); strings.Contains(addr, "@") {
					count[addr]++
				}
			}
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for addr, n := range count {
		if _, err := db.Exec(`INSERT INTO contacts(addr, sent) VALUES(?, ?) ON CONFLICT(addr) DO UPDATE SET sent=MAX(sent, excluded.sent)`, addr, n); err != nil {
			return err
		}
	}
	_, err = db.Exec(`INSERT INTO settings(key, value) VALUES('junk_sent_backfill', '1') ON CONFLICT(key) DO UPDATE SET value='1'`)
	return err
}
