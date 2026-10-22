package engine

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// silentServer accepts connections and never says a word: the "Checking…"
// that never ended (2026-10-14).
func silentServer(t *testing.T) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { c.Close() })
		}
	}()
	h, p, _ := net.SplitHostPort(ln.Addr().String())
	n, _ := strconv.Atoi(p)
	return h, n
}

func TestCheckEndsWhenAServerGoesQuiet(t *testing.T) {
	old := dialTimeout
	dialTimeout = 300 * time.Millisecond
	t.Cleanup(func() { dialTimeout = old })
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	ipn, _ := strconv.Atoi(ip)
	sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
	spn, _ := strconv.Atoi(sp)
	qh, qp := silentServer(t)

	for _, tc := range []struct {
		name string
		a    store.Account
		want string
	}{
		{"imap", store.Account{IMAPHost: qh, IMAPPort: qp, IMAPTLS: "none", SMTPHost: sh, SMTPPort: spn, SMTPTLS: "none"}, "IMAP:"},
		{"imap tls", store.Account{IMAPHost: qh, IMAPPort: qp, IMAPTLS: "tls", SMTPHost: sh, SMTPPort: spn, SMTPTLS: "none"}, "IMAP:"},
		{"smtp", store.Account{IMAPHost: ih, IMAPPort: ipn, IMAPTLS: "none", SMTPHost: qh, SMTPPort: qp, SMTPTLS: "none"}, "SMTP:"},
		{"smtp starttls", store.Account{IMAPHost: ih, IMAPPort: ipn, IMAPTLS: "none", SMTPHost: qh, SMTPPort: qp, SMTPTLS: "starttls"}, "SMTP:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.a.Email, tc.a.Username = "me@fake.test", "me@fake.test"
			start := time.Now()
			_, err := TestAccount(tc.a, "pw")
			if took := time.Since(start); took > 3*time.Second {
				t.Fatalf("check took %v", took)
			}
			if err == nil || !strings.HasPrefix(err.Error(), tc.want) || !strings.Contains(err.Error(), "stopped answering") {
				t.Fatalf("err = %v", err)
			}
			// The host is named once; no socket address or port trace.
			if strings.Contains(err.Error(), ":"+strconv.Itoa(qp)) || strings.Contains(err.Error(), "->") {
				t.Fatalf("socket detail in %v", err)
			}
		})
	}
}

// A signed-in connection is not bound: IDLE may wait far longer than the
// sign-in timeout.
func TestSignedInConnectionOutlivesTheBound(t *testing.T) {
	old := dialTimeout
	dialTimeout = 300 * time.Millisecond
	t.Cleanup(func() { dialTimeout = old })
	srv, err := fakemail.Start("me@fake.test", "pw")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
	ipn, _ := strconv.Atoi(ip)
	c, _, err := dialIMAP(store.Account{Email: "me@fake.test", Username: "me@fake.test", IMAPHost: ih, IMAPPort: ipn, IMAPTLS: "none"}, "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(600 * time.Millisecond)
	if err := c.Noop().Wait(); err != nil {
		t.Fatalf("noop after the bound: %v", err)
	}
}

func TestTimeoutMessageKeepsCauseWithoutExposingSocketTrace(t *testing.T) {
	cause := fmt.Errorf("in response: cannot read tag: read tcp 10.0.0.1:1234->198.51.100.1:993: %w", os.ErrDeadlineExceeded)
	err := quiet("mail.spacemail.com", cause)
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatal("timeout cause lost")
	}
	for _, hidden := range []string{"cannot read tag", "read tcp", "10.0.0.1", "limiting connections", "password"} {
		if strings.Contains(err.Error(), hidden) {
			t.Fatalf("misleading or raw detail in message: %v", err)
		}
	}
	if !strings.Contains(err.Error(), "mail.spacemail.com") || !strings.Contains(err.Error(), "try again") {
		t.Fatalf("unhelpful timeout: %v", err)
	}
}
