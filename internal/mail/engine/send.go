package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// Attachment is a file to send.
type Attachment struct {
	Filename string `json:"filename"`
	Type     string `json:"type"`
	Data     []byte `json:"data"` // base64 in JSON
}

// Draft is a message to send.
type Draft struct {
	AccountID   int64           `json:"account_id"`
	To          []store.Address `json:"to"`
	Cc          []store.Address `json:"cc"`
	Bcc         []store.Address `json:"bcc"`
	Subject     string          `json:"subject"`
	Text        string          `json:"text"`
	HTML        string          `json:"html"`
	InReplyTo   int64           `json:"in_reply_to"` // local message id being answered
	Attachments []Attachment    `json:"attachments"`
}

// ErrNoRecipients is returned for a draft with nobody to send to.
var ErrNoRecipients = errors.New("no recipients")

// Build renders a draft as an RFC 5322 message. Returns the bytes and envelope recipients.
func (e *Engine) Build(ctx context.Context, d Draft) ([]byte, []string, store.Account, error) {
	a, err := e.st.Account(ctx, d.AccountID)
	if err != nil {
		return nil, nil, a, err
	}
	var rcpt []string
	for _, l := range [][]store.Address{d.To, d.Cc, d.Bcc} {
		for _, x := range l {
			if x.Addr = strings.TrimSpace(x.Addr); x.Addr != "" {
				rcpt = append(rcpt, x.Addr)
			}
		}
	}
	if len(rcpt) == 0 {
		return nil, nil, a, ErrNoRecipients
	}
	var h mail.Header
	h.SetDate(time.Now())
	h.SetAddressList("From", []*mail.Address{{Name: a.Name, Address: a.Email}})
	h.SetAddressList("To", toMail(d.To))
	if len(d.Cc) > 0 {
		h.SetAddressList("Cc", toMail(d.Cc))
	}
	h.SetSubject(d.Subject)
	domain := a.Email[strings.LastIndexByte(a.Email, '@')+1:]
	if err := h.GenerateMessageIDWithHostname(domain); err != nil {
		return nil, nil, a, err
	}
	h.Set("User-Agent", "Caprock Mail")
	if d.InReplyTo != 0 {
		if orig, err := e.st.Message(ctx, d.InReplyTo); err == nil && orig.MessageID != "" {
			h.SetMsgIDList("In-Reply-To", []string{orig.MessageID})
			refs := strings.Fields(orig.Refs)
			refs = append(refs, orig.MessageID)
			h.SetMsgIDList("References", refs)
		}
	}
	var buf bytes.Buffer
	text := d.Text
	writeBody := func(w io.Writer) error {
		_, err := io.WriteString(w, text)
		return err
	}
	if len(d.Attachments) == 0 && d.HTML == "" {
		h.Set("Content-Type", "text/plain; charset=utf-8")
		mw, err := mail.CreateSingleInlineWriter(&buf, h)
		if err != nil {
			return nil, nil, a, err
		}
		if err := writeBody(mw); err != nil {
			return nil, nil, a, err
		}
		if err := mw.Close(); err != nil {
			return nil, nil, a, err
		}
		return buf.Bytes(), rcpt, a, nil
	}
	mw, err := mail.CreateWriter(&buf, h)
	if err != nil {
		return nil, nil, a, err
	}
	iw, err := mw.CreateInline()
	if err != nil {
		return nil, nil, a, err
	}
	var th mail.InlineHeader
	th.Set("Content-Type", "text/plain; charset=utf-8")
	pw, err := iw.CreatePart(th)
	if err != nil {
		return nil, nil, a, err
	}
	if err := writeBody(pw); err != nil {
		return nil, nil, a, err
	}
	pw.Close()
	if d.HTML != "" {
		var hh mail.InlineHeader
		hh.Set("Content-Type", "text/html; charset=utf-8")
		pw, err := iw.CreatePart(hh)
		if err != nil {
			return nil, nil, a, err
		}
		_, _ = io.WriteString(pw, d.HTML)
		pw.Close()
	}
	iw.Close()
	for _, at := range d.Attachments {
		var ah mail.AttachmentHeader
		typ := at.Type
		if typ == "" {
			typ = "application/octet-stream"
		}
		ah.Set("Content-Type", typ)
		ah.SetFilename(at.Filename)
		aw, err := mw.CreateAttachment(ah)
		if err != nil {
			return nil, nil, a, err
		}
		_, _ = aw.Write(at.Data)
		aw.Close()
	}
	if err := mw.Close(); err != nil {
		return nil, nil, a, err
	}
	return buf.Bytes(), rcpt, a, nil
}

