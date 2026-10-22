package engine

import (
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/charset"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// wordDecoder decodes RFC 2047 headers in every charset go-message knows,
// not just UTF-8 and Latin-1.
var wordDecoder = &mime.WordDecoder{CharsetReader: charset.Reader}

// dialTimeout bounds connecting and logging in: the TCP connect, the TLS
// handshake, the greeting and every sign-in attempt together.
var dialTimeout = 30 * time.Second

// boundedConn caps every deadline set on it at until, so a server that goes
// quiet while connecting or signing in fails at a known time instead of
// holding the request: go-imap sets no deadline of its own and go-smtp waits
// five minutes per command. release lifts the cap once signed in, because a
// synced connection then sits in IDLE for as long as it needs.
type boundedConn struct {
	net.Conn
	mu    sync.Mutex
	until time.Time
}

func dialBounded(addr string) (*boundedConn, error) {
	until := time.Now().Add(dialTimeout)
	raw, err := (&net.Dialer{Deadline: until}).Dial("tcp", addr)
	if err != nil {
		return nil, err
	}
	c := &boundedConn{Conn: raw, until: until}
	_ = raw.SetDeadline(until)
	return c, nil
}

func (c *boundedConn) bound(t time.Time) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.until.IsZero() || (!t.IsZero() && t.Before(c.until)) {
		return t
	}
	return c.until
}

func (c *boundedConn) SetDeadline(t time.Time) error { return c.Conn.SetDeadline(c.bound(t)) }

func (c *boundedConn) SetReadDeadline(t time.Time) error { return c.Conn.SetReadDeadline(c.bound(t)) }

func (c *boundedConn) SetWriteDeadline(t time.Time) error { return c.Conn.SetWriteDeadline(c.bound(t)) }

func (c *boundedConn) release() {
	c.mu.Lock()
	c.until = time.Time{}
	c.mu.Unlock()
	_ = c.Conn.SetDeadline(time.Time{})
}

// implicitTLS wraps c in TLS and shakes hands within c's bound.
func implicitTLS(c net.Conn, cfg *tls.Config) (net.Conn, error) {
	tc := tls.Client(c, cfg)
	if err := tc.Handshake(); err != nil {
		c.Close()
		return nil, err
	}
	return tc, nil
}

// silent reports a server that stopped answering inside dialTimeout. go-imap
// formats the read error into its own (%v), so the text is checked too.
func silent(err error) bool {
	var ne net.Error
	return errors.Is(err, os.ErrDeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) ||
		(err != nil && strings.Contains(err.Error(), "i/o timeout"))
}

// serverTimeout keeps the network cause for errors.Is/As without exposing
// socket addresses or a library's parser trace in a user-facing message.
type serverTimeout struct {
	host  string
	after time.Duration
	cause error
}

func (e *serverTimeout) Error() string {
	return fmt.Sprintf("%s stopped answering after %v. Check the server name, the port and your connection (a VPN included), then try again", e.host, e.after)
}

func (e *serverTimeout) Unwrap() error { return e.cause }

// quiet describes the observed timeout without guessing whether the server
// rejected a password, throttled the account, or lost its network connection.
func quiet(host string, err error) error {
	if !silent(err) {
		return err
	}
	return &serverTimeout{host: host, after: dialTimeout, cause: err}
}

// connectErr names the address for a refused handshake; a timeout already
// names its host, so the address would only repeat it.
func connectErr(addr, host string, err error) error {
	if silent(err) {
		return fmt.Errorf("connect: %w", quiet(host, err))
	}
	return fmt.Errorf("connect %s: %w", addr, err)
}

// TLSConfig is used for every TLS connection; tests replace it to trust a local server.
var TLSConfig *tls.Config

func tlsFor(host string) *tls.Config {
	if TLSConfig != nil {
		c := TLSConfig.Clone()
		if c.ServerName == "" {
			c.ServerName = host
		}
		return c
	}
	return &tls.Config{ServerName: host}
}

// dialIMAP connects and signs in; returns the sign-in name that worked.
func dialIMAP(a store.Account, password string, h *imapclient.UnilateralDataHandler) (*imapclient.Client, string, error) {
	addr := net.JoinHostPort(a.IMAPHost, strconv.Itoa(a.IMAPPort))
	opts := &imapclient.Options{
		WordDecoder:           wordDecoder,
		TLSConfig:             tlsFor(a.IMAPHost),
		UnilateralDataHandler: h,
	}
	bc, err := dialBounded(addr)
	if err != nil {
		return nil, "", fmt.Errorf("connect: %w", quiet(a.IMAPHost, err))
	}
	var c *imapclient.Client
	switch a.IMAPTLS {
	case "starttls":
		c, err = imapclient.NewStartTLS(bc, opts)
	case "none":
		c = imapclient.New(bc, opts)
	default:
		cfg := tlsFor(a.IMAPHost)
		cfg.NextProtos = []string{"imap"}
		var tc net.Conn
		if tc, err = implicitTLS(bc, cfg); err == nil {
			c = imapclient.New(tc, opts)
		}
	}
	if err != nil {
		return nil, "", connectErr(addr, a.IMAPHost, err)
	}
	name, err := loginIMAP(c, a, password)
	if err != nil {
		c.Close()
		return nil, "", fmt.Errorf("login: %w", quiet(a.IMAPHost, err))
	}
	bc.release()
	return c, name, nil
}
