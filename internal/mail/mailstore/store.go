// Package store owns the SQLite database. Nothing else issues SQL.
package mailstore

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Store wraps the database.
type Store struct {
	db *sql.DB
}

// Open opens (and creates) the database at path.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; reads are fast enough on one connection
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := addColumns(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := backfillSent(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db}, nil
}

// addedColumns are columns added after a table first shipped. CREATE TABLE IF
// NOT EXISTS leaves an existing table as it was, so each is added here when
// missing: idempotent, and a fresh database already has it from schema.sql.
var addedColumns = []struct{ table, column, ddl string }{
	{"accounts", "auth", `ALTER TABLE accounts ADD COLUMN auth TEXT NOT NULL DEFAULT 'password'`},
	// junk filter (internal/mail/spam), one block so a merge keeps it whole.
	{"messages", "junk", `ALTER TABLE messages ADD COLUMN junk INTEGER NOT NULL DEFAULT 0`},
	{"messages", "junk_score", `ALTER TABLE messages ADD COLUMN junk_score INTEGER NOT NULL DEFAULT 0`},
	{"messages", "junk_why", `ALTER TABLE messages ADD COLUMN junk_why TEXT NOT NULL DEFAULT ''`},
	{"messages", "junk_hdr", `ALTER TABLE messages ADD COLUMN junk_hdr TEXT NOT NULL DEFAULT ''`},
	{"contacts", "sent", `ALTER TABLE contacts ADD COLUMN sent INTEGER NOT NULL DEFAULT 0`},
}

func addColumns(db *sql.DB) error {
	for _, c := range addedColumns {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, c.table, c.column).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := db.Exec(c.ddl); err != nil {
				return err
			}
		}
	}
	return nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Account is a configured mailbox. The password lives in the secret store.
type Account struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	Username  string `json:"username"`
	IMAPHost  string `json:"imap_host"`
	IMAPPort  int    `json:"imap_port"`
	IMAPTLS   string `json:"imap_tls"`
	SMTPHost  string `json:"smtp_host"`
	SMTPPort  int    `json:"smtp_port"`
	SMTPTLS   string `json:"smtp_tls"`
	Color     string `json:"color"`
	Signature string `json:"signature"`
	CreatedAt int64  `json:"created_at"`
	LastSync  int64  `json:"last_sync"`
	LastError string `json:"last_error"`
	// Auth is how the account signs in: "password" (the default; the secret
	// store holds the password) or "oauth2:google" / "oauth2:microsoft" (it
	// holds the refresh token).
	Auth string `json:"auth"`
}

const accountCols = `id, name, email, username, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, color, signature, created_at, last_sync, last_error, auth`

func scanAccount(r interface{ Scan(...any) error }) (Account, error) {
	var a Account
	err := r.Scan(&a.ID, &a.Name, &a.Email, &a.Username, &a.IMAPHost, &a.IMAPPort, &a.IMAPTLS,
		&a.SMTPHost, &a.SMTPPort, &a.SMTPTLS, &a.Color, &a.Signature, &a.CreatedAt, &a.LastSync, &a.LastError, &a.Auth)
	return a, err
}

// AddAccount inserts an account and returns its id.
func (s *Store) AddAccount(ctx context.Context, a Account) (int64, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO accounts
		(name, email, username, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, color, signature, created_at, auth)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.Name, a.Email, a.Username, a.IMAPHost, a.IMAPPort, a.IMAPTLS, a.SMTPHost, a.SMTPPort, a.SMTPTLS, a.Color, a.Signature, time.Now().Unix(), authOrPassword(a.Auth))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func authOrPassword(auth string) string {
	if auth == "" {
		return "password"
	}
	return auth
}

