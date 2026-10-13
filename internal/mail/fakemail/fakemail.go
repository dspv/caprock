// Package fakemail runs an in-memory IMAP and SMTP server on loopback, for
// tests and for the demo mode that previews the client without a real account.
package fakemail

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	"github.com/dspv/caprock/internal/mail/oauth"
)

// Server is a running pair of IMAP and SMTP servers with one user.
type Server struct {
	User, Password string
	IMAPAddr       string
	SMTPAddr       string

	user *imapmemserver.User
	imap *imapserver.Server
	smtp *smtp.Server

	mu   sync.Mutex
	tok  string   // the one OAuth access token accepted, see SetToken
	Sent [][]byte // every message accepted over SMTP
}

// Folders created for the user.
var Folders = []string{"INBOX", "Sent", "Drafts", "Archive", "Trash", "Junk"}

// Start starts both servers on random loopback ports.
func Start(user, password string) (*Server, error) {
	s := &Server{User: user, Password: password}
	mem := imapmemserver.New()
	s.user = imapmemserver.NewUser(user, password)
	for _, f := range Folders {
		if err := s.user.Create(f, nil); err != nil {
			return nil, err
		}
	}
	mem.AddUser(s.user)
	s.imap = imapserver.New(&imapserver.Options{
		NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return &imapSession{SessionIMAP4rev2: mem.NewSession().(imapserver.SessionIMAP4rev2), s: s}, nil, nil
		},
		Caps:         imap.CapSet{imap.CapIMAP4rev1: {}, imap.CapIMAP4rev2: {}},
		InsecureAuth: true,
		Logger:       log.New(io.Discard, "", 0),
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s.IMAPAddr = ln.Addr().String()
	go func() { _ = s.imap.Serve(ln) }()

	s.smtp = smtp.NewServer(smtp.BackendFunc(func(*smtp.Conn) (smtp.Session, error) {
		return &smtpSession{s: s}, nil
	}))
	s.smtp.Domain = "localhost"
	s.smtp.AllowInsecureAuth = true
	s.smtp.ErrorLog = log.New(io.Discard, "", 0)
	sl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s.SMTPAddr = sl.Addr().String()
	go func() { _ = s.smtp.Serve(sl) }()
	return s, nil
}

// Close stops both servers.
func (s *Server) Close() {
	s.imap.Close()
	s.smtp.Close()
}

type literal struct {
	*bytes.Reader
}

func (l literal) Size() int64 { return l.Reader.Size() }

// Deliver appends a raw message to a folder.
func (s *Server) Deliver(folder string, raw []byte, flags ...imap.Flag) error {
	_, err := s.user.Append(folder, literal{bytes.NewReader(raw)}, &imap.AppendOptions{Flags: flags})
	return err
}

type smtpSession struct {
	s    *Server
	auth bool
	rcpt []string
}

func (ss *smtpSession) AuthMechanisms() []string {
	if ss.s.token() != "" {
		return []string{sasl.Plain, oauth.XOAuth2Mech}
	}
	return []string{sasl.Plain}
}

func (ss *smtpSession) Auth(mech string) (sasl.Server, error) {
	if mech == oauth.XOAuth2Mech && ss.s.token() != "" {
		return &xoauth2Server{check: func(user, token string) error {
			if user != ss.s.User || token != ss.s.token() {
				return &smtp.SMTPError{Code: 535, EnhancedCode: smtp.EnhancedCode{5, 7, 8}, Message: "Username and Password not accepted"}
			}
			ss.auth = true
			return nil
		}}, nil
	}
	return sasl.NewPlainServer(func(_, user, pass string) error {
		if user != ss.s.User || pass != ss.s.Password {
			// What Gmail answers; iCloud says 550 for an unknown name.
			return &smtp.SMTPError{Code: 535, EnhancedCode: smtp.EnhancedCode{5, 7, 8}, Message: "Username and Password not accepted"}
		}
		ss.auth = true
		return nil
	}), nil
}

func (ss *smtpSession) Mail(string, *smtp.MailOptions) error {
	if !ss.auth {
		return smtp.ErrAuthRequired
	}
	return nil
}

func (ss *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	ss.rcpt = append(ss.rcpt, to)
	return nil
}

func (ss *smtpSession) Data(r io.Reader) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	ss.s.mu.Lock()
	ss.s.Sent = append(ss.s.Sent, b)
	ss.s.mu.Unlock()
	// Mail to ourselves lands in our inbox, like a real server.
	for _, r := range ss.rcpt {
		if strings.EqualFold(r, ss.s.User) {
			return ss.s.Deliver("INBOX", b)
		}
	}
	return nil
}

