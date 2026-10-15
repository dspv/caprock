package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/spam"
)

// The local junk filter at sync time (internal/mail/spam has the rules and
// the classifier). New inbox mail is judged when its header lands and again
// when its body does; mail already stored when the filter arrived gets its
// header read again in bounded steps and is judged then. The verdict only
// hides a message from the inbox: nothing moves on the server unless the
// user presses Spam.

// Limits; tests shorten them.
var (
	// AutoLearnCap is how many messages of each kind are learned without the
	// user (the Junk folder as spam; the Sent folder and mail the user
	// replied to, starred, or got from a correspondent as ham). The user's own
	// Spam and Not spam are always learned.
	AutoLearnCap = 2000
	// JunkHeaderStep is how many stored inbox messages get their header read
	// again per sync pass, newest first, until every one has.
	JunkHeaderStep = 300
	// RejudgeCap is how many of the newest inbox messages are judged again
	// (locally, from stored facts) when the classifier first becomes ready.
	RejudgeCap = 2000
	// MaxJunkTokens bounds the classifier's table.
	MaxJunkTokens = 60000
)

// junkHeader is the filter's facts for a stored message: from the header read
// at sync, else what the row itself has.
func junkHeader(r store.JunkInput) spam.Header {
	var h spam.Header
	if r.Hdr != "" {
		_ = json.Unmarshal([]byte(r.Hdr), &h)
	}
	if h.FromAddr == "" {
		h.FromName, h.FromAddr = r.FromName, r.FromAddr
	}
	if h.ReplyTo == "" {
		h.ReplyTo = r.ReplyTo
	}
	if h.Subject == "" {
		h.Subject = r.Subject
	}
	return h
}

func junkKey(r store.JunkInput) string {
	if r.MessageID != "" {
		return r.MessageID
	}
	return fmt.Sprintf("uid:%d:%d", r.FolderID, r.UID)
}

func junkTokens(r store.JunkInput) []string {
	return spam.Tokens(junkHeader(r), spam.Body{Text: r.BodyText, HTML: r.BodyHTML})
}

// known: the user wrote to the sender, vouched for it, it is the user's own
// address, or the conversation has the user's reply in it.
func (e *Engine) known(ctx context.Context, r store.JunkInput) bool {
	if ok, err := e.st.KnownSender(ctx, r.FromAddr); err == nil && ok {
		return true
	}
	ok, err := e.st.ThreadHasSent(ctx, r.AccountID, r.ThreadKey)
	return err == nil && ok
}

// judge computes and stores the verdict of inbox messages; others are skipped.
func (e *Engine) judge(ctx context.Context, ids []int64) error {
	rows, err := e.st.JunkInputs(ctx, ids)
	if err != nil {
		return err
	}
	nSpam, nHam := e.st.JunkTotals(ctx)
	folders := map[int64]bool{}
	for _, r := range rows {
		if r.Role != "inbox" {
			continue
		}
		h := junkHeader(r)
		b := spam.Body{Text: r.BodyText, HTML: r.BodyHTML}
		toks := spam.Tokens(h, b)
		var counts map[string]spam.Counts
		if nSpam >= spam.MinTrained && nHam >= spam.MinTrained {
			raw, err := e.st.TokenCounts(ctx, toks)
			if err != nil {
				return err
			}
			counts = make(map[string]spam.Counts, len(raw))
			for t, c := range raw {
				counts[t] = spam.Counts{Spam: c[0], Ham: c[1]}
			}
		}
		v := spam.Judge(h, b, toks, counts, nSpam, nHam, spam.Context{Known: e.known(ctx, r), Answered: r.Answered, Flagged: r.Flagged})
		if err := e.st.SetJunk(ctx, r.ID, v.Junk, v.Score, v.Why()); err != nil {
			return err
		}
		if v.Junk != r.Junk {
			folders[r.FolderID] = true
		}
	}
	for f := range folders {
		if err := e.st.RecountFolder(ctx, f); err != nil {
			return err
		}
	}
	return nil
}

// autoLearn teaches the classifier from mail whose kind is already known:
// the server's Junk folder is spam; the user's Sent mail, and inbox mail the
// user replied to, starred or got from a correspondent, is ham. Mail that is
// merely read is not used: an inbox full of read junk is the very problem.
func (e *Engine) autoLearn(ctx context.Context, f store.Folder, ids []int64) error {
	if f.Role != "junk" && f.Role != "sent" && f.Role != "inbox" {
		return nil
	}
	nSpam, nHam := e.st.JunkTotals(ctx)
	wasReady := nSpam >= spam.MinTrained && nHam >= spam.MinTrained
	rows, err := e.st.JunkInputs(ctx, ids)
	if err != nil {
		return err
	}
	learned := false
	for _, r := range rows {
		var isSpam bool
		switch {
		case f.Role == "junk" && nSpam < AutoLearnCap:
			isSpam = true
		case f.Role == "sent" && nHam < AutoLearnCap:
		case f.Role == "inbox" && nHam < AutoLearnCap && !r.Junk && (r.Answered || r.Flagged || e.known(ctx, r)):
		default:
			continue
		}
		ok, err := e.st.Learn(ctx, r.AccountID, junkKey(r), junkTokens(r), isSpam, false)
		if err != nil {
			return err
		}
		if ok {
			learned = true
			if isSpam {
				nSpam++
			} else {
				nHam++
			}
		}
	}
	if !learned {
		return nil
	}
	if err := e.st.PruneJunkTokens(ctx, MaxJunkTokens); err != nil {
		return err
	}
	// The classifier's first opinion: judge the inbox again with it, from
	// the stored facts, no server round trip.
	if !wasReady && nSpam >= spam.MinTrained && nHam >= spam.MinTrained {
		recent, err := e.st.InboxIDs(ctx, RejudgeCap)
		if err != nil {
			return err
		}
		return e.judge(ctx, recent)
	}
	return nil
}

