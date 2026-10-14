package importer

import (
	"strings"
)

// Found is one account to offer on the "Import everything" screen: the same
// address seen in several mail apps is listed once.
type Found struct {
	Account
	// Source is the Kind to import it from: the one that holds its password
	// when any does, else the first that listed it.
	Source string `json:"source"`
	// From lists every mail app that has it, in scan order.
	From []string `json:"from"`
}

// Merge lists every account of every source once, keyed by address (case
// does not matter), in the order the sources and their accounts came. When
// two apps have the same address the one with a saved password wins, so the
// user is asked for nothing that is already on the machine.
func Merge(sources []Source) []Found {
	out := []Found{}
	at := map[string]int{}
	for _, s := range sources {
		for _, a := range s.Accounts {
			key := strings.ToLower(strings.TrimSpace(a.Email))
			if key == "" {
				continue
			}
			if a.Provider == "" {
				a.Provider = ProviderFor(a.Email, a.IMAPHost)
			}
			i, seen := at[key]
			if !seen {
				at[key] = len(out)
				out = append(out, Found{Account: a, Source: s.Kind, From: []string{s.Kind}})
				continue
			}
			f := &out[i]
			if !contains(f.From, s.Kind) {
				f.From = append(f.From, s.Kind)
			}
			if a.HasPassword && !f.HasPassword {
				name := f.Name
				f.Account, f.Source = a, s.Kind
				if f.Name == "" {
					f.Name = name
				}
			} else if f.Name == "" {
				f.Name = a.Name
			}
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ProviderFor names the mail service behind an address and its IMAP server,
// for the one sign-in it needs: "google" and "microsoft" (OAuth, or an app
// password), "icloud", "yahoo" and "fastmail" (an app password), or "" for
// any other server (its own password).
func ProviderFor(email, imapHost string) string {
	h := strings.ToLower(strings.TrimSpace(imapHost))
	_, domain, _ := strings.Cut(strings.ToLower(strings.TrimSpace(email)), "@")
	hostIs := func(suffixes ...string) bool {
		for _, s := range suffixes {
			if h == s || strings.HasSuffix(h, "."+s) {
				return true
			}
		}
		return false
	}
	domainIs := func(names ...string) bool {
		for _, n := range names {
			if domain == n {
				return true
			}
		}
		return false
	}
	switch {
	case hostIs("gmail.com", "googlemail.com") || domainIs("gmail.com", "googlemail.com"):
		return "google"
	case hostIs("mail.me.com") || domainIs("icloud.com", "me.com", "mac.com"):
		return "icloud"
	case hostIs("office365.com", "outlook.com", "hotmail.com", "live.com") ||
		domainIs("outlook.com", "hotmail.com", "live.com", "msn.com") ||
		strings.HasPrefix(domain, "outlook.") || strings.HasPrefix(domain, "hotmail.") || strings.HasPrefix(domain, "live."):
		return "microsoft"
	case hostIs("yahoo.com") || domainIs("yahoo.com", "ymail.com"):
		return "yahoo"
	case hostIs("fastmail.com") || domainIs("fastmail.com", "fastmail.fm"):
		return "fastmail"
	}
	return ""
}

// wellKnown are the servers of the services macOS Internet Accounts sets up
// without storing IMAP settings (a Google, iCloud or Exchange account added in
// System Settings), as internal/mail/providers lists them from each
// provider's own settings page.
var wellKnown = map[string]Account{
	"google":    {IMAPHost: "imap.gmail.com", IMAPPort: 993, IMAPTLS: "tls", SMTPHost: "smtp.gmail.com", SMTPPort: 465, SMTPTLS: "tls"},
	"icloud":    {IMAPHost: "imap.mail.me.com", IMAPPort: 993, IMAPTLS: "tls", SMTPHost: "smtp.mail.me.com", SMTPPort: 587, SMTPTLS: "starttls"},
	"microsoft": {IMAPHost: "outlook.office365.com", IMAPPort: 993, IMAPTLS: "tls", SMTPHost: "smtp.office365.com", SMTPPort: 587, SMTPTLS: "starttls"},
}

// withServers is an account for email on provider's well-known servers.
func withServers(provider, name, email string) Account {
	a := wellKnown[provider]
	a.Name, a.Email, a.Username, a.Provider = name, email, email, provider
	return a
}