func (ss *smtpSession) Reset()        { ss.rcpt = nil }
func (ss *smtpSession) Logout() error { return nil }

// SetToken makes both servers accept SASL XOAUTH2 for User with this access
// token (and no other); "" turns XOAUTH2 off.
func (s *Server) SetToken(tok string) {
	s.mu.Lock()
	s.tok = tok
	s.mu.Unlock()
}

func (s *Server) token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tok
}

// imapSession adds SASL XOAUTH2 (and PLAIN) to the in-memory server's
// session; a token that matches signs in as User.
type imapSession struct {
	imapserver.SessionIMAP4rev2
	s *Server
}

func (is *imapSession) AuthenticateMechanisms() []string {
	if is.s.token() != "" {
		return []string{sasl.Plain, oauth.XOAuth2Mech}
	}
	return []string{sasl.Plain}
}

func (is *imapSession) Authenticate(mech string) (sasl.Server, error) {
	switch {
	case mech == sasl.Plain:
		return sasl.NewPlainServer(func(_, user, pass string) error { return is.Login(user, pass) }), nil
	case mech == oauth.XOAuth2Mech && is.s.token() != "":
		return &xoauth2Server{check: func(user, token string) error {
			if user != is.s.User || token != is.s.token() {
				return &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeAuthenticationFailed, Text: "Invalid credentials (Failure)"}
			}
			return is.Login(is.s.User, is.s.Password)
		}}, nil
	}
	return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "SASL mechanism not supported"}
}

// xoauth2Server answers a refused token the way Gmail does: a JSON error as
// a challenge, then the refusal after the client's empty response.
type xoauth2Server struct {
	check  func(user, token string) error
	failed error
}

func (x *xoauth2Server) Next(resp []byte) ([]byte, bool, error) {
	if x.failed != nil {
		return nil, true, x.failed
	}
	if resp == nil {
		return []byte{}, false, nil // ask for the initial response
	}
	user, token, err := oauth.ParseXOAuth2(resp)
	if err == nil {
		err = x.check(user, token)
	}
	if err == nil {
		return nil, true, nil
	}
	x.failed = err
	return []byte(`{"status":"401","schemes":"bearer","scope":"https://mail.google.com/"}`), false, nil
}

// SentCount is how many messages SMTP accepted.
func (s *Server) SentCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.Sent)
}

// Msg is a compact way to write a test message.
type Msg struct {
	From, To, Subject, Body, HTML string
	Date                          time.Time
	MessageID, InReplyTo          string
	Attach                        string // file name of a small attachment
}

// Raw renders the message.
func (m Msg) Raw() []byte {
	var b bytes.Buffer
	if m.Date.IsZero() {
		m.Date = time.Now()
	}
	if m.MessageID == "" {
		m.MessageID = fmt.Sprintf("%d.%d@fake.test", m.Date.UnixNano(), len(m.Subject))
	}
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s>\r\nMIME-Version: 1.0\r\n",
		m.From, m.To, m.Subject, m.Date.Format(time.RFC1123Z), m.MessageID)
	if m.InReplyTo != "" {
		fmt.Fprintf(&b, "In-Reply-To: <%s>\r\nReferences: <%s>\r\n", m.InReplyTo, m.InReplyTo)
	}
	switch {
	case m.Attach != "":
		fmt.Fprintf(&b, "Content-Type: multipart/mixed; boundary=\"b1\"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n--b1\r\nContent-Type: application/pdf; name=\"%s\"\r\nContent-Disposition: attachment; filename=\"%s\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQKJcOkw7zDtsOfCg==\r\n--b1--\r\n",
			m.Body, m.Attach, m.Attach)
	case m.HTML != "":
		fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=\"b2\"\r\n\r\n--b2\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n--b2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s\r\n--b2--\r\n",
			m.Body, m.HTML)
	default:
		fmt.Fprintf(&b, "Content-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", m.Body)
	}
	return b.Bytes()
}
