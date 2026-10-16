package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// How much history is kept locally; older mail is fetched in steps.
var (
	InitialWindow = 500   // newest messages fetched on the first sync of a folder
	BackfillStep  = 500   // older messages added per full sync
	MaxPerFolder  = 20000 // stop backfilling past this
	BodiesPerPass = 300   // bodies fetched per folder per pass
	MaxTextPart   = int64(2 << 20)
)

// sync refreshes the folder list and every folder, or just one folder.
func (w *worker) sync(only string) error {
	ctx := w.ctx
	return w.do(func(c *imapclient.Client, a store.Account) error {
		if only == "" {
			if err := w.syncFolderList(ctx, c, a); err != nil {
				return err
			}
		}
		folders, err := w.e.st.Folders(ctx, a.ID)
		if err != nil {
			return err
		}
		// Inbox first, so new mail shows before history.
		slices.SortStableFunc(folders, func(x, y store.Folder) int {
			return rolePriority(x.Role) - rolePriority(y.Role)
		})
		var firstErr error
		for _, f := range folders {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if only != "" && !strings.EqualFold(f.Name, only) {
				continue
			}
			if !syncable(f) {
				continue
			}
			if err := w.syncFolder(ctx, c, a, f, only == ""); err != nil {
				if isConnErr(c) {
					return err
				}
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", f.Name, err)
				}
			}
			w.e.notify("folder", a.ID)
		}
		return firstErr
	})
}

func rolePriority(r string) int {
	switch r {
	case "inbox":
		return 0
	case "sent":
		return 1
	case "":
		return 3
	}
	return 2
}

// syncable: the virtual "All Mail" and "Flagged" folders duplicate everything.
func syncable(f store.Folder) bool {
	return f.Role != "all" && f.Role != "flagged" && f.Role != "noselect" && f.Role != "important"
}

func isConnErr(c *imapclient.Client) bool {
	select {
	case <-c.Closed():
		return true
	default:
		return false
	}
}

func (w *worker) syncFolderList(ctx context.Context, c *imapclient.Client, a store.Account) error {
	opts := &imap.ListOptions{}
	if c.Caps().Has(imap.CapSpecialUse) {
		opts.ReturnSpecialUse = true
	}
	list, err := c.List("", "*", opts).Collect()
	if err != nil {
		return fmt.Errorf("list: %w", err)
	}
	names := make([]string, 0, len(list))
	taken := map[string]bool{}
	type pending struct {
		d    *imap.ListData
		role string
	}
	var rows []pending
	for _, d := range list {
		role := roleOf(d)
		rows = append(rows, pending{d, role})
		if role != "" && role != "noselect" {
			taken[role] = true
		}
	}
	// Servers without SPECIAL-USE: guess roles by name, once per role.
	for i, r := range rows {
		if r.role == "" {
			if g := roleByName(r.d.Mailbox); g != "" && !taken[g] {
				rows[i].role = g
				taken[g] = true
			}
		}
	}
	for _, r := range rows {
		delim := "/"
		if r.d.Delim != 0 {
			delim = string(r.d.Delim)
		}
		if _, err := w.e.st.UpsertFolder(ctx, a.ID, r.d.Mailbox, delim, r.role); err != nil {
			return err
		}
		names = append(names, r.d.Mailbox)
	}
	return w.e.st.RemoveFoldersExcept(ctx, a.ID, names)
}

func roleOf(d *imap.ListData) string {
	if strings.EqualFold(d.Mailbox, "INBOX") {
		return "inbox"
	}
	for _, at := range d.Attrs {
		switch at {
		case imap.MailboxAttrSent:
			return "sent"
		case imap.MailboxAttrDrafts:
			return "drafts"
		case imap.MailboxAttrTrash:
			return "trash"
		case imap.MailboxAttrJunk:
			return "junk"
		case imap.MailboxAttrArchive:
			return "archive"
		case imap.MailboxAttrAll:
			return "all"
		case imap.MailboxAttrFlagged:
			return "flagged"
		case imap.MailboxAttrImportant:
			return "important"
		}
	}
	for _, at := range d.Attrs {
		if at == imap.MailboxAttrNoSelect || at == imap.MailboxAttrNonExistent {
			return "noselect"
		}
	}
	return ""
}

