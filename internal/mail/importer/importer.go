// Package importer reads the mail accounts a user already has in another
// client — Thunderbird and (on macOS) Apple Mail — so Caprock Mail can offer
// to add them instead of making the user retype servers and passwords.
//
// Rule 4 (all data stays on the machine): it only ever reads local files that
// already belong to the user. Passwords it decrypts never leave the process —
// they are not placed in any value that is serialized to HTTP (see Source,
// whose credentials map is unexported). The caller passes them straight to the
// IMAP/SMTP servers the user chose, never anywhere else.
package importer

import (
	"runtime"
)

// Account is one importable mailbox. It never carries a password: the
// decrypted password, when there is one, is held in Source.creds and reached
// only in-process through Source.Password.
type Account struct {
	Name        string `json:"name"`
	Email       string `json:"email"`
	Username    string `json:"username"`
	IMAPHost    string `json:"imap_host"`
	IMAPPort    int    `json:"imap_port"`
	IMAPTLS     string `json:"imap_tls"` // tls | starttls | none
	SMTPHost    string `json:"smtp_host"`
	SMTPPort    int    `json:"smtp_port"`
	SMTPTLS     string `json:"smtp_tls"`
	HasPassword bool   `json:"has_password"`
}

// Source is one other mail client found on the machine.
type Source struct {
	Kind     string    `json:"kind"`  // thunderbird | apple_mail
	Label    string    `json:"label"` // "Thunderbird", "Apple Mail"
	Accounts []Account `json:"accounts"`
	// NeedsPermission names an OS permission Caprock must be granted before it
	// can read this source at all (e.g. "full_disk_access" for Apple Mail).
	NeedsPermission string `json:"needs_permission,omitempty"`
	// Error is a human-readable reason this source could not be fully read.
	Error string `json:"error,omitempty"`

	// creds maps an account email to its decrypted password. Unexported, so it
	// is never part of the JSON sent to the dashboard (rule 4).
	creds map[string]string
}

// Password returns the decrypted password for email, if one was recovered.
// It is only callable in-process; it is never serialized.
func (s Source) Password(email string) (string, bool) {
	p, ok := s.creds[email]
	return p, ok
}

// Sources lists the importable mail clients under home. It reads local files
// only and opens nothing else. A client that is absent yields no Source; a
// client that is present but unreadable yields a Source carrying Error or
// NeedsPermission so the dashboard can explain what to do.
func Sources(home string) []Source {
	var out []Source
	if tb := thunderbird(home); tb != nil {
		out = append(out, *tb)
	}
	if runtime.GOOS == "darwin" {
		if am := appleMail(home); am != nil {
			out = append(out, *am)
		}
	}
	return out
}
