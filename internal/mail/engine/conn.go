package engine

import (
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	"strconv"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/charset"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// wordDecoder decodes RFC 2047 headers in every charset go-message knows,
// not just UTF-8 and Latin-1.
var wordDecoder = &mime.WordDecoder{CharsetReader: charset.Reader}

// dialTimeout bounds connecting and logging in.
var dialTimeout = 20 * time.Second

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

// dialIMAP connects and logs in.
func dialIMAP(a store.Account, password string, h *imapclient.UnilateralDataHandler) (*imapclient.Client, error) {
	addr := net.JoinHostPort(a.IMAPHost, strconv.Itoa(a.IMAPPort))
	opts := &imapclient.Options{
		WordDecoder:           wordDecoder,
		TLSConfig:             tlsFor(a.IMAPHost),
		Dialer:                &net.Dialer{Timeout: dialTimeout},
		UnilateralDataHandler: h,
	}
	var c *imapclient.Client
	var err error
	switch a.IMAPTLS {
	case "starttls":
		c, err = imapclient.DialStartTLS(addr, opts)
	case "none":
		c, err = imapclient.DialInsecure(addr, opts)
	default:
		c, err = imapclient.DialTLS(addr, opts)
	}
	if err != nil {
		return nil, fmt.Errorf("connect %s: %w", addr, err)
	}
	if err := c.Login(a.Username, password).Wait(); err != nil {
		c.Close()
		return nil, fmt.Errorf("login: %w", err)
	}
	return c, nil
}