func roleByName(name string) string {
	n := strings.ToLower(name)
	if i := strings.LastIndexAny(n, "/."); i >= 0 {
		n = n[i+1:]
	}
	switch n {
	case "sent", "sent items", "sent messages", "sent mail":
		return "sent"
	case "drafts", "draft":
		return "drafts"
	case "trash", "deleted", "deleted items", "deleted messages", "bin":
		return "trash"
	case "junk", "spam", "junk e-mail", "junk email", "bulk mail":
		return "junk"
	case "archive", "archives":
		return "archive"
	}
	return ""
}

// syncFolder brings one folder up to date: new mail, flag changes, deletions,
// bodies, and (on a full pass) a step of older history.
func (w *worker) syncFolder(ctx context.Context, c *imapclient.Client, a store.Account, f store.Folder, full bool) error {
	sel, err := c.Select(f.Name, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return err
	}
	if f.UIDValidity != 0 && sel.UIDValidity != f.UIDValidity {
		if err := w.e.st.ResetFolder(ctx, f.ID, sel.UIDValidity); err != nil {
			return err
		}
		f.LastUID = 0
	} else if f.UIDValidity == 0 {
		if err := w.e.st.ResetFolder(ctx, f.ID, sel.UIDValidity); err != nil {
			return err
		}
	}
	local, err := w.e.st.FolderUIDs(ctx, f.ID)
	if err != nil {
		return err
	}
	if sel.NumMessages == 0 {
		ids := make([]int64, 0, len(local))
		for _, s := range local {
			ids = append(ids, s.ID)
		}
		if err := w.e.st.DeleteMessages(ctx, ids); err != nil {
			return err
		}
		return w.e.st.RecountFolder(ctx, f.ID)
	}

	var fetchUIDs []imap.UID
	if f.LastUID == 0 || len(local) == 0 {
		all, err := c.UIDSearch(&imap.SearchCriteria{}, nil).Wait()
		if err != nil {
			return err
		}
		uids := all.AllUIDs()
		slices.Sort(uids)
		if len(uids) > InitialWindow {
			uids = uids[len(uids)-InitialWindow:]
		}
		fetchUIDs = uids
	} else {
		// New mail: everything above the highest stored UID.
		var set imap.UIDSet
		set.AddRange(imap.UID(f.LastUID+1), 0)
		res, err := c.UIDSearch(&imap.SearchCriteria{UID: []imap.UIDSet{set}}, nil).Wait()
		if err != nil {
			return err
		}
		for _, u := range res.AllUIDs() {
			if uint32(u) > f.LastUID {
				fetchUIDs = append(fetchUIDs, u)
			}
		}
		if err := w.reconcile(ctx, c, f, local); err != nil {
			return err
		}
		if full {
			older, err := w.olderUIDs(c, local)
			if err != nil {
				return err
			}
			fetchUIDs = append(fetchUIDs, older...)
		}
	}
	c, err = w.fetchHeaders(ctx, c, a, f, fetchUIDs)
	if err != nil {
		return err
	}
	if err := w.fetchBodies(ctx, c, f); err != nil {
		return err
	}
	if f.Role == "inbox" {
		if err := w.backfillJunk(ctx, c, f); err != nil {
			if isConnErr(c) {
				return err
			}
			slog.Warn("mail: junk filter: read headers", "folder", f.Name, "err", err)
		}
	}
	return w.e.st.RecountFolder(ctx, f.ID)
}

