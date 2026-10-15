package spam

import (
	"fmt"
	"strings"
	"testing"
)

// Header fixtures shaped like what real receiving servers write: the
// topmost Authentication-Results is the server's own.
const (
	spfFail = "Return-Path: <bounce@mailer-77.top>\r\n" +
		"Authentication-Results: mx.spacemail.com; spf=fail smtp.mailfrom=mailer-77.top; dkim=none; dmarc=none\r\n" +
		"From: Shipping Notice <notice@mailer-77.top>\r\n" +
		"To: me@example.org\r\n" +
		"Subject: Your parcel is waiting\r\n" +
		"Message-ID: <a1@mailer-77.top>\r\n" +
		"Date: Tue, 13 Oct 2026 08:00:00 +0000\r\n"

	dmarcFail = "Authentication-Results: mx.spacemail.com; spf=softfail smtp.mailfrom=bulk.example.net; dkim=fail header.d=example.net; dmarc=fail (p=reject) header.from=bank.example\r\n" +
		"From: Account Team <alerts@bank.example>\r\n" +
		"Subject: Verify your account\r\n" +
		"Message-ID: <a2@bulk.example.net>\r\n"

	providerFlag = "X-Spam-Flag: YES\r\n" +
		"X-Spam-Status: Yes, score=11.2 required=5.0 tests=BAYES_99,URIBL_BLACK\r\n" +
		"Authentication-Results: mx.example.org; spf=pass smtp.mailfrom=promo.example; dkim=pass header.d=promo.example\r\n" +
		"From: Winner Desk <desk@promo.example>\r\n" +
		"Subject: Claim your prize today\r\n" +
		"Message-ID: <a3@promo.example>\r\n"

	rspamd = "X-Spamd-Result: default: True [16.40 / 15.00]; BAYES_SPAM(5.1)\r\n" +
		"X-Rspamd-Action: add header\r\n" +
		"From: Deals <x@deals.example>\r\n" +
		"Subject: hi\r\n" +
		"Message-ID: <a4@deals.example>\r\n"

	brand = "Authentication-Results: mx.spacemail.com; spf=pass smtp.mailfrom=secure-login.top; dkim=none; dmarc=none\r\n" +
		"From: PayPal Security <service@paypal-account-review.secure-login.top>\r\n" +
		"Reply-To: paypal.helpdesk.team@gmail.com\r\n" +
		"Subject: Your account has been limited\r\n" +
		"Message-ID: <a5@secure-login.top>\r\n"

	newsletter = "Authentication-Results: mx.spacemail.com; dkim=pass header.d=hackernewsletter.com header.s=k1; spf=pass smtp.mailfrom=bounce.hackernewsletter.com; dmarc=pass (p=none) header.from=hackernewsletter.com\r\n" +
		"From: Hacker Newsletter <kale@hackernewsletter.com>\r\n" +
		"Reply-To: kale@hackernewsletter.com\r\n" +
		"Subject: Hacker Newsletter #712\r\n" +
		"List-Unsubscribe: <https://hackernewsletter.com/unsubscribe/abc>\r\n" +
		"Precedence: bulk\r\n" +
		"Message-ID: <hn712@hackernewsletter.com>\r\n"

	// A colleague whose company's DNS is misconfigured: SPF and DMARC fail.
	colleague = "Authentication-Results: mx.spacemail.com; spf=fail smtp.mailfrom=small-firm.example; dkim=none; dmarc=fail header.from=small-firm.example\r\n" +
		"From: Rui Costa <rui@small-firm.example>\r\n" +
		"Subject: Re: invoice for September\r\n" +
		"In-Reply-To: <inv@example.org>\r\n" +
		"Message-ID: <r1@small-firm.example>\r\n"
)

func judge(raw string, b Body, c Context) Verdict {
	h := ParseHeader([]byte(raw))
	return Judge(h, b, nil, nil, 0, 0, c)
}

func codes(v Verdict) string {
	var s []string
	for _, h := range v.Hits {
		s = append(s, fmt.Sprintf("%s(%+.1f)", h.Code, h.Points))
	}
	return strings.Join(s, " ")
}