// liftKnown un-hides inbox mail whose sender became known (new Sent mail).
func (e *Engine) liftKnown(ctx context.Context) {
	folders, err := e.st.LiftKnownJunk(ctx)
	if err != nil {
		slog.Warn("mail: junk filter: known senders", "err", err)
		return
	}
	for _, f := range folders {
		_ = e.st.RecountFolder(ctx, f)
	}
	if len(folders) > 0 {
		e.notify("messages", 0)
	}
}

// afterBodies runs the filter on messages whose bodies just arrived.
func (e *Engine) afterBodies(ctx context.Context, f store.Folder, ms []store.Message) {
	ids := make([]int64, len(ms))
	for i, m := range ms {
		ids[i] = m.ID
	}
	if err := e.autoLearn(ctx, f, ids); err != nil {
		slog.Warn("mail: junk filter: learn", "err", err)
	}
	if f.Role == "inbox" {
		if err := e.judge(ctx, ids); err != nil {
			slog.Warn("mail: junk filter: judge", "err", err)
		}
	}
}

// learnFromUser teaches the classifier the user's own verdict. Spam also
// takes the sender off the vouched-for list; Not spam puts it on (which
// lifts the verdict from its other inbox mail too).
func (e *Engine) learnFromUser(ctx context.Context, ids []int64, isSpam bool) error {
	rows, err := e.st.JunkInputs(ctx, ids)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := e.st.Learn(ctx, r.AccountID, junkKey(r), junkTokens(r), isSpam, true); err != nil {
			return err
		}
		if isSpam {
			err = e.st.DisallowSender(ctx, r.FromAddr)
		} else {
			err = e.st.AllowSender(ctx, r.FromAddr)
		}
		if err != nil {
			return err
		}
	}
	return e.st.PruneJunkTokens(ctx, MaxJunkTokens)
}

// notJunk is the user's "Not spam": mail in a Junk folder goes back to the
// inbox (ActNotSpam, which learns), mail the filter hid stays where it is and
// shows in the inbox again. Either way the sender is never junk again.
func (e *Engine) notJunk(ctx context.Context, ids []int64) error {
	rows, err := e.st.JunkInputs(ctx, ids)
	if err != nil {
		return err
	}
	var inJunk, hidden []int64
	folders := map[int64]bool{}
	for _, r := range rows {
		if r.Role == "junk" {
			inJunk = append(inJunk, r.ID)
			continue
		}
		hidden = append(hidden, r.ID)
		folders[r.FolderID] = true
	}
	if len(hidden) > 0 {
		if err := e.learnFromUser(ctx, hidden, false); err != nil {
			return err
		}
		for _, r := range rows {
			if r.Role != "junk" {
				if err := e.st.SetJunk(ctx, r.ID, false, min(r.JunkScore, 49), "you-said-not-junk"); err != nil {
					return err
				}
			}
		}
		for f := range folders {
			if err := e.st.RecountFolder(ctx, f); err != nil {
				return err
			}
		}
	}
	if len(inJunk) > 0 {
		return e.Apply(ctx, inJunk, ActNotSpam, 0)
	}
	e.notify("messages", 0)
	return nil
}

// backfillJunk reads the header again for inbox mail stored before the
// filter existed, a step per pass, and judges it.
func (w *worker) backfillJunk(ctx context.Context, c *imapclient.Client, f store.Folder) error {
	pending, err := w.e.st.MissingJunkHeader(ctx, f.ID, JunkHeaderStep)
	if err != nil || len(pending) == 0 {
		return err
	}
	byUID := map[uint32]int64{}
	var set imap.UIDSet
	for _, p := range pending {
		byUID[p.UID] = p.ID
		set.AddNum(imap.UID(p.UID))
	}
	msgs, err := c.Fetch(set, &imap.FetchOptions{UID: true, BodySection: []*imap.FetchItemBodySection{headerSection}}).Collect()
	if err != nil {
		return err
	}
	ids := make([]int64, 0, len(pending))
	for _, buf := range msgs {
		id, ok := byUID[uint32(buf.UID)]
		if !ok {
			continue
		}
		for _, sec := range buf.BodySection {
			if sec.Section != nil && sec.Section.Specifier == imap.PartSpecifierHeader {
				if err := w.e.st.SetJunkHeader(ctx, id, headerFacts(sec.Bytes)); err != nil {
					return err
				}
				delete(byUID, uint32(buf.UID))
				ids = append(ids, id)
			}
		}
	}
	// Whatever the server would not give is marked read, so it is not asked for again.
	for _, id := range byUID {
		if err := w.e.st.SetJunkHeader(ctx, id, "{}"); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := w.e.judge(ctx, ids); err != nil {
		return err
	}
	w.e.notify("messages", f.AccountID)
	return nil
}

// headerFacts is the JSON the filter keeps from a raw header.
func headerFacts(raw []byte) string {
	b, err := json.Marshal(spam.ParseHeader(raw))
	if err != nil {
		return "{}"
	}
	return string(b)
}
