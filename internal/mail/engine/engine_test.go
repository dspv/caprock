package engine

import (
	"context"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/secrets"
)

type harness struct {
	t   *testing.T
	srv *fakemail.Server
	st  *store.Store
	e   *Engine
	acc store.Account
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	st, err := store.Open(filepath.Join(t.TempDir(), "mail.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	ipn, _ := strconv.Atoi(ip)
	spn, _ := strconv.Atoi(sp)
	a := store.Account{Name: "Me", Email: "me@fake.test", Username: "me@fake.test",
		IMAPHost: ih, IMAPPort: ipn, IMAPTLS: "none", SMTPHost: sh, SMTPPort: spn, SMTPTLS: "none"}
	id, err := st.AddAccount(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	a.ID = id
	sec := &secrets.Memory{}
	_ = sec.Set(id, "pw")
	e := New(st, sec, nil)
	t.Cleanup(e.Stop)
	return &harness{t: t, srv: srv, st: st, e: e, acc: a}
}

func (h *harness) waitFor(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("timed out waiting for %s", what)
}

func (h *harness) list(view string) []store.Message {
	ms, err := h.st.List(context.Background(), store.Query{View: view})
	if err != nil {
		h.t.Fatal(err)
	}
	return ms
}

func TestSyncActionsAndSend(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "Ana <ana@example.com>", To: "me@fake.test", Subject: "Quarterly numbers",
		Body: "Here are the numbers for Q3.\n\n> old quote", Date: base, MessageID: "root@x"}.Raw())
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "Bo <bo@example.com>", To: "me@fake.test", Subject: "Re: Quarterly numbers",
		Body: "Looks good to me.", Date: base.Add(time.Minute), MessageID: "reply@x", InReplyTo: "root@x"}.Raw())
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "News <news@example.com>", To: "me@fake.test", Subject: "Weekly digest",
		Body: "plain", HTML: "<p>Hello <b>world</b><script>alert(1)</script><img src=x onerror=alert(1)></p>", Date: base.Add(2 * time.Minute)}.Raw())
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "Cy <cy@example.com>", To: "me@fake.test", Subject: "Contract",
		Body: "Signed copy attached.", Attach: "contract.pdf", Date: base.Add(3 * time.Minute)}.Raw())

	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("inbox synced with bodies", func() bool {
		ms := h.list("inbox")
		if len(ms) != 4 {
			return false
		}
		for _, m := range ms {
			if m.BodyState != 1 {
				return false
			}
		}
		return true
	})

	ms := h.list("inbox")
	if ms[0].Subject != "Contract" || !ms[0].HasAttach {
		t.Fatalf("newest first with attachment, got %+v", ms[0])
	}
	if got := ms[3].Snippet; got != "Here are the numbers for Q3." {
		t.Fatalf("snippet skips quotes, got %q", got)
	}
	if ms[2].ThreadKey != "root@x" || ms[3].ThreadKey != "root@x" {
		t.Fatalf("reply threads under its root: %q %q", ms[2].ThreadKey, ms[3].ThreadKey)
	}
	news, _ := h.st.Message(ctx, ms[1].ID)
	if strings.Contains(news.BodyHTML, "<script") || strings.Contains(news.BodyHTML, "onerror") {
		t.Fatalf("html not cleaned: %s", news.BodyHTML)
	}

	// Search finds body text and sender.
	found, _ := h.st.List(ctx, store.Query{Search: "Q3"})
	if len(found) != 1 {
		t.Fatalf("search Q3: %d", len(found))
	}
	found, _ = h.st.List(ctx, store.Query{Search: "ana"})
	if len(found) != 1 {
		t.Fatalf("search by sender: %d", len(found))
	}

	// Attachment download decodes base64.
	contract := ms[0]
	part, data, err := h.e.FetchPart(ctx, contract.ID, contract.Structure.Parts[0].Path)
	if err != nil || part.Filename != "contract.pdf" || !strings.HasPrefix(string(data), "%PDF-1.4") {
		t.Fatalf("attachment: %v %q %q", err, part.Filename, data)
	}

	// Read, flag, archive.
	if err := h.e.Apply(ctx, []int64{ms[3].ID}, ActRead, 0); err != nil {
		t.Fatal(err)
	}
	if err := h.e.Apply(ctx, []int64{ms[2].ID}, ActFlag, 0); err != nil {
		t.Fatal(err)
	}
	if err := h.e.Apply(ctx, []int64{ms[1].ID}, ActArchive, 0); err != nil {
		t.Fatal(err)
	}
	h.waitFor("archive synced", func() bool { return len(h.list("archive")) == 1 && len(h.list("inbox")) == 3 })

	// Server state survives a full resync from scratch.
	h.e.SyncNow(0)
	h.waitFor("flags kept", func() bool {
		ms := h.list("inbox")
		var read, flagged bool
		for _, m := range ms {
			if m.Subject == "Quarterly numbers" {
				read = m.Seen
			}
			if m.Subject == "Re: Quarterly numbers" {
				flagged = m.Flagged
			}
		}
		return read && flagged
	})

	// Trash, then delete for good.
	if err := h.e.Apply(ctx, []int64{ms[0].ID}, ActTrash, 0); err != nil {
		t.Fatal(err)
	}
	h.waitFor("in trash", func() bool { return len(h.list("trash")) == 1 })
	tr := h.list("trash")[0]
	if err := h.e.Apply(ctx, []int64{tr.ID}, ActTrash, 0); err != nil {
		t.Fatal(err)
	}
	if len(h.list("trash")) != 0 {
		t.Fatal("trash in trash should expunge")
	}

	// Reply to self: SMTP delivers, Sent gets a copy, the original is answered,
	// and the reply joins the thread.
	root := ms[3]
	err = h.e.Send(ctx, Draft{AccountID: h.acc.ID, To: []store.Address{{Addr: "me@fake.test"}},
		Subject: "Re: Quarterly numbers", Text: "Thanks — filed.", InReplyTo: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	if h.srv.SentCount() != 1 {
		t.Fatal("smtp did not get the message")
	}
	h.waitFor("sent copy", func() bool { return len(h.list("sent")) == 1 })
	h.e.SyncNow(0)
	h.waitFor("reply delivered and threaded", func() bool {
		th, _ := h.st.Thread(ctx, h.acc.ID, "root@x")
		return len(th) == 3
	})
	got, _ := h.st.Message(ctx, root.ID)
	if !got.Answered {
		t.Fatal("original not marked answered")
	}
	sug, _ := h.st.SuggestContacts(ctx, "an", 5)
	if len(sug) == 0 || sug[0].Addr != "ana@example.com" {
		t.Fatalf("contacts: %+v", sug)
	}
}

func TestNewMailArrivesByIdle(t *testing.T) {
	FullSyncEvery = time.Hour // only IDLE can bring it
	defer func() { FullSyncEvery = 5 * time.Minute }()
	h := newHarness(t)
	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("first sync", func() bool {
		a, _ := h.st.Account(context.Background(), h.acc.ID)
		return a.LastSync != 0
	})
	time.Sleep(200 * time.Millisecond) // let IDLE start
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "x@example.com", To: "me@fake.test", Subject: "ping", Body: "hi"}.Raw())
	h.waitFor("pushed mail", func() bool { return len(h.list("inbox")) == 1 })
}
