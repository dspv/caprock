package providers

import (
	"context"
	"strings"
	"testing"
)

func TestGuess(t *testing.T) {
	offline(t, map[string][]string{
		"northwind.io": {"mx01.mail.icloud.com", "mx02.mail.icloud.com"},
		"acme.dev":     {"aspmx.l.google.com", "alt1.aspmx.l.google.com"},
	}, nil, nil)
	cases := []struct {
		email, provider, imap, smtp string
		port                        int
		tls, source                 string
		needsUser                   bool
	}{
		{"a@icloud.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", SourcePreset, false},
		{"a@me.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", SourcePreset, false},
		{"a@mac.com", "iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", SourcePreset, false},
		{"dima@northwind.io", "iCloud+ (custom domain)", "imap.mail.me.com", "smtp.mail.me.com", 587, "starttls", SourceMX, true},
		{"a@gmail.com", "Gmail", "imap.gmail.com", "smtp.gmail.com", 465, "tls", SourcePreset, false},
		{"A@GoogleMail.com ", "Gmail", "imap.gmail.com", "smtp.gmail.com", 465, "tls", SourcePreset, false},
		{"a@acme.dev", "Google Workspace", "imap.gmail.com", "smtp.gmail.com", 465, "tls", SourceMX, false},
		{"a@unknown.example", "unknown.example", "imap.unknown.example", "smtp.unknown.example", 465, "tls", SourceGuess, false},
	}
	for _, c := range cases {
		g := Guess(context.Background(), c.email)
		if g.Provider != c.provider || g.IMAPHost != c.imap || g.IMAPPort != 993 || g.IMAPTLS != "tls" ||
			g.SMTPHost != c.smtp || g.SMTPPort != c.port || g.SMTPTLS != c.tls || g.NeedsUsername != c.needsUser ||
			g.Source != c.source {
			t.Errorf("%s: got %+v", c.email, g)
		}
	}
	if g := Guess(context.Background(), "no-at-sign"); g.IMAPHost != "" {
		t.Errorf("no domain: %+v", g)
	}
}

// Every domain in the table answers from the table, with complete settings,
// and no domain is claimed by two presets.
func TestEveryPresetDomain(t *testing.T) {
	offline(t, nil, nil, nil)
	owner := map[string]string{}
	for _, p := range presets {
		for _, d := range p.domains {
			if prev, dup := owner[d]; dup {
				t.Errorf("%s is in both %s and %s", d, prev, p.name)
			}
			owner[d] = p.name
			g := Guess(context.Background(), "someone@"+d)
			if g.Source != SourcePreset || g.Provider != p.name || !g.Known || g.IMAPHost != p.imap || g.SMTPHost != p.smtp {
				t.Errorf("%s: got %+v", d, g)
			}
			if g.IMAPPort <= 0 || g.SMTPPort <= 0 || !validTLS(g.IMAPTLS) || !validTLS(g.SMTPTLS) {
				t.Errorf("%s: incomplete %+v", d, g)
			}
		}
	}
	for _, p := range presets {
		if len(p.domains) == 0 && len(p.mxHints) == 0 {
			t.Errorf("%s can never be reached", p.name)
		}
		if p.help != "" && !strings.HasPrefix(p.help, "https://") {
			t.Errorf("%s: help URL %q", p.name, p.help)
		}
	}
	if len(owner) < 80 {
		t.Errorf("only %d domains in the table", len(owner))
	}
}

func validTLS(s string) bool { return s == "tls" || s == "starttls" }

