//go:build liveprobe

// A manual check against the real iCloud and Gmail servers, never run in CI:
// go test -tags liveprobe -run TestLiveProbe -v ./internal/mail/engine/
// It connects, reads capabilities and tries a made-up name and password.

package engine

import (
	"crypto/tls"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

func TestLiveProbe(t *testing.T) {
	for _, h := range []string{"imap.mail.me.com:993", "imap.gmail.com:993"} {
		c, err := imapclient.DialTLS(h, &imapclient.Options{WordDecoder: wordDecoder, Dialer: &net.Dialer{Timeout: 15 * time.Second}})
		if err != nil {
			t.Logf("%s dial: %v", h, err)
			continue
		}
		caps := c.Caps()
		var cs []string
		for k := range caps {
			cs = append(cs, string(k))
		}
		t.Logf("%s caps: %v", h, cs)
		err = c.Login("caprock.probe.nobody@icloud.com", "not-a-password").Wait()
		t.Logf("%s login with a bogus password: %v", h, err)
		c.Close()
	}
	for _, s := range []struct{ addr, mode string }{{"smtp.mail.me.com:587", "starttls"}, {"smtp.gmail.com:465", "tls"}, {"smtp.gmail.com:587", "starttls"}} {
		host, _, _ := net.SplitHostPort(s.addr)
		var c *smtp.Client
		var err error
		if s.mode == "tls" {
			c, err = smtp.DialTLS(s.addr, &tls.Config{ServerName: host})
		} else {
			c, err = smtp.DialStartTLS(s.addr, &tls.Config{ServerName: host})
		}
		if err != nil {
			t.Logf("%s dial: %v", s.addr, err)
			continue
		}
		ok, mechs := c.Extension("AUTH")
		err = c.Auth(sasl.NewPlainClient("", "caprock.probe.nobody@icloud.com", "not-a-password"))
		t.Logf("%s AUTH=%v %s; bogus login: %v", s.addr, ok, mechs, err)
		c.Close()
	}
	fmt.Println()
}
