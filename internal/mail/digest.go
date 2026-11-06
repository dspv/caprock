package mail

import (
	"context"
	"strings"
	"time"
)

// DigestItem is one important conversation as the Morning summary names it:
// the sender's name (else address) and the subject. Never a body.
type DigestItem struct {
	Sender  string
	Subject string
}

// Digest is Mail's part of the Morning summary (ADR-092).
type Digest struct {
	Important, Total int
	Items            []DigestItem
}

// Digest reads what came in since: how many inbox conversations got mail,
// how many of them the triage already marked important, and the newest n of
// those. ok is false — the section is left out — when Mail was never set up
// here, has no account, is showing its sample inbox, or its AI sorting is
// off: with no sorting there is no "important" to report, and Caprock does
// not sort on its own for this (no model call is made here). It never opens
// mail.db when it is not open, and never starts a sync.
func (s *Service) Digest(ctx context.Context, since time.Time, n int) (Digest, bool) {
	s.mu.Lock()
	st, sample := s.st, s.sample != nil || s.demo
	s.mu.Unlock()
	if st == nil || sample {
		return Digest{}, false
	}
	if readSettings(ctx, st)["ai_enabled"] != "1" {
		return Digest{}, false
	}
	if accts, err := st.Accounts(ctx); err != nil || len(accts) == 0 {
		return Digest{}, false
	}
	total, important, rows, err := st.Digest(ctx, since.Unix(), n)
	if err != nil {
		s.log.Warn("morning summary: could not read mail", "err", err)
		return Digest{}, false
	}
	d := Digest{Important: important, Total: total}
	for _, r := range rows {
		sender := strings.TrimSpace(r.FromName)
		if sender == "" {
			sender = strings.TrimSpace(r.FromAddr)
		}
		d.Items = append(d.Items, DigestItem{Sender: sender, Subject: strings.TrimSpace(r.Subject)})
	}
	return d, true
}