// reconcile refreshes flags of stored messages and drops the ones the server expunged.
func (w *worker) reconcile(ctx context.Context, c *imapclient.Client, f store.Folder, local map[uint32]store.UIDState) error {
	if len(local) == 0 {
		return nil
	}
	minUID := uint32(0)
	for u := range local {
		if minUID == 0 || u < minUID {
			minUID = u
		}
	}
	var set imap.UIDSet
	set.AddRange(imap.UID(minUID), imap.UID(f.LastUID))
	cmd := c.Fetch(set, &imap.FetchOptions{UID: true, Flags: true})
	present := map[uint32]bool{}
	for {
		msg := cmd.Next()
		if msg == nil {
			break
		}
		buf, err := msg.Collect()
		if err != nil {
			cmd.Close()
			return err
		}
		uid := uint32(buf.UID)
		present[uid] = true
		st, ok := local[uid]
		if !ok {
			continue
		}
		seen, flagged, answered := flagsOf(buf.Flags)
		if seen != st.Seen || flagged != st.Flagged || answered != st.Answered {
			if err := w.e.st.SetFlags(ctx, st.ID, seen, flagged, answered); err != nil {
				cmd.Close()
				return err
			}
		}
	}
	if err := cmd.Close(); err != nil {
		return err
	}
	var gone []int64
	for u, st := range local {
		if !present[u] {
			gone = append(gone, st.ID)
		}
	}
	return w.e.st.DeleteMessages(ctx, gone)
}

// olderUIDs returns the next step of history below the oldest stored message.
func (w *worker) olderUIDs(c *imapclient.Client, local map[uint32]store.UIDState) ([]imap.UID, error) {
	if len(local) >= MaxPerFolder {
		return nil, nil
	}
	minUID := uint32(0)
	for u := range local {
		if minUID == 0 || u < minUID {
			minUID = u
		}
	}
	if minUID <= 1 {
		return nil, nil
	}
	var set imap.UIDSet
	set.AddRange(1, imap.UID(minUID-1))
	res, err := c.UIDSearch(&imap.SearchCriteria{UID: []imap.UIDSet{set}}, nil).Wait()
	if err != nil {
		return nil, err
	}
	uids := res.AllUIDs()
	slices.Sort(uids)
	if len(uids) > BackfillStep {
		uids = uids[len(uids)-BackfillStep:]
	}
	return uids, nil
}

func flagsOf(fl []imap.Flag) (seen, flagged, answered bool) {
	for _, f := range fl {
		switch f {
		case imap.FlagSeen:
			seen = true
		case imap.FlagFlagged:
			flagged = true
		case imap.FlagAnswered:
			answered = true
		}
	}
	return
}

var headerSection = &imap.FetchItemBodySection{Specifier: imap.PartSpecifierHeader, Peek: true}

// fetchHeaders stores header, flags and structure for the given UIDs, newest
// first, in batches. A batch the server answers with something unreadable is
// split in two until the one bad message is found; that one is stored from
// what can be read without its body structure, so a single malformed message
// never stops a folder. It returns the connection to go on with, which is a
// new one when a bad answer closed the old.
func (w *worker) fetchHeaders(ctx context.Context, c *imapclient.Client, a store.Account, f store.Folder, uids []imap.UID) (*imapclient.Client, error) {
	slices.Sort(uids)
	slices.Reverse(uids)
	for start := 0; start < len(uids); start += 100 {
		var err error
		c, err = w.fetchHeaderRange(ctx, c, a, f, uids[start:min(start+100, len(uids))])
		if err != nil {
			return c, err
		}
		if err := w.e.st.RecountFolder(ctx, f.ID); err != nil {
			return c, err
		}
		w.e.notify("messages", a.ID)
	}
	return c, nil
}

