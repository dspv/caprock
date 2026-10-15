package engine

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/spam"
)

const (
	arPass = "Authentication-Results: mx.fake.test; spf=pass smtp.mailfrom=%[1]s; dkim=pass header.d=%[1]s; dmarc=pass header.from=%[1]s\r\n"
	arFail = "Authentication-Results: mx.fake.test; spf=fail smtp.mailfrom=%[1]s; dkim=none; dmarc=fail header.from=%[1]s\r\n"
)

func (h *harness) bySubject(q store.Query, subject string) (store.Message, bool) {
	ms, err := h.st.List(context.Background(), q)
	if err != nil {
		h.t.Fatal(err)
	}
	for _, m := range ms {
		if m.Subject == subject {
			return m, true
		}
	}
	return store.Message{}, false
}

func (h *harness) allBodies(view string) bool {
	ms, _ := h.st.List(context.Background(), store.Query{View: view, Junk: "include"})
	for _, m := range ms {
		if m.BodyState != 1 {
			return false
		}
	}
	return len(ms) > 0
}

// The filter hides junk from the inbox at sync, keeps a known correspondent
// whose checks fail, learns from Not spam and Spam, and never moves anything
// by itself.
func TestJunkFilterAtSync(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	deliver := func(folder string, m fakemail.Msg) {
		t.Helper()
		if m.To == "" {
			m.To = "me@fake.test"
		}
		if err := h.srv.Deliver(folder, m.Raw()); err != nil {
			t.Fatal(err)
		}
	}
	// The user once wrote to Rui.
	deliver("Sent", fakemail.Msg{From: "me@fake.test", To: "Rui Costa <rui@small-firm.example>", Subject: "Invoice", Body: "Could you resend it?", Date: base})
	deliver("INBOX", fakemail.Msg{From: "Rui Costa <rui@small-firm.example>", Subject: "Re: Invoice", Body: "Attached the corrected invoice.",
		Headers: fmt.Sprintf(arFail, "small-firm.example"), Date: base.Add(time.Minute)})
	deliver("INBOX", fakemail.Msg{From: "Hacker Newsletter <kale@hackernewsletter.com>", Subject: "Hacker Newsletter #712",
		Body:    strings.Repeat("This week: local-first software and SQLite in production. ", 8),
		Headers: fmt.Sprintf(arPass, "hackernewsletter.com") + "List-Unsubscribe: <https://hackernewsletter.com/u>\r\n", Date: base.Add(2 * time.Minute)})
	deliver("INBOX", fakemail.Msg{From: "PayPal Security <service@paypal-review.secure-login.top>", Subject: "Your account has been limited",
		ReplyTo: "paypal.help.team@gmail.com", Body: "Restore access: https://bit.ly/3abc",
		Headers: fmt.Sprintf(arFail, "secure-login.top"), Date: base.Add(3 * time.Minute)})
	deliver("INBOX", fakemail.Msg{From: "Prize Desk <desk@promo.example>", Subject: "Claim your prize",
		Body: "You have won.", Headers: "X-Spam-Flag: YES\r\nX-Spam-Status: Yes, score=12.0 required=5.0\r\n", Date: base.Add(4 * time.Minute)})

	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("inbox bodies", func() bool { return h.allBodies("inbox") })
	h.waitFor("junk hidden", func() bool {
		c, _ := h.st.UnifiedCounts(ctx)
		return c.Junk == 2 && c.Inbox == 2
	})

	inbox := store.Query{View: "inbox"}
	for _, s := range []string{"Re: Invoice", "Hacker Newsletter #712"} {
		if _, ok := h.bySubject(inbox, s); !ok {
			t.Errorf("%q is missing from the inbox", s)
		}
	}
	only := store.Query{View: "inbox", Junk: "only"}
	pp, ok := h.bySubject(only, "Your account has been limited")
	if !ok || !pp.Junk || pp.JunkScore < 50 || !strings.Contains(pp.JunkWhy, "dmarc-fail") {
		t.Fatalf("phish not flagged: %+v", pp)
	}
	if _, ok := h.bySubject(only, "Claim your prize"); !ok {
		t.Fatal("provider-flagged mail not hidden")
	}
	// Nothing moved on the server: both are still in INBOX there.
	if n := len(h.list("junk")); n != 0 {
		t.Fatalf("the filter moved %d messages to Junk", n)
	}

	// Not spam: back in the inbox, the sender vouched for, learned as ham.
	if err := h.e.Apply(ctx, []int64{pp.ID}, ActNotJunk, 0); err != nil {
		t.Fatal(err)
	}
	if m, ok := h.bySubject(inbox, "Your account has been limited"); !ok || m.Junk {
		t.Fatalf("not-junk message not back in the inbox: %+v %v", m, ok)
	}
	if k, _ := h.st.KnownSender(ctx, "SERVICE@paypal-review.secure-login.top"); !k {
		t.Fatal("sender not vouched for")
	}
	if _, nHam := h.st.JunkTotals(ctx); nHam == 0 {
		t.Fatal("Not spam was not learned")
	}

	// Spam on the newsletter: learned, moved to Junk (by the user's action).
	nl, _ := h.bySubject(inbox, "Hacker Newsletter #712")
	nSpam0, _ := h.st.JunkTotals(ctx)
	if err := h.e.Apply(ctx, []int64{nl.ID}, ActSpam, 0); err != nil {
		t.Fatal(err)
	}
	if nSpam, _ := h.st.JunkTotals(ctx); nSpam != nSpam0+1 {
		t.Fatalf("Spam not learned: %d → %d", nSpam0, nSpam)
	}
}