// A custom domain is recognised by the MX its host told the customer to set.
func TestMXHints(t *testing.T) {
	mx := map[string][]string{
		"rack.example":   {"mx1.emailsrvr.com", "mx2.emailsrvr.com"},
		"nc.example":     {"mx1.privateemail.com"},
		"space.example":  {"mx1.spacemail.com"},
		"de.example":     {"mx00.ionos.de", "mx01.ionos.de"},
		"uk.example":     {"mx00.ionos.co.uk"},
		"us.example":     {"mx00.ionos.com"},
		"ovh.example":    {"mx1.mail.ovh.net"},
		"hst.example":    {"mx1.hostinger.com"},
		"titan.example":  {"mx1.titan.email"},
		"ik.example":     {"mta-gw.infomaniak.ch"},
		"strato.example": {"smtpin.rzone.de"},
		"gd.example":     {"smtp.secureserver.net"},
		"mig.example":    {"aspmx1.migadu.com"},
		"m365.example":   {"northwind-io.mail.protection.outlook.com"},
		"zoho.example":   {"mx.zoho.com", "mx2.zoho.com"},
		"zeu.example":    {"mx.zoho.eu"},
		"y360.example":   {"mx.yandex.net"},
		"fm.example":     {"in1-smtp.messagingengine.com"},
		"att.example":    {"mx-att.mail.am0.yahoodns.net"},
		"aol.example":    {"mx-aol.mail.gm0.yahoodns.net"},
		"yho.example":    {"mta5.am0.yahoodns.net"},
		"gmxde.example":  {"mx00.emig.gmx.net"},
		"gmxcom.example": {"mx00.gmx.net"},
		// The first MX host that matches anything decides.
		"mixed.example": {"backup.unknown.example", "mx1.privateemail.com", "aspmx.l.google.com"},
	}
	offline(t, mx, nil, nil)
	want := map[string][2]string{
		"rack.example":   {"Rackspace Email", "secure.emailsrvr.com"},
		"nc.example":     {"Namecheap Private Email", "mail.privateemail.com"},
		"space.example":  {"Spacemail", "mail.spacemail.com"},
		"de.example":     {"IONOS", "imap.ionos.de"},
		"uk.example":     {"IONOS", "imap.ionos.co.uk"},
		"us.example":     {"IONOS", "imap.ionos.com"},
		"ovh.example":    {"OVHcloud", "imap.mail.ovh.net"},
		"hst.example":    {"Hostinger Email", "imap.hostinger.com"},
		"titan.example":  {"Titan Email", "imap.titan.email"},
		"ik.example":     {"Infomaniak", "mail.infomaniak.com"},
		"strato.example": {"STRATO", "imap.strato.de"},
		"gd.example":     {"GoDaddy Email", "imap.secureserver.net"},
		"mig.example":    {"Migadu", "imap.migadu.com"},
		"m365.example":   {"Microsoft 365", "outlook.office365.com"},
		"zoho.example":   {"Zoho Mail", "imap.zoho.com"},
		"zeu.example":    {"Zoho Mail (EU)", "imap.zoho.eu"},
		"y360.example":   {"Yandex", "imap.yandex.com"},
		"fm.example":     {"Fastmail", "imap.fastmail.com"},
		"att.example":    {"AT&T", "imap.mail.att.net"},
		"aol.example":    {"AOL", "imap.aol.com"},
		"yho.example":    {"Yahoo", "imap.mail.yahoo.com"},
		"gmxde.example":  {"GMX", "imap.gmx.net"},
		"gmxcom.example": {"GMX", "imap.gmx.com"},
		"mixed.example":  {"Namecheap Private Email", "mail.privateemail.com"},
	}
	for domain, w := range want {
		g := Guess(context.Background(), "me@"+domain)
		if g.Source != SourceMX || g.Provider != w[0] || g.IMAPHost != w[1] || !g.Known {
			t.Errorf("%s: want %v, got %+v", domain, w, g)
		}
	}
}

// A hint matches a whole label: notprivateemail.com is not Namecheap.
func TestMXHintMatchesWholeLabels(t *testing.T) {
	offline(t, map[string][]string{"x.example": {"mx.notprivateemail.com"}}, nil, nil)
	if g := Guess(context.Background(), "a@x.example"); g.Source != SourceGuess {
		t.Errorf("got %+v", g)
	}
}