func TestParseHeader(t *testing.T) {
	h := ParseHeader([]byte(dmarcFail))
	if h.SPF != "softfail" || h.DKIM != "fail" || h.DMARC != "fail" || !h.AuthSeen {
		t.Fatalf("auth: %+v", h)
	}
	h = ParseHeader([]byte(providerFlag))
	if !h.ProviderSpam || h.ProviderScore != 11.2 || h.ProviderLimit != 5 {
		t.Fatalf("provider: %+v", h)
	}
	h = ParseHeader([]byte(rspamd))
	if !h.ProviderSpam || h.ProviderScore != 16.4 {
		t.Fatalf("rspamd: %+v", h)
	}
	h = ParseHeader([]byte(newsletter))
	if !h.ListUnsubscribe || !h.Bulk || h.DKIM != "pass" || h.DMARC != "pass" {
		t.Fatalf("newsletter: %+v", h)
	}
}

// The receiving server writes its Authentication-Results on top; one further
// down came with the message and is the sender's word, not the server's.
func TestOnlyTheTopmostAuthResultsCounts(t *testing.T) {
	raw := "Authentication-Results: mx.real.example; spf=fail smtp.mailfrom=x.top; dkim=none; dmarc=fail\r\n" +
		"Authentication-Results: forged.example; spf=pass; dkim=pass; dmarc=pass\r\n" +
		"From: a@x.top\r\nSubject: s\r\nMessage-ID: <1@x.top>\r\n"
	h := ParseHeader([]byte(raw))
	if h.SPF != "fail" || h.DMARC != "fail" {
		t.Fatalf("read the forged header: %+v", h)
	}
}

// A sender writing "X-Spam-Flag: NO" into its own mail proves nothing.
func TestAProviderNoDoesNotHelp(t *testing.T) {
	a := judge("X-Spam-Flag: NO\r\nX-Spam-Status: No, score=-50\r\n"+brand, Body{}, Context{})
	b := judge(brand, Body{}, Context{})
	if a.Total < b.Total-0.01 {
		t.Fatalf("a forged NO lowered the score: %v vs %v", a.Total, b.Total)
	}
}

func TestJunkFixtures(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		body Body
		junk bool
		c    Context
	}{
		{"spf fail + cheap tld + no auth", spfFail, Body{Text: "Click to schedule delivery: https://bit.ly/3xYz"}, true, Context{}},
		{"dmarc fail", dmarcFail, Body{Text: "Your account will be closed unless you confirm your details."}, true, Context{}},
		{"provider flag", providerFlag, Body{Text: "You won!"}, true, Context{}},
		{"rspamd action", rspamd, Body{Text: "hello"}, true, Context{}},
		{"brand spoof", brand, Body{HTML: `<p>Dear customer, <a href="https://paypal-account-review.secure-login.top/x">paypal.com/resolve</a></p>`}, true, Context{}},
		{"legit newsletter", newsletter, Body{Text: strings.Repeat("This week: local-first software, SQLite in production. ", 10) + "https://news.ycombinator.com/item?id=1",
			HTML: `<h1>Hacker Newsletter</h1><p>` + strings.Repeat("Local-first software and SQLite in production. ", 10) + `</p><a href="https://click.hackernewsletter.com/x">news.ycombinator.com</a><img src="https://hackernewsletter.com/logo.png">`}, false, Context{}},
		{"known correspondent with failing checks", colleague, Body{Text: "Attached the corrected invoice."}, false, Context{Known: true}},
		{"provider spam from someone you wrote to", providerFlag, Body{}, false, Context{Known: true}},
		{"spam you replied to", spfFail, Body{}, false, Context{Answered: true}},
	}
	for _, tc := range cases {
		v := judge(tc.raw, tc.body, tc.c)
		if v.Junk != tc.junk {
			t.Errorf("%s: junk=%v want %v, total %.1f: %s", tc.name, v.Junk, tc.junk, v.Total, codes(v))
		}
		if v.Junk && v.Score < 50 || !v.Junk && v.Score >= 50 {
			t.Errorf("%s: score %d disagrees with junk=%v", tc.name, v.Score, v.Junk)
		}
	}
}

// The colleague alone, unknown, does get flagged: the safeguard is what saves it.
func TestColleagueIsJunkWithoutTheSafeguard(t *testing.T) {
	v := judge(colleague, Body{Text: "Attached the corrected invoice."}, Context{})
	if !v.Junk {
		t.Fatalf("expected junk without context, total %.1f: %s", v.Total, codes(v))
	}
}

