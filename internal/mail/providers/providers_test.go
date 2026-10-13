package providers

import (
	"context"
	"testing"
)

func TestGuess(t *testing.T) {
	mx := map[string][]string{
		"northwind.io": {"mx01.mail.icloud.com", "mx02.mail.icloud.com"},
		"acme.dev":     {"aspmx.l.google.com", "alt1.aspmx.l.google.com"},
	}
	orig := MXLookup
	MXLookup = func(_ context.Context, d string) ([]string, error) { return mx[d], nil }
	defer func() { MXLookup = orig }()
	cases := []struct {
		email, provider, imap, smtp string
		port                        int
		tls                         string
		needsUser                   bool
	}{
		{"a@icloud.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", false},
		{"a@me.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", false},
		{"a@mac.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", false},
		{"dima@northwind.io", "iCloud+ (custom domain)", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", true},
		{"a@gmail.com", "Gmail", "imap.gmail.com", "smtp.gmail.com", 465, "tls", false},
		{"a@googlemail.com", "Gmail", "imap.gmail.com", "smtp.gmail.com", 465, "tls", false},
		{"a@acme.dev", "Google Workspace", "imap.gmail.com", "smtp.gmail.com", 465, "tls", false},
		{"a@unknown.example", "unknown.example", "imap.unknown.example", "smtp.unknown.example", 465, "tls", false},
	}
	for _, c := range cases {
		g := Guess(context.Background(), c.email)
		if g.Provider != c.provider || g.IMAPHost != c.imap || g.IMAPPort != 993 || g.IMAPTLS != "tls" ||
			g.SMTPHost != c.smtp || g.SMTPPort != c.port || g.SMTPTLS != c.tls || g.NeedsUsername != c.needsUser {
			t.Errorf("%s: got %+v", c.email, g)
		}
	}
}