// SetAuth records how an account signs in.
func (s *Store) SetAuth(ctx context.Context, id int64, auth string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET auth=? WHERE id=?`, authOrPassword(auth), id)
	return err
}

// UpdateAccount rewrites the editable fields; not auth (SetAuth).
func (s *Store) UpdateAccount(ctx context.Context, a Account) error {
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET name=?, email=?, username=?, imap_host=?, imap_port=?, imap_tls=?,
		smtp_host=?, smtp_port=?, smtp_tls=?, color=?, signature=? WHERE id=?`,
		a.Name, a.Email, a.Username, a.IMAPHost, a.IMAPPort, a.IMAPTLS, a.SMTPHost, a.SMTPPort, a.SMTPTLS, a.Color, a.Signature, a.ID)
	return err
}

// Accounts lists all accounts in creation order.
func (s *Store) Accounts(ctx context.Context) ([]Account, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+accountCols+` FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Account{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Account loads one account.
func (s *Store) Account(ctx context.Context, id int64) (Account, error) {
	a, err := scanAccount(s.db.QueryRowContext(ctx, `SELECT `+accountCols+` FROM accounts WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}

// DeleteAccount removes an account and everything stored for it.
func (s *Store) DeleteAccount(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id=?)`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE account_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM folders WHERE account_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetSyncState records the outcome of a sync pass.
func (s *Store) SetSyncState(ctx context.Context, id int64, syncErr string) error {
	if syncErr != "" {
		_, err := s.db.ExecContext(ctx, `UPDATE accounts SET last_error=? WHERE id=?`, syncErr, id)
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET last_sync=?, last_error='' WHERE id=?`, time.Now().Unix(), id)
	return err
}

// Folder is a server mailbox.
type Folder struct {
	ID          int64  `json:"id"`
	AccountID   int64  `json:"account_id"`
	Name        string `json:"name"`
	Delim       string `json:"delim"`
	Role        string `json:"role"`
	UIDValidity uint32 `json:"-"`
	LastUID     uint32 `json:"-"`
	Total       int    `json:"total"`
	Unread      int    `json:"unread"`
}

const folderCols = `id, account_id, name, delim, role, uidvalidity, last_uid, total, unread`

func scanFolder(r interface{ Scan(...any) error }) (Folder, error) {
	var f Folder
	err := r.Scan(&f.ID, &f.AccountID, &f.Name, &f.Delim, &f.Role, &f.UIDValidity, &f.LastUID, &f.Total, &f.Unread)
	return f, err
}

// UpsertFolder creates the folder or updates its delimiter and role; returns it.
func (s *Store) UpsertFolder(ctx context.Context, accountID int64, name, delim, role string) (Folder, error) {
	_, err := s.db.ExecContext(ctx, `INSERT INTO folders (account_id, name, delim, role) VALUES (?,?,?,?)
		ON CONFLICT(account_id, name) DO UPDATE SET delim=excluded.delim, role=excluded.role`, accountID, name, delim, role)
	if err != nil {
		return Folder{}, err
	}
	return scanFolder(s.db.QueryRowContext(ctx, `SELECT `+folderCols+` FROM folders WHERE account_id=? AND name=?`, accountID, name))
}

