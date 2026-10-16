package spam

import (
	"math"
	"strings"
	"unicode"
)

// Threshold is the number of points at which a message is junk. Every rule
// below adds or takes points; the classifier adds at most MaxBayes.
const Threshold = 5.0

// Bayes contributes (p - 0.5) * BayesScale points, clamped to
// [-MaxBayesHam, MaxBayes]: a confident classifier (p ≥ 0.96) is enough on
// its own, an unsure one only tips a close call.
const (
	BayesScale  = 11.0
	MaxBayes    = 5.0
	MaxBayesHam = 4.0
)

// Hit is one rule that fired: a short code (stable, for the UI and tests)
// and its points.
type Hit struct {
	Code   string  `json:"code"`
	Points float64 `json:"points"`
}

// Rules scores a message from its header and body. Positive is spammy.
func Rules(h Header, b Body) (float64, []Hit) {
	var hits []Hit
	add := func(code string, pts float64) { hits = append(hits, Hit{code, pts}) }

	// The receiving server's own filter. It sees thousands of mailboxes and
	// its verdict is the strongest single signal there is.
	switch {
	case h.ProviderSpam:
		add("provider-spam", 6)
	case h.HasScore && h.ProviderLimit > 0 && h.ProviderScore >= h.ProviderLimit:
		add("provider-score", 5)
	case h.HasScore && h.ProviderLimit == 0 && h.ProviderScore >= 5:
		add("provider-score", 4)
	case h.HasScore && h.ProviderScore >= 3:
		add("provider-score-high", 1.5)
	}

	// Authentication: did the sending domain vouch for this message?
	if h.AuthSeen {
		switch h.DMARC {
		case "fail":
			add("dmarc-fail", 3.5)
		case "pass":
			add("dmarc-pass", -1)
		}
		switch h.SPF {
		case "fail":
			add("spf-fail", 2.5)
		case "softfail":
			add("spf-softfail", 1)
		}
		if h.DKIM == "fail" {
			add("dkim-fail", 1.5)
		}
		if h.SPF == "pass" && h.DKIM == "pass" {
			add("authenticated", -1.5)
		}
		if (h.SPF == "" || h.SPF == "none") && (h.DKIM == "" || h.DKIM == "none") && h.DMARC != "pass" {
			add("unauthenticated", 1.5)
		}
	}

	fromDom := domainOf(h.FromAddr)
	fromReg := registrable(fromDom)
	if code := brandSpoof(h.FromName, fromReg); code != "" {
		add(code, 4)
	}
	if fromDom != "" && cheapTLDs[tldOf(fromDom)] {
		add("cheap-tld", 1.5)
	}
	if rt := domainOf(h.ReplyTo); rt != "" && fromReg != "" && registrable(rt) != fromReg {
		if freemail[rt] && !freemail[fromDom] {
			add("reply-to-freemail", 2)
		} else {
			add("reply-to-elsewhere", 0.5)
		}
	}

	subj := strings.TrimSpace(h.Subject)
	low := strings.ToLower(subj)
	if (strings.HasPrefix(low, "re:") || strings.HasPrefix(low, "fwd:")) && !h.InReplyTo {
		add("fake-reply", 1.5)
	}
	if shouting(subj) {
		add("subject-caps", 1)
	}
	if strings.Contains(subj, "!!!") || strings.Contains(subj, "$$$") || strings.Contains(subj, "€€€") {
		add("subject-punct", 1)
	}
	if h.NoMessageID {
		add("no-message-id", 1)
	}
	// A list that says how to leave it and signs its mail is a newsletter
	// doing things properly.
	if h.ListUnsubscribe && h.DKIM == "pass" {
		add("proper-list", -1)
	}

	f := readBody(b)
	if f.hasContent {
		if f.shortener {
			add("url-shortener", 1.5)
		}
		if f.deceptive {
			add("deceptive-link", 2.5)
		}
		if f.images > 0 && f.textLen < 120 {
			add("image-only", 2)
		} else if f.links > 0 && f.textLen < 60 {
			add("link-only", 1.5)
		}
	}

	// Authentication says who sent a message, not whether it is wanted: once
	// the server's own filter called it spam, a signed, properly listed
	// mailing earns no credit back.
	if h.ProviderSpam {
		kept := hits[:0]
		for _, x := range hits {
			if x.Points > 0 {
				kept = append(kept, x)
			}
		}
		hits = kept
	}
	total := 0.0
	for _, x := range hits {
		total += x.Points
	}
	return total, hits
}