func (w *worker) fetchHeaderRange(ctx context.Context, c *imapclient.Client, a store.Account, f store.Folder, uids []imap.UID) (*imapclient.Client, error) {
	if ctx.Err() != nil {
		return c, ctx.Err()
	}
	var set imap.UIDSet
	for _, u := range uids {
		set.AddNum(u)
	}
	msgs, err := c.Fetch(set, &imap.FetchOptions{
		UID: true, Flags: true, RFC822Size: true, InternalDate: true,
		BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
		BodySection:   []*imap.FetchItemBodySection{headerSection},
	}).Collect()
	if err == nil {
		return c, w.storeHeaders(ctx, a, f, msgs)
	}
	if !isConnErr(c) && !looksUnreadable(err) {
		return c, err
	}
	// The answer could not be read, and the connection may be gone with it.
	if c, err = w.reselect(ctx, c, f); err != nil {
		return c, err
	}
	if len(uids) == 1 {
		return w.fetchHeaderPlain(ctx, c, a, f, uids[0])
	}
	half := len(uids) / 2
	if c, err = w.fetchHeaderRange(ctx, c, a, f, uids[:half]); err != nil {
		return c, err
	}
	return w.fetchHeaderRange(ctx, c, a, f, uids[half:])
}

// fetchHeaderPlain stores one message the server cannot describe: its header
// and flags, without a body structure; the body is then the whole TEXT part.
func (w *worker) fetchHeaderPlain(ctx context.Context, c *imapclient.Client, a store.Account, f store.Folder, uid imap.UID) (*imapclient.Client, error) {
	msgs, err := c.Fetch(imap.UIDSetNum(uid), &imap.FetchOptions{
		UID: true, Flags: true, RFC822Size: true, InternalDate: true,
		BodySection: []*imap.FetchItemBodySection{headerSection},
	}).Collect()
	if err != nil {
		if c, err = w.reselect(ctx, c, f); err != nil {
			return c, err
		}
		// Not even the header: keep a row so the UID is not asked for again.
		msgs = []*imapclient.FetchMessageBuffer{{UID: uid}}
	}
	for _, buf := range msgs {
		m := w.messageFromFetch(ctx, a, f, buf)
		m.Structure = store.Structure{Text: &store.Part{Path: "1", Type: "text/plain"}}
		if m.Subject == "" {
			m.Subject = "(this message could not be read from the server)"
		}
		if _, err := w.e.st.UpsertHeader(ctx, m); err != nil {
			return c, err
		}
		if err := w.e.st.SetLastUID(ctx, f.ID, m.UID); err != nil {
			return c, err
		}
	}
	return c, nil
}

// looksUnreadable: the reply did not parse (as opposed to a NO or a timeout).
func looksUnreadable(err error) bool {
	var ie *imap.Error
	if errors.As(err, &ie) {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "imapwire") || strings.Contains(s, "expected") || strings.Contains(s, "in response") || strings.Contains(s, "parse")
}

// reselect redials when the connection died and selects the folder again.
// The caller holds w.mu (it runs inside w.do).
func (w *worker) reselect(ctx context.Context, c *imapclient.Client, f store.Folder) (*imapclient.Client, error) {
	if isConnErr(c) {
		w.c = nil
		nc, _, err := w.conn()
		if err != nil {
			return c, err
		}
		c = nc
	}
	if _, err := c.Select(f.Name, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
		return c, err
	}
	return c, ctx.Err()
}

func (w *worker) storeHeaders(ctx context.Context, a store.Account, f store.Folder, msgs []*imapclient.FetchMessageBuffer) error {
	maxUID := uint32(0)
	var inbox []int64
	for _, buf := range msgs {
		m := w.messageFromFetch(ctx, a, f, buf)
		if _, err := w.e.st.UpsertHeader(ctx, m); err != nil {
			return err
		}
		if f.Role == "inbox" {
			inbox = append(inbox, m.ID)
		}
		if m.UID > maxUID {
			maxUID = m.UID
		}
		switch f.Role {
		case "sent":
			for _, t := range append(m.To, m.Cc...) {
				_ = w.e.st.NoteContact(ctx, t, 5, m.Date)
			}
		case "inbox":
			_ = w.e.st.NoteContact(ctx, store.Address{Name: m.FromName, Addr: m.FromAddr}, 1, m.Date)
		}
	}
	// New inbox mail is judged on its header at once, so junk never flashes
	// in the inbox while its body is on the way; judged again with the body.
	if len(inbox) > 0 {
		if err := w.e.judge(ctx, inbox); err != nil {
			slog.Warn("mail: junk filter: judge", "err", err)
		}
	}
	if f.Role == "sent" && len(msgs) > 0 {
		w.e.liftKnown(ctx)
	}
	return w.e.st.SetLastUID(ctx, f.ID, maxUID)
}

