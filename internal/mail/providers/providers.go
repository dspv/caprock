// Package providers knows the server settings of common mail hosts, so adding
// an account is an address and a password. Nothing is looked up online.
package providers

import (
	"context"
	"net"
	"strings"
)

// Settings are the servers for an address.
type Settings struct {
	Provider string `json:"provider"`
	IMAPHost string `json:"imap_host"`
	IMAPPort int    `json:"imap_port"`
	IMAPTLS  string `json:"imap_tls"`
	SMTPHost string `json:"smtp_host"`
	SMTPPort int    `json:"smtp_port"`
	SMTPTLS  string `json:"smtp_tls"`
	// Note tells the user what the host needs, e.g. an app password.
	Note string `json:"note,omitempty"`
	// HelpURL is where that app password is made.
	HelpURL string `json:"help_url,omitempty"`
	// Known is false when the settings are a guess.
	Known bool `json:"known"`
}

type preset struct {
	name             string
	imap, smtp       string
	smtpPort         int
	smtpTLS          string
	note, help       string
	domains, mxHints []string
}

var presets = []preset{
	{name: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Gmail needs an app password (Google Account → Security → 2-Step Verification → App passwords).",
		help:    "https://myaccount.google.com/apppasswords",
		domains: []string{"gmail.com", "googlemail.com"}, mxHints: []string{"google.com", "googlemail.com"}},
	{name: "iCloud", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "iCloud needs an app-specific password (account.apple.com → Sign-In and Security). Log in with the address.",
		help:    "https://account.apple.com/account/manage",
		domains: []string{"icloud.com", "me.com", "mac.com"}},
	{name: "Fastmail", imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Fastmail needs an app password (Settings → Privacy & Security → App passwords).",
		help:    "https://app.fastmail.com/settings/security/apps",
		domains: []string{"fastmail.com", "fastmail.fm"}, mxHints: []string{"messagingengine.com"}},
	{name: "Outlook", imap: "outlook.office365.com", smtp: "smtp.office365.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "Microsoft accounts may refuse passwords and require OAuth sign-in, which is not supported yet.",
		domains: []string{"outlook.com", "hotmail.com", "live.com", "msn.com"}, mxHints: []string{"outlook.com"}},
	{name: "Yahoo", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Yahoo needs an app password (Account security → Generate app password).",
		domains: []string{"yahoo.com", "ymail.com"}, mxHints: []string{"yahoodns.net"}},
	{name: "Proton Mail Bridge", imap: "127.0.0.1", smtp: "127.0.0.1", smtpPort: 1025, smtpTLS: "starttls",
		note:    "Proton Mail works through Proton Mail Bridge; use the IMAP port and password it shows (usually 1143, STARTTLS).",
		domains: []string{"proton.me", "protonmail.com", "pm.me"}},
	{name: "Zoho", imap: "imap.zoho.com", smtp: "smtp.zoho.com", smtpPort: 465, smtpTLS: "tls",
		domains: []string{"zoho.com", "zohomail.com"}, mxHints: []string{"zoho.com", "zoho.eu"}},
	{name: "Yandex", imap: "imap.yandex.com", smtp: "smtp.yandex.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Yandex needs an app password and IMAP enabled in its mail settings.",
		domains: []string{"yandex.com", "yandex.ru", "ya.ru"}, mxHints: []string{"yandex.net", "yandex.ru"}},
	{name: "GMX", imap: "imap.gmx.com", smtp: "mail.gmx.com", smtpPort: 587, smtpTLS: "starttls",
		domains: []string{"gmx.com", "gmx.net", "gmx.de"}},
	{name: "Spacemail", imap: "mail.spacemail.com", smtp: "mail.spacemail.com", smtpPort: 465, smtpTLS: "tls",
		mxHints: []string{"spacemail.com"}},
}

func (p preset) settings() Settings {
	s := Settings{Provider: p.name, IMAPHost: p.imap, IMAPPort: 993, IMAPTLS: "tls",
		SMTPHost: p.smtp, SMTPPort: p.smtpPort, SMTPTLS: p.smtpTLS, Note: p.note, HelpURL: p.help, Known: true}
	if p.name == "Proton Mail Bridge" {
		s.IMAPPort, s.IMAPTLS = 1143, "starttls"
	}
	return s
}

// MXLookup resolves MX hosts; replaced in tests.
var MXLookup = func(ctx context.Context, domain string) ([]string, error) {
	mx, err := net.DefaultResolver.LookupMX(ctx, domain)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(mx))
	for i, m := range mx {
		out[i] = strings.TrimSuffix(strings.ToLower(m.Host), ".")
	}
	return out, nil
}

// Guess returns server settings for an address: a known host by domain, then
// by MX (Google Workspace, Microsoft 365, Fastmail on a custom domain), then
// the conventional imap./smtp. names.
func Guess(ctx context.Context, email string) Settings {
	at := strings.LastIndexByte(email, '@')
	if at < 0 {
		return Settings{}
	}
	domain := strings.ToLower(strings.TrimSpace(email[at+1:]))
	for _, p := range presets {
		for _, d := range p.domains {
			if d == domain {
				return p.settings()
			}
		}
	}
	if mx, err := MXLookup(ctx, domain); err == nil {
		for _, host := range mx {
			for _, p := range presets {
				for _, h := range p.mxHints {
					if host == h || strings.HasSuffix(host, "."+h) {
						s := p.settings()
						if p.name == "Gmail" {
							s.Provider = "Google Workspace"
						}
						if p.name == "Outlook" {
							s.Provider = "Microsoft 365"
						}
						return s
					}
				}
			}
		}
	}
	return Settings{Provider: domain, IMAPHost: "imap." + domain, IMAPPort: 993, IMAPTLS: "tls",
		SMTPHost: "smtp." + domain, SMTPPort: 465, SMTPTLS: "tls"}
}
