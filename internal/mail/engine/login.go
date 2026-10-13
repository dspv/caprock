package engine

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
)

// The sign-in name a server wants is not always the address the mail goes
// to, and each host differs:
//
//   - iCloud's IMAP takes the full address or only the part before the @
//     (Apple: "if your client can't connect using just the name part, try
//     the full address"), while its SMTP wants a full address. An iCloud+
//     custom domain signs in with the @icloud.com address, not the custom one.
//   - Gmail and most hosts take the full address.
//
// So a refused login is retried with the other likely names, at most three,
// and only when the server said no to the credentials — never on a network
// error, and never with a different password.

func isICloud(host string) bool {
	h := strings.ToLower(host)
	return strings.HasSuffix(h, "mail.me.com") || strings.HasSuffix(h, ".icloud.com")
}

func isGmail(host string) bool {
	h := strings.ToLower(host)
	return strings.HasSuffix(h, "gmail.com") || strings.HasSuffix(h, "googlemail.com")
}

func localPart(s string) string {
	if i := strings.IndexByte(s, '@'); i > 0 {
		return s[:i]
	}
	return s
}

func addUnique(list []string, s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return list
	}
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return list
		}
	}
	return append(list, s)
}

// imapNames is the order IMAP sign-in names are tried in.
func imapNames(a store.Account) []string {
	names := addUnique(nil, a.Username)
	names = addUnique(names, a.Email)
	if isICloud(a.IMAPHost) {
		names = addUnique(names, localPart(a.Username))
	}
	if len(names) > 3 {
		names = names[:3]
	}
	return names
}

// smtpNames is the order SMTP sign-in names are tried in.
func smtpNames(a store.Account) []string {
	names := addUnique(nil, a.Username)
	if isICloud(a.SMTPHost) && !strings.Contains(a.Username, "@") {
		// IMAP took the bare name; SMTP needs an address.
		names = addUnique(names, a.Username+"@icloud.com")
	}
	names = addUnique(names, a.Email)
	if len(names) > 3 {
		names = names[:3]
	}
	return names
}

// imapRefused reports whether LOGIN was answered NO (bad credentials), as
// opposed to the connection failing.
func imapRefused(err error) bool {
	var ie *imap.Error
	return errors.As(err, &ie) && ie.Type == imap.StatusResponseTypeNo
}

// imapUnavailable reports a NO [UNAVAILABLE]. Dovecot (Spacemail and many
// hosts) answers a wrong password for a mailbox that exists this way, and
// also locks sign-in for a while after several failures, so it is not
// retried with another name.
func imapUnavailable(err error) bool {
	var ie *imap.Error
	return errors.As(err, &ie) && ie.Code == imap.ResponseCodeUnavailable
}

// smtpRefused reports whether AUTH was refused (535, or iCloud's 550 for an
// unknown sign-in name).
func smtpRefused(err error) bool {
	var se *smtp.SMTPError
	return errors.As(err, &se) && (se.Code == 535 || se.Code == 550 || se.Code == 534)
}

// loginIMAP signs in on c, trying the likely names; returns the one that worked.
// An OAuth account signs in once, with XOAUTH2 and secret as the access token.
func loginIMAP(c *imapclient.Client, a store.Account, password string) (string, error) {
	if p := oauth.ProviderOf(a.Auth); p != "" {
		if err := c.Authenticate(oauth.XOAuth2(a.Email, password)); err != nil {
			return "", oauthRefused(p, "IMAP", err, imapRefused(err))
		}
		return a.Email, nil
	}
	var first error
	for _, name := range imapNames(a) {
		err := c.Login(name, password).Wait()
		if err == nil {
			return name, nil
		}
		if first == nil {
			first = err
		}
		if !imapRefused(err) || imapUnavailable(err) {
			break
		}
	}
	return "", explain(a.IMAPHost, a.Email, first)
}

func dialSMTP(a store.Account) (*smtp.Client, error) {
	addr := net.JoinHostPort(a.SMTPHost, strconv.Itoa(a.SMTPPort))
	var c *smtp.Client
	var err error
	switch a.SMTPTLS {
	case "starttls":
		c, err = smtp.DialStartTLS(addr, tlsFor(a.SMTPHost))
	case "none":
		c, err = smtp.Dial(addr)
	default:
		c, err = smtp.DialTLS(addr, tlsFor(a.SMTPHost))
	}
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", addr, err)
	}
	return c, nil
}

// loginSMTP signs in, trying the likely names on fresh connections (a
// refused AUTH can leave a server unwilling to try again on the same one).
func loginSMTP(a store.Account, password string) (*smtp.Client, error) {
	if p := oauth.ProviderOf(a.Auth); p != "" {
		c, err := dialSMTP(a)
		if err != nil {
			return nil, err
		}
		if err := c.Auth(oauth.XOAuth2(a.Email, password)); err != nil {
			c.Close()
			return nil, oauthRefused(p, "SMTP", err, smtpRefused(err))
		}
		return c, nil
	}
	var first error
	for _, name := range smtpNames(a) {
		c, err := dialSMTP(a)
		if err != nil {
			return nil, err
		}
		if ok, _ := c.Extension("AUTH"); !ok {
			return c, nil
		}
		err = c.Auth(sasl.NewPlainClient("", name, password))
		if err == nil {
			return c, nil
		}
		c.Close()
		if first == nil {
			first = err
		}
		if !smtpRefused(err) {
			break
		}
	}
	return nil, explain(a.SMTPHost, a.Email, first)
}

// oauthRefused turns a refused XOAUTH2 sign-in into what to do: sign in in
// the browser again. It wraps oauth.ErrSignInAgain so the caller drops the
// cached access token.
func oauthRefused(provider, proto string, err error, refused bool) error {
	if !refused {
		return err
	}
	label := provider
	if p, ok := oauth.Lookup(provider); ok {
		label = p.Label
	}
	return fmt.Errorf("%w with %s: %s did not accept the sign-in (%w). If signing in again does not help, %s may be turned off for this mailbox by its administrator", oauth.ErrSignInAgain, label, proto, err, proto)
}

// explain adds what to do to a refused sign-in on the hosts people use most.
func explain(host, email string, err error) error {
	if err == nil {
		return nil
	}
	if !imapRefused(err) && !smtpRefused(err) {
		return err
	}
	switch {
	case isICloud(host):
		hint := "iCloud needs an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords), not your Apple Account password"
		if d := strings.ToLower(email[strings.LastIndexByte(email, '@')+1:]); d != "icloud.com" && d != "me.com" && d != "mac.com" {
			hint += "; for a custom domain, put your @icloud.com address in Username"
		}
		return fmt.Errorf("%w — %s", err, hint)
	case isGmail(host):
		return fmt.Errorf("%w — Gmail needs an app password (myaccount.google.com/apppasswords, with 2-Step Verification on); on Google Workspace the admin may have turned IMAP off", err)
	case imapUnavailable(err):
		return fmt.Errorf("%w — the server did not accept this password: this is how Dovecot servers (Spacemail and many hosts) answer a wrong password for a mailbox that exists. Use the mailbox's own password, not the hosting account's, and wait a few minutes if you have tried several times", err)
	}
	return err
}