func (w *worker) messageFromFetch(ctx context.Context, a store.Account, f store.Folder, buf *imapclient.FetchMessageBuffer) *store.Message {
	m := &store.Message{AccountID: a.ID, FolderID: f.ID, UID: uint32(buf.UID), Size: buf.RFC822Size}
	m.Seen, m.Flagged, m.Answered = flagsOf(buf.Flags)
	var hi headerInfo
	m.JunkHdr = "{}" // no header to read: never asked for again
	for _, sec := range buf.BodySection {
		if sec.Section != nil && sec.Section.Specifier == imap.PartSpecifierHeader {
			hi = parseHeader(sec.Bytes)
			m.JunkHdr = headerFacts(sec.Bytes)
		}
	}
	m.Subject, m.MessageID, m.InReplyTo, m.ReplyTo = hi.Subject, hi.MessageID, hi.InReplyTo, hi.ReplyTo
	m.FromName, m.FromAddr = hi.From.Name, hi.From.Addr
	m.To, m.Cc = hi.To, hi.Cc
	if !hi.Date.IsZero() {
		m.Date = hi.Date.Unix()
	}
	// A missing or future Date is replaced by when the server received it.
	if !buf.InternalDate.IsZero() && (m.Date == 0 || m.Date > buf.InternalDate.Unix()+86400) {
		m.Date = buf.InternalDate.Unix()
	}
	m.Refs = strings.Join(hi.Refs, " ")
	m.Structure = structureOf(buf.BodyStructure)
	m.HasAttach = hasAttachments(m.Structure)
	m.ThreadKey = w.threadKey(ctx, a.ID, m, hi.Refs)
	return m
}

// threadKey is the root Message-ID of the conversation.
func (w *worker) threadKey(ctx context.Context, accountID int64, m *store.Message, refs []string) string {
	if len(refs) > 0 {
		return refs[0]
	}
	if m.InReplyTo != "" {
		if k, _ := w.e.st.ThreadKeyFor(ctx, accountID, []string{m.InReplyTo}); k != "" {
			return k
		}
		return m.InReplyTo
	}
	if m.MessageID != "" {
		return m.MessageID
	}
	return "subject:" + normSubject(m.Subject)
}

// fetchBodies downloads and decodes the text parts of messages that lack them.
func (w *worker) fetchBodies(ctx context.Context, c *imapclient.Client, f store.Folder) error {
	pending, err := w.e.st.PendingBodies(ctx, f.ID, BodiesPerPass)
	if err != nil {
		return err
	}
	for start := 0; start < len(pending); start += 25 {
		batch := pending[start:min(start+25, len(pending))]
		if err := w.fetchBodyBatch(ctx, c, batch); err != nil {
			return err
		}
		w.e.afterBodies(ctx, f, batch)
		w.e.notify("messages", f.AccountID)
	}
	return nil
}

func textSections(m store.Message) []*imap.FetchItemBodySection {
	var out []*imap.FetchItemBodySection
	for _, p := range []*store.Part{m.Structure.Text, m.Structure.HTML} {
		if p == nil {
			continue
		}
		out = append(out, &imap.FetchItemBodySection{Part: parsePath(p.Path), Peek: true,
			Partial: &imap.SectionPartial{Offset: 0, Size: MaxTextPart}})
	}
	return out
}