// brandSpoof: the display name names a brand (or carries another address)
// while the mail comes from an unrelated domain.
func brandSpoof(name, fromReg string) string {
	if name == "" || fromReg == "" {
		return ""
	}
	n := strings.ToLower(name)
	// "PayPal <service@paypal.com.secure-login.top>" and "support@apple.com
	// <x@y.top>" both put a trusted address where the eye reads.
	if i := strings.IndexByte(n, '@'); i > 0 {
		shown := strings.Trim(n[i+1:], " \"'<>()[],;")
		if j := strings.IndexAny(shown, " \"'<>()[],;"); j > 0 {
			shown = shown[:j]
		}
		if strings.Contains(shown, ".") && registrable(shown) != fromReg {
			return "name-has-other-address"
		}
	}
	for _, brand := range brandNames {
		legit := brands[brand]
		if !containsWord(n, brand) {
			continue
		}
		key := strings.ReplaceAll(brand, " ", "")
		// The brand's own name as the domain: paypal.de, amazon.co.uk. Not
		// merely inside it: apple-id-verify.top is not Apple.
		if label, _, _ := strings.Cut(fromReg, "."); label == key {
			return ""
		}
		for _, d := range legit {
			if fromReg == registrable(d) {
				return ""
			}
		}
		return "brand-spoof"
	}
	return ""
}

// containsWord: needle appears in s with no letter on either side, so "ups"
// does not match "groups" and "chase" does not match "purchase".
func containsWord(s, needle string) bool {
	for start := 0; ; {
		i := strings.Index(s[start:], needle)
		if i < 0 {
			return false
		}
		i += start
		end := i + len(needle)
		before := i == 0 || !isLetter(s[i-1])
		after := end == len(s) || !isLetter(s[end])
		if before && after {
			return true
		}
		start = i + 1
	}
}

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' }

// shouting: a subject of at least a dozen letters, mostly capitals.
func shouting(s string) bool {
	letters, upper := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	return letters >= 12 && float64(upper)/float64(letters) > 0.7
}

// Context is what the engine knows about the sender beyond the message.
type Context struct {
	// Known: the user wrote to this address, said "Not spam" for it, the
	// conversation includes the user's own reply, or it is the user's own
	// address. A known sender is never junk.
	Known bool
	// Answered or Flagged by the user: the user dealt with it as real mail.
	Answered, Flagged bool
}

// Verdict is the filter's answer for one message.
type Verdict struct {
	Junk  bool    `json:"junk"`
	Score int     `json:"score"` // 0–100; 50 is the threshold
	Hits  []Hit   `json:"hits"`
	Total float64 `json:"total"`
}

// Decide combines the rules with the classifier. bayes is the classifier's
// spam probability and ready says whether it has learned enough to be asked.
func Decide(rulePts float64, hits []Hit, bayes float64, ready bool, c Context) Verdict {
	total := rulePts
	if ready {
		b := (bayes - 0.5) * BayesScale
		b = math.Max(-MaxBayesHam, math.Min(MaxBayes, b))
		b = math.Round(b*10) / 10
		if b != 0 {
			hits = append(hits, Hit{"learned", b})
			total += b
		}
	}
	v := Verdict{Total: total, Hits: hits}
	v.Score = int(math.Round(100 / (1 + math.Exp(-(total-Threshold)/1.5))))
	v.Junk = total >= Threshold
	if c.Known || c.Answered || c.Flagged {
		v.Junk = false
		code := "known-sender"
		if !c.Known {
			code = "you-replied-or-starred"
		}
		v.Hits = append(v.Hits, Hit{code, 0})
		if v.Score > 49 {
			v.Score = 49
		}
	}
	return v
}

// Why is the comma-separated codes of the hits that pushed towards junk,
// strongest first, for the junk_why column.
func (v Verdict) Why() string {
	var pos []Hit
	for _, h := range v.Hits {
		if h.Points > 0 {
			pos = append(pos, h)
		}
	}
	for i := 1; i < len(pos); i++ {
		for j := i; j > 0 && pos[j].Points > pos[j-1].Points; j-- {
			pos[j], pos[j-1] = pos[j-1], pos[j]
		}
	}
	codes := make([]string, len(pos))
	for i, h := range pos {
		codes[i] = h.Code
	}
	return strings.Join(codes, ",")
}