// RemoveFoldersExcept drops folders the server no longer lists.
func (s *Store) RemoveFoldersExcept(ctx context.Context, accountID int64, keep []string) error {
	fs, err := s.Folders(ctx, accountID)
	if err != nil {
		return err
	}
	set := map[string]bool{}
	for _, k := range keep {
		set[k] = true
	}
	for _, f := range fs {
		if !set[f.Name] {
			if err := s.ResetFolder(ctx, f.ID, 0); err != nil {
				return err
			}
			if _, err := s.db.ExecContext(ctx, `DELETE FROM folders WHERE id=?`, f.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// Folders lists the folders of one account, or all when accountID is 0.
func (s *Store) Folders(ctx context.Context, accountID int64) ([]Folder, error) {
	q := `SELECT ` + folderCols + ` FROM folders`
	args := []any{}
	if accountID != 0 {
		q += ` WHERE account_id=?`
		args = append(args, accountID)
	}
	q += ` ORDER BY account_id, name`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// Folder loads one folder.
func (s *Store) Folder(ctx context.Context, id int64) (Folder, error) {
	f, err := scanFolder(s.db.QueryRowContext(ctx, `SELECT `+folderCols+` FROM folders WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return f, ErrNotFound
	}
	return f, err
}

// FolderByRole finds an account's folder with a role.
func (s *Store) FolderByRole(ctx context.Context, accountID int64, role string) (Folder, error) {
	f, err := scanFolder(s.db.QueryRowContext(ctx, `SELECT `+folderCols+` FROM folders WHERE account_id=? AND role=? ORDER BY id LIMIT 1`, accountID, role))
	if errors.Is(err, sql.ErrNoRows) {
		return f, ErrNotFound
	}
	return f, err
}

// ResetFolder drops every stored message (UIDVALIDITY changed) and sets the new validity.
func (s *Store) ResetFolder(ctx context.Context, folderID int64, uidValidity uint32) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id=?)`, folderID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE folder_id=?`, folderID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE folders SET uidvalidity=?, last_uid=0, total=0, unread=0 WHERE id=?`, uidValidity, folderID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetLastUID records the highest UID stored in a folder.
func (s *Store) SetLastUID(ctx context.Context, folderID int64, uid uint32) error {
	_, err := s.db.ExecContext(ctx, `UPDATE folders SET last_uid=MAX(last_uid, ?) WHERE id=?`, uid, folderID)
	return err
}

// RecountFolder refreshes total and unread from stored rows.
func (s *Store) RecountFolder(ctx context.Context, folderID int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE folders SET
		total=(SELECT COUNT(*) FROM messages WHERE folder_id=?),
		unread=(SELECT COUNT(*) FROM messages m WHERE m.folder_id=? AND m.seen=0 AND NOT `+SpamSQL+`) WHERE id=?`, folderID, folderID, folderID)
	return err
}

// RecountInbox refreshes the counts of an account's inbox folders (a spam
// label changed: the unread count leaves spam out).
func (s *Store) RecountInbox(ctx context.Context, accountID int64) error {
	fs, err := s.Folders(ctx, accountID)
	if err != nil {
		return err
	}
	for _, f := range fs {
		if f.Role == "inbox" {
			if err := s.RecountFolder(ctx, f.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// Address is a display name and an address.
type Address struct {
	Name string `json:"name"`
	Addr string `json:"addr"`
}

// Part is a body part addressed by its IMAP part path.
type Part struct {
	Path       string `json:"path"` // "1.2"
	Type       string `json:"type"` // text/plain
	Charset    string `json:"charset,omitempty"`
	Encoding   string `json:"encoding,omitempty"`
	Filename   string `json:"filename,omitempty"`
	Size       int64  `json:"size"`
	ContentID  string `json:"cid,omitempty"`
	Inline     bool   `json:"inline,omitempty"`
	IsAttach   bool   `json:"attachment"`
	IsTextBody bool   `json:"-"`
	IsHTMLBody bool   `json:"-"`
}

// Structure is what the body structure told us.
type Structure struct {
	Text  *Part  `json:"text,omitempty"`
	HTML  *Part  `json:"html,omitempty"`
	Parts []Part `json:"parts"` // attachments and inline images
}

// Message is a stored message.
type Message struct {
	ID         int64     `json:"id"`
	AccountID  int64     `json:"account_id"`
	FolderID   int64     `json:"folder_id"`
	UID        uint32    `json:"uid"`
	MessageID  string    `json:"message_id"`
	InReplyTo  string    `json:"in_reply_to"`
	Refs       string    `json:"references"`
	ThreadKey  string    `json:"thread_key"`
	Subject    string    `json:"subject"`
	FromName   string    `json:"from_name"`
	FromAddr   string    `json:"from_addr"`
	To         []Address `json:"to"`
	Cc         []Address `json:"cc"`
	ReplyTo    string    `json:"reply_to"`
	Date       int64     `json:"date"`
	Size       int64     `json:"size"`
	Seen       bool      `json:"seen"`
	Flagged    bool      `json:"flagged"`
	Answered   bool      `json:"answered"`
	HasAttach  bool      `json:"has_attach"`
	Snippet    string    `json:"snippet"`
	BodyText   string    `json:"body_text,omitempty"`
	BodyHTML   string    `json:"body_html,omitempty"`
	Structure  Structure `json:"structure"`
	BodyState  int       `json:"body_state"`
	ThreadSize int       `json:"thread_size,omitempty"`
	// The local junk filter's verdict (internal/mail/spam), inbox mail only.
	Junk      bool   `json:"junk"`
	JunkScore int    `json:"junk_score"`
	JunkWhy   string `json:"junk_why,omitempty"`
	// JunkHdr is the filter's facts from the header (JSON spam.Header),
	// written once when the header is stored.
	JunkHdr string `json:"-"`
	// AI is the assistant's label for the conversation (List only).
	AI *Triage `json:"ai,omitempty"`
}

// UpsertHeader stores a message's envelope and flags. Body fields are kept.
// Returns the row id.
func (s *Store) UpsertHeader(ctx context.Context, m *Message) (int64, error) {
	to, _ := json.Marshal(nonNil(m.To))
	cc, _ := json.Marshal(nonNil(m.Cc))
	st, _ := json.Marshal(m.Structure)
	var id int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO messages
		(account_id, folder_id, uid, message_id, in_reply_to, refs, thread_key, subject, from_name, from_addr,
		 to_json, cc_json, reply_to, date, size, seen, flagged, answered, has_attach, structure, junk_hdr)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(folder_id, uid) DO UPDATE SET seen=excluded.seen, flagged=excluded.flagged, answered=excluded.answered
		RETURNING id`,
		m.AccountID, m.FolderID, m.UID, m.MessageID, m.InReplyTo, m.Refs, m.ThreadKey, m.Subject, m.FromName, m.FromAddr,
		string(to), string(cc), m.ReplyTo, m.Date, m.Size, b2i(m.Seen), b2i(m.Flagged), b2i(m.Answered), b2i(m.HasAttach), string(st), m.JunkHdr).Scan(&id)
	if err != nil {
		return 0, err
	}
	m.ID = id
	people := strings.Join([]string{m.FromName, m.FromAddr, addrsText(m.To), addrsText(m.Cc)}, " ")
	if _, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO messages_fts(rowid, subject, people, body)
		VALUES (?, ?, ?, COALESCE((SELECT body FROM messages_fts WHERE rowid=?), ''))`, id, m.Subject, people, id); err != nil {
		return 0, err
	}
	return id, nil
}

// SetBody stores the decoded text and HTML bodies.
func (s *Store) SetBody(ctx context.Context, id int64, text, html, snippet string) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE messages SET body_text=?, body_html=?, snippet=?, body_state=1 WHERE id=?`, text, html, snippet, id); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE messages_fts SET body=? WHERE rowid=?`, text, id)
	return err
}

// SetFlags updates the local flag state.
func (s *Store) SetFlags(ctx context.Context, id int64, seen, flagged, answered bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET seen=?, flagged=?, answered=? WHERE id=?`, b2i(seen), b2i(flagged), b2i(answered), id)
	return err
}

// DeleteMessages removes rows (expunged or moved away).
func (s *Store) DeleteMessages(ctx context.Context, ids []int64) error {
	for _, id := range ids {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM messages_fts WHERE rowid=?`, id); err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `DELETE FROM messages WHERE id=?`, id); err != nil {
			return err
		}
	}
	return nil
}

// FolderUIDs maps every stored UID of a folder to its row id and flags.
type UIDState struct {
	ID       int64
	Seen     bool
	Flagged  bool
	Answered bool
}

// FolderUIDs returns uid → state for a folder.
func (s *Store) FolderUIDs(ctx context.Context, folderID int64) (map[uint32]UIDState, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT uid, id, seen, flagged, answered FROM messages WHERE folder_id=?`, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uint32]UIDState{}
	for rows.Next() {
		var uid uint32
		var st UIDState
		if err := rows.Scan(&uid, &st.ID, &st.Seen, &st.Flagged, &st.Answered); err != nil {
			return nil, err
		}
		out[uid] = st
	}
	return out, rows.Err()
}

// PendingBodies lists messages of a folder that still need their body, newest first.
func (s *Store) PendingBodies(ctx context.Context, folderID int64, limit int) ([]Message, error) {
	return s.queryMessages(ctx, `WHERE m.folder_id=? AND m.body_state=0 ORDER BY m.date DESC LIMIT ?`, folderID, limit)
}

const msgCols = `m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.in_reply_to, m.refs, m.thread_key, m.subject,
	m.from_name, m.from_addr, m.to_json, m.cc_json, m.reply_to, m.date, m.size, m.seen, m.flagged, m.answered, m.has_attach,
	m.snippet, m.structure, m.body_state, m.junk, m.junk_score, m.junk_why`

func (s *Store) queryMessages(ctx context.Context, tail string, args ...any) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+msgCols+` FROM messages m `+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		var to, cc, st string
		if err := rows.Scan(&m.ID, &m.AccountID, &m.FolderID, &m.UID, &m.MessageID, &m.InReplyTo, &m.Refs, &m.ThreadKey, &m.Subject,
			&m.FromName, &m.FromAddr, &to, &cc, &m.ReplyTo, &m.Date, &m.Size, &m.Seen, &m.Flagged, &m.Answered, &m.HasAttach,
			&m.Snippet, &st, &m.BodyState, &m.Junk, &m.JunkScore, &m.JunkWhy); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(to), &m.To)
		_ = json.Unmarshal([]byte(cc), &m.Cc)
		_ = json.Unmarshal([]byte(st), &m.Structure)
		out = append(out, m)
	}
	return out, rows.Err()
}

// Message loads one message with its bodies.
func (s *Store) Message(ctx context.Context, id int64) (Message, error) {
	ms, err := s.queryMessages(ctx, `WHERE m.id=?`, id)
	if err != nil {
		return Message{}, err
	}
	if len(ms) == 0 {
		return Message{}, ErrNotFound
	}
	m := ms[0]
	err = s.db.QueryRowContext(ctx, `SELECT body_text, body_html FROM messages WHERE id=?`, id).Scan(&m.BodyText, &m.BodyHTML)
	return m, err
}

// Messages loads several messages without bodies.
func (s *Store) Messages(ctx context.Context, ids []int64) ([]Message, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return s.queryMessages(ctx, `WHERE m.id IN (`+ph+`)`, args...)
}

// Query selects a message list.
type Query struct {
	View      string // inbox unread flagged sent drafts trash junk archive folder all
	AccountID int64
	FolderID  int64
	Search    string
	// Junk decides what happens to mail the junk filter flagged: "" leaves
	// it out of inbox, unread and all (it shows everywhere else),
	// "include" keeps it, "only" lists nothing else.
	Junk string
	// Category narrows the list to conversations the assistant labelled so:
	// important updates newsletter spam, or "nospam" for everything not
	// labelled spam. "" is no filter.
	Category string
	Before   int64 // date cursor, exclusive
	BeforeID int64
	Limit    int
}

// SpamSQL is true for a message (as m) that is spam in the inbox's sense:
// the local junk filter flagged it, or the AI labelled its conversation spam.
const SpamSQL = `(m.junk=1 OR EXISTS (SELECT 1 FROM triage t WHERE t.account_id=m.account_id AND t.thread_key=m.thread_key AND t.category='spam'))`

// List runs a list query, newest first.
func (s *Store) List(ctx context.Context, q Query) ([]Message, error) {
	where := []string{}
	args := []any{}
	switch q.View {
	case "folder":
		where = append(where, "m.folder_id=?")
		args = append(args, q.FolderID)
	case "unread":
		where = append(where, "m.seen=0", "f.role='inbox'")
	case "flagged":
		where = append(where, "m.flagged=1", "f.role NOT IN ('trash','junk')")
	case "all", "":
		if q.Search == "" {
			where = append(where, "f.role NOT IN ('trash','junk')")
		}
	default: // a role: inbox sent drafts trash junk archive
		where = append(where, "f.role=?")
		args = append(args, q.View)
	}
	switch {
	case q.Junk == "only":
		where = append(where, "m.junk=1")
	case q.Junk == "include", q.Category == "spam":
	case q.Search == "" && (q.View == "inbox" || q.View == "unread" || q.View == "all" || q.View == ""):
		where = append(where, "m.junk=0")
	}
	if q.AccountID != 0 {
		where = append(where, "m.account_id=?")
		args = append(args, q.AccountID)
	}
	if q.Search != "" {
		fts := ftsQuery(q.Search)
		if fts == "" {
			return []Message{}, nil
		}
		where = append(where, "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)")
		args = append(args, fts)
	}
	// The one place "spam" in the inbox is decided: the local junk filter's
	// flag or the AI's label, either one (SpamSQL).
	switch q.Category {
	case "":
	case "nospam":
		where = append(where, "NOT "+SpamSQL)
	case "spam":
		where = append(where, SpamSQL)
	default:
		where = append(where, "EXISTS (SELECT 1 FROM triage t WHERE t.account_id=m.account_id AND t.thread_key=m.thread_key AND t.category=?)")
		args = append(args, q.Category)
	}
	if q.Before != 0 {
		where = append(where, "(m.date < ? OR (m.date = ? AND m.id < ?))")
		args = append(args, q.Before, q.Before, q.BeforeID)
	}
	if q.Limit <= 0 || q.Limit > 500 {
		q.Limit = 100
	}
	tail := `JOIN folders f ON f.id = m.folder_id`
	if len(where) > 0 {
		tail += ` WHERE ` + strings.Join(where, " AND ")
	}
	tail += ` ORDER BY m.date DESC, m.id DESC LIMIT ?`
	args = append(args, q.Limit)
	ms, err := s.queryMessages(ctx, tail, args...)
	if err != nil {
		return nil, err
	}
	return ms, s.attachTriage(ctx, ms)
}

// ftsQuery turns free text into an FTS5 prefix query: every word must match.
func ftsQuery(s string) string {
	var parts []string
	for _, w := range strings.Fields(s) {
		w = strings.Map(func(r rune) rune {
			if r == '"' || r == '*' || r == '(' || r == ')' || r == ':' || r == '^' {
				return -1
			}
			return r
		}, w)
		if w == "" {
			continue
		}
		parts = append(parts, `"`+w+`"*`)
	}
	return strings.Join(parts, " ")
}

// Thread returns every message of an account sharing the thread key, oldest first.
func (s *Store) Thread(ctx context.Context, accountID int64, key string) ([]Message, error) {
	ms, err := s.queryMessages(ctx, `JOIN folders f ON f.id=m.folder_id WHERE m.account_id=? AND m.thread_key=? AND f.role NOT IN ('trash','junk') ORDER BY m.date ASC, m.id ASC LIMIT 200`, accountID, key)
	if err != nil {
		return nil, err
	}
	// The same message may live in two folders (Gmail labels); keep one.
	seen := map[string]bool{}
	out := ms[:0]
	for _, m := range ms {
		if m.MessageID != "" {
			if seen[m.MessageID] {
				continue
			}
			seen[m.MessageID] = true
		}
		out = append(out, m)
	}
	return out, nil
}

// ThreadKeyFor looks up the stored thread key of any message with this Message-ID.
func (s *Store) ThreadKeyFor(ctx context.Context, accountID int64, msgIDs []string) (string, error) {
	for _, id := range msgIDs {
		if id == "" {
			continue
		}
		var key string
		err := s.db.QueryRowContext(ctx, `SELECT thread_key FROM messages WHERE account_id=? AND message_id=? LIMIT 1`, accountID, id).Scan(&key)
		if err == nil && key != "" {
			return key, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	return "", nil
}

// Counts are the sidebar badges.
type Counts struct {
	Inbox   int `json:"inbox"`
	Unread  int `json:"unread"`
	Flagged int `json:"flagged"`
	// Junk is the inbox conversations that are spam, by the junk filter or
	// the AI (not the Junk folder).
	Junk int `json:"junk"`
}

// UnifiedCounts counts across accounts. Inbox and unread leave out spam
// (SpamSQL: the junk filter's flag or the AI's label); Junk counts the inbox
// conversations that are spam either way.
func (s *Store) UnifiedCounts(ctx context.Context) (Counts, error) {
	var c Counts
	err := s.db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN f.role='inbox' AND NOT `+SpamSQL+` THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN f.role='inbox' AND m.seen=0 AND NOT `+SpamSQL+` THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN m.flagged=1 AND f.role NOT IN ('trash','junk') THEN 1 ELSE 0 END),0)
		FROM messages m JOIN folders f ON f.id=m.folder_id`).Scan(&c.Inbox, &c.Unread, &c.Flagged)
	if err != nil {
		return c, err
	}
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM (SELECT DISTINCT m.account_id, m.thread_key
		FROM messages m JOIN folders f ON f.id=m.folder_id WHERE f.role='inbox' AND `+SpamSQL+`)`).Scan(&c.Junk)
	return c, err
}

// Setting reads a setting, or def when unset.
func (s *Store) Setting(ctx context.Context, key, def string) string {
	var v string
	if err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key=?`, key).Scan(&v); err != nil {
		return def
	}
	return v
}

// SetSetting writes a setting.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// Contact is an address seen in mail.
type Contact struct {
	Addr string `json:"addr"`
	Name string `json:"name"`
}

// SentWeight is the NoteContact weight of an address the user wrote to.
const SentWeight = 5

// NoteContact remembers an address; sent-to weighs more than received-from.
func (s *Store) NoteContact(ctx context.Context, a Address, weight int, when int64) error {
	addr := strings.ToLower(strings.TrimSpace(a.Addr))
	if addr == "" || !strings.Contains(addr, "@") {
		return nil
	}
	sent := 0
	if weight >= SentWeight {
		sent = 1 // the user wrote to it: the junk filter's "known sender"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO contacts(addr, name, weight, last_seen, sent) VALUES(?,?,?,?,?)
		ON CONFLICT(addr) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE contacts.name END,
		weight=contacts.weight+excluded.weight, last_seen=MAX(contacts.last_seen, excluded.last_seen),
		sent=contacts.sent+excluded.sent`, addr, a.Name, weight, when, sent)
	return err
}

// SuggestContacts completes a prefix of a name or address.
func (s *Store) SuggestContacts(ctx context.Context, prefix string, limit int) ([]Contact, error) {
	p := strings.ToLower(strings.TrimSpace(prefix))
	like := "%" + strings.NewReplacer("%", "", "_", "").Replace(p) + "%"
	rows, err := s.db.QueryContext(ctx, `SELECT addr, name FROM contacts WHERE addr LIKE ? OR lower(name) LIKE ?
		ORDER BY weight DESC, last_seen DESC LIMIT ?`, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Contact{}
	for rows.Next() {
		var c Contact
		if err := rows.Scan(&c.Addr, &c.Name); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func nonNil(a []Address) []Address {
	if a == nil {
		return []Address{}
	}
	return a
}

func addrsText(as []Address) string {
	var b strings.Builder
	for _, a := range as {
		b.WriteString(a.Name)
		b.WriteByte(' ')
		b.WriteString(a.Addr)
		b.WriteByte(' ')
	}
	return b.String()
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}
