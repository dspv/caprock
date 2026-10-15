// Package spam is Caprock Mail's local junk filter: no AI, no network, no
// account anywhere. It reads what the receiving server already wrote into a
// message's header (SPF, DKIM, DMARC and its own spam verdict), a handful of
// cheap rules about the sender and the body, and a small naive-Bayes
// classifier that learns from the user's own Junk folder and from every
// Spam / Not spam the user presses. The verdict only hides a message from
// the inbox; nothing is moved or deleted on the server by it.
//
// The package is pure: it parses, scores and tokenizes. The token counts and
// the verdicts live in mail.db (internal/mail/mailstore), and the engine
// (internal/mail/engine) runs it at sync time.
package spam

import (
	"bufio"
	"bytes"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/emersion/go-message"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-message/textproto"
)

// Header is what the filter keeps from a message's header. It is stored as
// JSON beside the message, so a verdict can be computed again (when the
// classifier has learned more) without asking the server for the header.
type Header struct {
	// Auth results from the receiving server's Authentication-Results:
	// "pass", "fail", "softfail", "neutral", "none", "temperror",
	// "permerror", or "" when the header does not say.
	SPF   string `json:"spf,omitempty"`
	DKIM  string `json:"dkim,omitempty"`
	DMARC string `json:"dmarc,omitempty"`
	// AuthSeen: the server wrote an Authentication-Results at all. Without
	// one, missing results say nothing.
	AuthSeen bool `json:"auth,omitempty"`

	// ProviderSpam: the receiving server's own filter said spam
	// (X-Spam-Flag: YES, X-Spam-Status: Yes, an rspamd action, SCL ≥ 5,
	// a [SPAM] subject tag).
	ProviderSpam bool `json:"pspam,omitempty"`
	// ProviderScore is its numeric score when it gave one, and
	// ProviderLimit the threshold it uses (0 when unknown).
	ProviderScore float64 `json:"pscore,omitempty"`
	ProviderLimit float64 `json:"plimit,omitempty"`
	HasScore      bool    `json:"hscore,omitempty"`

	Bulk            bool   `json:"bulk,omitempty"`  // Precedence: bulk/list/junk
	ListUnsubscribe bool   `json:"unsub,omitempty"` // List-Unsubscribe present
	InReplyTo       bool   `json:"irt,omitempty"`   // In-Reply-To or References present
	NoMessageID     bool   `json:"nomid,omitempty"`
	FromName        string `json:"fname,omitempty"`
	FromAddr        string `json:"faddr,omitempty"`
	ReplyTo         string `json:"rto,omitempty"`
	Subject         string `json:"subj,omitempty"`
}

var (
	reSPF   = regexp.MustCompile(`(?i)\bspf\s*=\s*([a-z]+)`)
	reDKIM  = regexp.MustCompile(`(?i)\bdkim\s*=\s*([a-z]+)`)
	reDMARC = regexp.MustCompile(`(?i)\bdmarc\s*=\s*([a-z]+)`)
	reScore = regexp.MustCompile(`(?i)\bscore\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)`)
	reReq   = regexp.MustCompile(`(?i)\brequired\s*=\s*(-?[0-9]+(?:\.[0-9]+)?)`)
	reSCL   = regexp.MustCompile(`(?i)\bSCL\s*:\s*(-?[0-9])`)
	// rspamd: "default: True [12.30 / 15.00]"
	reSpamd   = regexp.MustCompile(`(?i)default:\s*(true|false)\s*\[\s*(-?[0-9.]+)\s*/\s*(-?[0-9.]+)`)
	reSubjTag = regexp.MustCompile(`(?i)^\s*(\[spam\]|\*{2,}\s*spam\s*\*{2,}|\{spam\??\}|spam:)`)
)

// ParseHeader reads the filter's facts from a raw RFC 5322 header.
func ParseHeader(raw []byte) Header {
	var h Header
	th, err := textproto.ReadHeader(bufio.NewReader(io.MultiReader(bytes.NewReader(raw), strings.NewReader("\r\n\r\n"))))
	if err != nil && th.Len() == 0 {
		return h
	}
	mh := mail.Header{Header: message.Header{Header: th}}
	if s, err := mh.Subject(); err == nil {
		h.Subject = s
	} else {
		h.Subject = mh.Get("Subject")
	}
	if from, err := mh.AddressList("From"); err == nil && len(from) > 0 {
		h.FromName, h.FromAddr = from[0].Name, from[0].Address
	}
	if rt, err := mh.AddressList("Reply-To"); err == nil && len(rt) > 0 {
		h.ReplyTo = rt[0].Address
	}
	h.InReplyTo = mh.Get("In-Reply-To") != "" || mh.Get("References") != ""
	h.NoMessageID = strings.TrimSpace(mh.Get("Message-Id")) == ""
	switch strings.ToLower(strings.TrimSpace(mh.Get("Precedence"))) {
	case "bulk", "list", "junk":
		h.Bulk = true
	}
	h.ListUnsubscribe = mh.Get("List-Unsubscribe") != ""

	// The topmost Authentication-Results is the one the receiving server
	// added; lower ones came with the message and may be forged. ARC's copy
	// stands in when the server wrote none.
	ar := topmost(&th, "Authentication-Results")
	if ar == "" {
		ar = topmost(&th, "ARC-Authentication-Results")
	}
	if ar != "" {
		h.AuthSeen = true
		h.SPF = firstResult(reSPF, ar)
		h.DKIM = bestDKIM(ar)
		h.DMARC = firstResult(reDMARC, ar)
	}
	if h.SPF == "" {
		if rs := topmost(&th, "Received-SPF"); rs != "" {
			h.AuthSeen = true
			if f := strings.Fields(strings.ToLower(rs)); len(f) > 0 {
				h.SPF = f[0]
			}
		}
	}
	providerVerdict(&th, &h)
	if reSubjTag.MatchString(h.Subject) {
		h.ProviderSpam = true
	}
	return h
}

