package spam

import (
	"math"
	"sort"
	"strings"
	"unicode"
)

// The classifier is Robinson's naive Bayes with Fisher's chi-square combining
// (the SpamBayes design): each token's spam probability is smoothed towards
// 0.5 by how rarely it was seen, the most telling tokens are combined, and
// the answer stays near 0.5 when the evidence points both ways.

// Counts is how many spam and ham messages a token appeared in.
type Counts struct{ Spam, Ham int }

// Learning limits.
const (
	// MinTrained is how many messages of each kind the classifier must have
	// seen before its opinion counts at all.
	MinTrained = 10
	// MaxTokens per message: the first ones (subject, sender, then the body)
	// are kept.
	MaxTokens = 400
	// interesting is how many of the most telling tokens are combined.
	interesting = 150
	minWord     = 3
	maxWord     = 24
	bodyScan    = 20 << 10 // tokens come from the first 20 KB of text
)

// Tokens turns a message into the set of features the classifier counts:
// words of the subject and body, the sender's name words and domain, link
// hosts, and the header facts (an auth failure is a feature too). Each
// appears once: the classifier counts messages, not repetitions.
func Tokens(h Header, b Body) []string {
	seen := map[string]bool{}
	var out []string
	add := func(t string) {
		if len(out) >= MaxTokens || seen[t] {
			return
		}
		seen[t] = true
		out = append(out, t)
	}
	words := func(prefix, s string) {
		for _, w := range splitWords(s) {
			add(prefix + w)
		}
	}
	words("s:", h.Subject)
	words("n:", h.FromName)
	if d := domainOf(h.FromAddr); d != "" {
		add("d:" + d)
		add("d:" + registrable(d))
	}
	if d := domainOf(h.ReplyTo); d != "" {
		add("r:" + registrable(d))
	}
	if h.AuthSeen {
		add("h:spf=" + orNone(h.SPF))
		add("h:dkim=" + orNone(h.DKIM))
		add("h:dmarc=" + orNone(h.DMARC))
	}
	if h.ProviderSpam {
		add("h:provider-spam")
	}
	if h.ListUnsubscribe {
		add("h:list")
	}
	f := readBody(b)
	for _, host := range f.hosts {
		add("u:" + registrable(host))
	}
	if f.images > 0 && f.textLen < 120 {
		add("h:image-only")
	}
	text := b.Text
	if len(text) > bodyScan {
		text = text[:bodyScan]
	}
	text = reURL.ReplaceAllString(text, " ")
	words("", text)
	return out
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// splitWords lower-cases and splits on anything that is not a letter, digit,
// apostrophe or currency sign; words of 3 to 24 runes are kept and pure
// numbers longer than four digits are dropped (dates, order numbers).
func splitWords(s string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' && r != '$' && r != '€' && r != '£'
	}) {
		w = strings.Trim(w, "'")
		n := len([]rune(w))
		if n < minWord || n > maxWord {
			continue
		}
		if n > 4 && strings.IndexFunc(w, func(r rune) bool { return !unicode.IsDigit(r) }) < 0 {
			continue
		}
		out = append(out, w)
	}
	return out
}

// Probability is the classifier's spam probability for a message's tokens,
// given each token's counts and the number of spam and ham messages learned.
// ok is false while either side has fewer than MinTrained messages.
func Probability(tokens []string, counts map[string]Counts, nSpam, nHam int) (p float64, ok bool) {
	if nSpam < MinTrained || nHam < MinTrained {
		return 0.5, false
	}
	const s, x = 1.0, 0.5 // Robinson's strength and prior
	var fs []float64
	for _, t := range tokens {
		c, found := counts[t]
		if !found || c.Spam+c.Ham == 0 {
			continue
		}
		ps := math.Min(1, float64(c.Spam)/float64(nSpam))
		ph := math.Min(1, float64(c.Ham)/float64(nHam))
		if ps+ph == 0 {
			continue
		}
		pw := ps / (ps + ph)
		n := float64(c.Spam + c.Ham)
		f := (s*x + n*pw) / (s + n)
		if math.Abs(f-0.5) < 0.1 {
			continue
		}
		fs = append(fs, f)
	}
	if len(fs) == 0 {
		return 0.5, true
	}
	sort.Slice(fs, func(i, j int) bool { return math.Abs(fs[i]-0.5) > math.Abs(fs[j]-0.5) })
	if len(fs) > interesting {
		fs = fs[:interesting]
	}
	var lnS, lnH float64
	for _, f := range fs {
		f = math.Max(0.0001, math.Min(0.9999, f))
		lnS += math.Log(1 - f)
		lnH += math.Log(f)
	}
	n := len(fs)
	spamness := 1 - chi2Q(-2*lnS, 2*n) // near 1 when the tokens look spammy
	hamness := 1 - chi2Q(-2*lnH, 2*n)  // near 1 when they look like ham
	return (1 + spamness - hamness) / 2, true
}

// Judge is the whole verdict: the rules, the classifier on tokens (as
// returned by Tokens, with their counts), and what is known of the sender.
func Judge(h Header, b Body, tokens []string, counts map[string]Counts, nSpam, nHam int, c Context) Verdict {
	pts, hits := Rules(h, b)
	p, ready := Probability(tokens, counts, nSpam, nHam)
	return Decide(pts, hits, p, ready, c)
}

// chi2Q is the probability that a chi-square variable with v (even) degrees
// of freedom is at least x2.
func chi2Q(x2 float64, v int) float64 {
	m := x2 / 2
	sum := math.Exp(-m)
	term := sum
	for i := 1; i < v/2; i++ {
		term *= m / float64(i)
		sum += term
	}
	return math.Min(sum, 1)
}