// fetchBodyBatch fetches the text parts of messages from one folder, which must be selected.
func (w *worker) fetchBodyBatch(ctx context.Context, c *imapclient.Client, batch []store.Message) error {
	byUID := map[uint32]store.Message{}
	var set imap.UIDSet
	var sections []*imap.FetchItemBodySection
	seenSec := map[string]bool{}
	for _, m := range batch {
		byUID[m.UID] = m
		set.AddNum(imap.UID(m.UID))
		for _, s := range textSections(m) {
			k := partPath(s.Part)
			if !seenSec[k] {
				seenSec[k] = true
				sections = append(sections, s)
			}
		}
	}
	if len(sections) == 0 {
		for _, m := range batch {
			if err := w.e.st.SetBody(ctx, m.ID, "", "", ""); err != nil {
				return err
			}
		}
		return nil
	}
	msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true, BodySection: sections}).Collect()
	if err != nil {
		return err
	}
	for _, buf := range msgs {
		m, ok := byUID[uint32(buf.UID)]
		if !ok {
			continue
		}
		get := func(p *store.Part) string {
			if p == nil {
				return ""
			}
			want := partPath(parsePath(p.Path))
			for _, sec := range buf.BodySection {
				if partPath(sec.Section.Part) == want {
					return decodePart(sec.Bytes, p.Encoding, p.Charset)
				}
			}
			return ""
		}
		text := get(m.Structure.Text)
		htmlBody := get(m.Structure.HTML)
		if htmlBody != "" {
			htmlBody = CleanHTML(htmlBody)
		}
		if strings.TrimSpace(text) == "" && htmlBody != "" {
			text = htmlToText(htmlBody)
		}
		if err := w.e.st.SetBody(ctx, m.ID, text, htmlBody, snippet(text)); err != nil {
			return err
		}
		delete(byUID, m.UID)
	}
	// Whatever the server did not return (expunged meanwhile) is marked done.
	for _, m := range byUID {
		if err := w.e.st.SetBody(ctx, m.ID, "", "", ""); err != nil {
			return err
		}
	}
	return nil
}

// EnsureBody fetches a message's body now if the background pass has not yet.
func (e *Engine) EnsureBody(ctx context.Context, id int64) (store.Message, error) {
	m, err := e.st.Message(ctx, id)
	if err != nil || m.BodyState == 1 {
		return m, err
	}
	w, err := e.worker(m.AccountID)
	if err != nil {
		return m, err
	}
	f, err := e.st.Folder(ctx, m.FolderID)
	if err != nil {
		return m, err
	}
	err = w.do(func(c *imapclient.Client, a store.Account) error {
		if _, err := c.Select(f.Name, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
			return err
		}
		return w.fetchBodyBatch(ctx, c, []store.Message{m})
	})
	if err != nil {
		return m, err
	}
	e.afterBodies(ctx, f, []store.Message{m})
	return e.st.Message(ctx, id)
}

// ErrNoPart is returned for an unknown part path.
var ErrNoPart = errors.New("no such part")

// FetchPart downloads one decoded part (an attachment or inline image).
func (e *Engine) FetchPart(ctx context.Context, id int64, path string) (store.Part, []byte, error) {
	m, err := e.st.Message(ctx, id)
	if err != nil {
		return store.Part{}, nil, err
	}
	var part *store.Part
	for i := range m.Structure.Parts {
		p := m.Structure.Parts[i]
		if p.Path == path || (strings.HasPrefix(path, "cid:") && p.ContentID == strings.TrimPrefix(path, "cid:")) {
			part = &p
			break
		}
	}
	if part == nil {
		return store.Part{}, nil, ErrNoPart
	}
	w, err := e.worker(m.AccountID)
	if err != nil {
		return *part, nil, err
	}
	f, err := e.st.Folder(ctx, m.FolderID)
	if err != nil {
		return *part, nil, err
	}
	var data []byte
	err = w.do(func(c *imapclient.Client, a store.Account) error {
		if _, err := c.Select(f.Name, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
			return err
		}
		sec := &imap.FetchItemBodySection{Part: parsePath(part.Path), Peek: true}
		bufs, err := c.Fetch(imap.UIDSetNum(imap.UID(m.UID)), &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{sec}}).Collect()
		if err != nil {
			return err
		}
		if len(bufs) == 0 || len(bufs[0].BodySection) == 0 {
			return ErrNoPart
		}
		data = decodeTransfer(bufs[0].BodySection[0].Bytes, part.Encoding)
		return nil
	})
	return *part, data, err
}