// topmost is the first field with this key, top of the header first.
func topmost(th *textproto.Header, key string) string {
	f := th.FieldsByKey(key)
	if f.Next() {
		return f.Value()
	}
	return ""
}

func firstResult(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}

// bestDKIM: a message often carries several signatures (the sender's and its
// mailing service's); one that passes is enough.
func bestDKIM(s string) string {
	best := ""
	for _, m := range reDKIM.FindAllStringSubmatch(s, -1) {
		r := strings.ToLower(m[1])
		if r == "pass" {
			return r
		}
		if best == "" || best == "none" {
			best = r
		}
	}
	return best
}

func yes(v string) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	return strings.HasPrefix(v, "yes") || strings.HasPrefix(v, "true") || v == "spam"
}

// providerVerdict reads the spam headers servers add: SpamAssassin's
// X-Spam-*, rspamd's, Microsoft's SCL, Barracuda's. Only a "yes" counts: a
// sender can write "X-Spam-Flag: NO" into its own mail, so a "no" proves
// nothing and is ignored.
func providerVerdict(th *textproto.Header, h *Header) {
	setScore := func(score, limit float64) {
		if !h.HasScore || score > h.ProviderScore {
			h.ProviderScore, h.HasScore = score, true
			if limit > 0 {
				h.ProviderLimit = limit
			}
		}
	}
	for _, key := range []string{"X-Spam-Flag", "X-Spam", "X-Barracuda-Spam-Flag", "X-Spam-Verdict", "X-Ovh-Spam-Flag"} {
		if yes(topmost(th, key)) {
			h.ProviderSpam = true
		}
	}
	for _, key := range []string{"X-Spam-Status", "X-Barracuda-Spam-Status"} {
		if v := topmost(th, key); v != "" {
			if yes(v) {
				h.ProviderSpam = true
			}
			if m := reScore.FindStringSubmatch(v); m != nil {
				lim := 0.0
				if r := reReq.FindStringSubmatch(v); r != nil {
					lim, _ = strconv.ParseFloat(r[1], 64)
				}
				s, _ := strconv.ParseFloat(m[1], 64)
				setScore(s, lim)
			}
		}
	}
	if v := strings.TrimSpace(topmost(th, "X-Spam-Score")); v != "" {
		if s, err := strconv.ParseFloat(strings.Fields(v)[0], 64); err == nil {
			setScore(s, 0)
		}
	}
	if v := topmost(th, "X-Spam-Level"); v != "" && !h.HasScore {
		if n := strings.Count(v, "*"); n > 0 {
			setScore(float64(n), 0)
		}
	}
	switch strings.ToLower(strings.TrimSpace(topmost(th, "X-Rspamd-Action"))) {
	case "add header", "rewrite subject", "reject", "soft reject":
		h.ProviderSpam = true
	}
	if v := topmost(th, "X-Rspamd-Score"); v != "" {
		if s, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
			setScore(s, 0)
		}
	}
	if m := reSpamd.FindStringSubmatch(topmost(th, "X-Spamd-Result")); m != nil {
		if strings.EqualFold(m[1], "true") {
			h.ProviderSpam = true
		}
		s, _ := strconv.ParseFloat(m[2], 64)
		lim, _ := strconv.ParseFloat(m[3], 64)
		setScore(s, lim)
	}
	for _, key := range []string{"X-MS-Exchange-Organization-SCL", "X-Forefront-Antispam-Report", "X-Microsoft-Antispam-Mailbox-Delivery"} {
		v := topmost(th, key)
		if v == "" {
			continue
		}
		scl := strings.TrimSpace(v)
		if m := reSCL.FindStringSubmatch(v); m != nil {
			scl = m[1]
		}
		if n, err := strconv.Atoi(scl); err == nil && n >= 5 {
			h.ProviderSpam = true
		}
	}
}