func toMail(as []store.Address) []*mail.Address {
	out := make([]*mail.Address, 0, len(as))
	for _, x := range as {
		if strings.TrimSpace(x.Addr) != "" {
			out = append(out, &mail.Address{Name: x.Name, Address: strings.TrimSpace(x.Addr)})
		}
	}
	return out
}

// Send delivers a draft over SMTP, files it in Sent and marks the original answered.
func (e *Engine) Send(ctx context.Context, d Draft) error {
	raw, rcpt, a, err := e.Build(ctx, d)
	if err != nil {
		return err
	}
	pw, err := e.sec.Get(a.ID)
	if err != nil {
		return err
	}
	if err := sendSMTP(a, pw, rcpt, raw); err != nil {
		return err
	}
	for _, l := range [][]store.Address{d.To, d.Cc, d.Bcc} {
		for _, x := range l {
			_ = e.st.NoteContact(ctx, x, 5, time.Now().Unix())
		}
	}
	// Gmail files sent mail itself; everywhere else we append to Sent.
	if !strings.HasSuffix(strings.ToLower(a.SMTPHost), "gmail.com") {
		if sent, err := e.st.FolderByRole(ctx, a.ID, "sent"); err == nil {
			if w, err := e.worker(a.ID); err == nil {
				_ = w.do(func(c *imapclient.Client, _ store.Account) error {
					cmd := c.Append(sent.Name, int64(len(raw)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagSeen}, Time: time.Now()})
					if _, err := cmd.Write(raw); err != nil {
						cmd.Close()
						return err
					}
					if err := cmd.Close(); err != nil {
						return err
					}
					_, err := cmd.Wait()
					return err
				})
				w.kickSync(sent.Name)
			}
		}
	} else if w, err := e.worker(a.ID); err == nil {
		w.kickSync("")
	}
	if d.InReplyTo != 0 {
		if orig, err := e.st.Message(ctx, d.InReplyTo); err == nil {
			_ = e.st.SetFlags(ctx, orig.ID, orig.Seen, orig.Flagged, true)
			if w, err := e.worker(orig.AccountID); err == nil {
				if f, err := e.st.Folder(ctx, orig.FolderID); err == nil {
					_ = w.do(func(c *imapclient.Client, _ store.Account) error {
						if _, err := c.Select(f.Name, nil).Wait(); err != nil {
							return err
						}
						return c.Store(imap.UIDSetNum(imap.UID(orig.UID)), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagAnswered}}, nil).Close()
					})
				}
			}
		}
	}
	e.notify("messages", a.ID)
	return nil
}

func sendSMTP(a store.Account, password string, rcpt []string, raw []byte) error {
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
		return fmt.Errorf("smtp connect %s: %w", addr, err)
	}
	defer c.Close()
	if ok, _ := c.Extension("AUTH"); ok {
		if err := c.Auth(sasl.NewPlainClient("", a.Username, password)); err != nil {
			return fmt.Errorf("smtp login: %w", err)
		}
	}
	if err := c.SendMail(a.Email, rcpt, bytes.NewReader(raw)); err != nil {
		return fmt.Errorf("smtp send: %w", err)
	}
	return c.Quit()
}

// TestAccount checks that IMAP and SMTP accept the credentials.
func TestAccount(a store.Account, password string) error {
	c, err := dialIMAP(a, password, nil)
	if err != nil {
		return fmt.Errorf("IMAP: %w", err)
	}
	_ = c.Logout().Wait()
	c.Close()
	addr := net.JoinHostPort(a.SMTPHost, strconv.Itoa(a.SMTPPort))
	var sc *smtp.Client
	switch a.SMTPTLS {
	case "starttls":
		sc, err = smtp.DialStartTLS(addr, tlsFor(a.SMTPHost))
	case "none":
		sc, err = smtp.Dial(addr)
	default:
		sc, err = smtp.DialTLS(addr, tlsFor(a.SMTPHost))
	}
	if err != nil {
		return fmt.Errorf("SMTP: connect %s: %w", addr, err)
	}
	defer sc.Close()
	if ok, _ := sc.Extension("AUTH"); ok {
		if err := sc.Auth(sasl.NewPlainClient("", a.Username, password)); err != nil {
			return fmt.Errorf("SMTP: login: %w", err)
		}
	}
	return sc.Quit()
}