func TestBrandSpoof(t *testing.T) {
	cases := map[[2]string]string{
		{"PayPal", "paypal.com"}:                 "",
		{"PayPal Deutschland", "paypal.de"}:      "",
		{"Apple", "icloud.com"}:                  "",
		{"Amazon.co.uk", "amazon.co.uk"}:         "",
		{"PayPal Service", "secure.top"}:         "brand-spoof",
		{"Google groups digest", "x.com"}:        "brand-spoof",
		{"Mailing groups", "x.com"}:              "", // "ups" inside a word does not count
		{"Apple Support", "apple-id-verify.top"}: "brand-spoof",
		{"support@apple.com", "evil.top"}:        "name-has-other-address",
		{"maya@northwind.io", "northwind.io"}:    "",
	}
	for in, want := range cases {
		if got := brandSpoof(in[0], registrable(in[1])); got != want {
			t.Errorf("%q from %s: %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestBodyFacts(t *testing.T) {
	f := readBody(Body{HTML: `<a href="https://x.top/a"><img src="cid:1"></a>`})
	if f.images != 1 || f.textLen > 5 || f.links != 1 {
		t.Fatalf("image-only: %+v", f)
	}
	f = readBody(Body{HTML: `<a href="https://login.evil.top/">www.paypal.com</a>`})
	if !f.deceptive {
		t.Fatalf("deceptive link missed: %+v", f)
	}
	f = readBody(Body{HTML: `<a href="https://click.mailer.example/t/1">northwind.io</a>`})
	if f.deceptive {
		t.Fatal("a newsletter's tracked link to its own site is not deceptive")
	}
	f = readBody(Body{Text: "go to https://tinyurl.com/abc now"})
	if !f.shortener {
		t.Fatal("shortener missed")
	}
}

func TestTokens(t *testing.T) {
	h := ParseHeader([]byte(brand))
	toks := Tokens(h, Body{Text: "Dear customer, verify 1234567 now now now"})
	has := map[string]bool{}
	for _, x := range toks {
		if has[x] {
			t.Fatalf("duplicate token %q", x)
		}
		has[x] = true
	}
	for _, want := range []string{"s:account", "s:limited", "n:paypal", "d:secure-login.top", "r:gmail.com", "h:spf=pass", "h:dkim=none", "customer", "verify", "now"} {
		if !has[want] {
			t.Errorf("missing %q in %v", want, toks)
		}
	}
	if has["1234567"] {
		t.Error("long numbers are dropped")
	}
}

func TestBayesLearns(t *testing.T) {
	counts := map[string]Counts{}
	nSpam, nHam := 0, 0
	train := func(text string, spam bool) {
		for _, tok := range Tokens(Header{}, Body{Text: text}) {
			c := counts[tok]
			if spam {
				c.Spam++
			} else {
				c.Ham++
			}
			counts[tok] = c
		}
		if spam {
			nSpam++
		} else {
			nHam++
		}
	}
	for i := 0; i < 20; i++ {
		train(fmt.Sprintf("cheap pills discount viagra casino bonus offer %d", i), true)
		train(fmt.Sprintf("meeting notes for the quarterly budget review agenda %d", i), false)
	}
	if _, ok := Probability(nil, counts, 5, 50); ok {
		t.Fatal("ready with too few spam examples")
	}
	ps, ok := Probability(Tokens(Header{}, Body{Text: "casino bonus discount pills"}), counts, nSpam, nHam)
	if !ok || ps < 0.9 {
		t.Fatalf("spam text: %.3f ok=%v", ps, ok)
	}
	ph, _ := Probability(Tokens(Header{}, Body{Text: "agenda for the budget meeting"}), counts, nSpam, nHam)
	if ph > 0.1 {
		t.Fatalf("ham text: %.3f", ph)
	}
	pu, _ := Probability(Tokens(Header{}, Body{Text: "completely unrelated words here"}), counts, nSpam, nHam)
	if pu != 0.5 {
		t.Fatalf("unknown words: %.3f", pu)
	}
	// Learned spamminess alone is enough when confident.
	v := Decide(0, nil, ps, true, Context{})
	if !v.Junk {
		t.Fatalf("confident classifier did not decide: %+v", v)
	}
	if v.Why() != "learned" {
		t.Fatalf("why: %q", v.Why())
	}
}

func TestWhyOrdersStrongestFirst(t *testing.T) {
	v := Verdict{Hits: []Hit{{"a", 1}, {"b", 3}, {"c", -1}, {"d", 2}}}
	if got := v.Why(); got != "b,d,a" {
		t.Fatalf("why: %q", got)
	}
}