// Mail stored before the filter existed has its header read again and is
// judged, in steps; the Junk and Sent folders teach the classifier, which
// then judges the inbox again.
func TestJunkBackfillAndLearning(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	base := time.Now().Add(-2 * time.Hour)
	old := JunkHeaderStep
	JunkHeaderStep = 2
	t.Cleanup(func() { JunkHeaderStep = old })
	for i := 0; i < 3; i++ {
		_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "Deals <x@deals.example>", To: "me@fake.test", Subject: fmt.Sprintf("Offer %d", i),
			Body: "cheap", Headers: "X-Spam-Flag: YES\r\n", Date: base.Add(time.Duration(i) * time.Minute)}.Raw())
	}
	for i := 0; i < spam.MinTrained+2; i++ {
		_ = h.srv.Deliver("Junk", fakemail.Msg{From: "Casino <win@casino.example>", To: "me@fake.test", Subject: fmt.Sprintf("Bonus %d", i),
			Body: "casino bonus jackpot spins free credits", Date: base, MessageID: fmt.Sprintf("bonus%d@casino.example", i)}.Raw())
		_ = h.srv.Deliver("Sent", fakemail.Msg{From: "me@fake.test", To: fmt.Sprintf("friend%d@example.org", i), Subject: fmt.Sprintf("Lunch %d", i),
			Body: "lunch tomorrow at the usual place, agenda attached", Date: base, MessageID: fmt.Sprintf("lunch%d@fake.test", i)}.Raw())
	}
	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("first judgement", func() bool {
		c, _ := h.st.UnifiedCounts(ctx)
		return c.Junk == 3
	})
	h.waitFor("classifier trained", func() bool {
		s, hm := h.st.JunkTotals(ctx)
		return s >= spam.MinTrained && hm >= spam.MinTrained
	})

	// Pretend these rows predate the filter: no header facts, no verdict.
	ms, _ := h.st.List(ctx, store.Query{View: "inbox", Junk: "include"})
	for _, m := range ms {
		_ = h.st.SetJunkHeader(ctx, m.ID, "")
		_ = h.st.SetJunk(ctx, m.ID, false, 0, "")
	}
	h.e.SyncNow(0)
	h.waitFor("one step of the backfill", func() bool {
		c, _ := h.st.UnifiedCounts(ctx)
		return c.Junk >= 2
	})
	h.e.SyncNow(0)
	h.waitFor("the whole backfill", func() bool {
		c, _ := h.st.UnifiedCounts(ctx)
		return c.Junk == 3
	})

	// A casino mail in the inbox is now junk on what was learned alone.
	_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "Lucky <lucky@another.example>", To: "me@fake.test", Subject: "casino bonus",
		Body: "casino bonus jackpot spins free credits", Date: time.Now()}.Raw())
	h.e.SyncNow(0)
	h.waitFor("learned verdict", func() bool {
		m, ok := h.bySubject(store.Query{View: "inbox", Junk: "only"}, "casino bonus")
		return ok && strings.Contains(m.JunkWhy, "learned")
	})
}
