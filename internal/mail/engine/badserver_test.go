package engine

import (
	"bytes"
	"context"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/mail/fakemail"
)

// corruptingProxy forwards IMAP and breaks the server's answers the way
// iCloud has: an unescaped quote inside a quoted string. Every `"POISON"`
// becomes `"PO"SON"` (same length, so literals keep their sizes).
func corruptingProxy(t *testing.T, target string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			cl, err := ln.Accept()
			if err != nil {
				return
			}
			sv, err := net.Dial("tcp", target)
			if err != nil {
				cl.Close()
				continue
			}
			go func() { _, _ = io.Copy(sv, cl); sv.Close() }()
			go func() {
				buf := make([]byte, 64<<10)
				for {
					n, err := sv.Read(buf)
					if n > 0 {
						out := bytes.ReplaceAll(buf[:n], []byte(`"POISON"`), []byte(`"PO"SON"`))
						if _, werr := cl.Write(out); werr != nil {
							break
						}
					}
					if err != nil {
						break
					}
				}
				cl.Close()
			}()
		}
	}()
	return ln.Addr().String()
}

func TestOneUnreadableMessageDoesNotStopTheFolder(t *testing.T) {
	h := newHarness(t)
	addr := corruptingProxy(t, h.srv.IMAPAddr)
	_, port, _ := net.SplitHostPort(addr)
	a := h.acc
	a.IMAPPort, _ = strconv.Atoi(port)
	if err := h.st.UpdateAccount(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		_ = h.srv.Deliver("INBOX", fakemail.Msg{From: "x@example.com", To: "me@fake.test", Subject: "ok " + strconv.Itoa(i), Body: "fine"}.Raw())
	}
	poison := "From: y@example.com\r\nTo: me@fake.test\r\nSubject: poisoned\r\nMessage-ID: <p@x>\r\nMIME-Version: 1.0\r\n" +
		"Content-Type: text/plain; charset=utf-8; name=\"POISON\"\r\n\r\nstill readable\r\n"
	_ = h.srv.Deliver("INBOX", []byte(poison))
	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("all seven stored with bodies", func() bool {
		ms := h.list("inbox")
		if len(ms) != 7 {
			return false
		}
		for _, m := range ms {
			if m.BodyState != 1 {
				return false
			}
		}
		return true
	})
	for _, m := range h.list("inbox") {
		if m.Subject == "poisoned" {
			full, _ := h.st.Message(context.Background(), m.ID)
			// Stored by the fallback (no body structure), proving the
			// corrupted answer really reached the client.
			if full.Structure.Text == nil || full.Structure.Text.Charset != "" {
				t.Fatalf("not the fallback path: %+v", full.Structure)
			}
			if !strings.Contains(full.BodyText, "still readable") {
				t.Fatalf("poisoned body = %q", full.BodyText)
			}
			return
		}
	}
	t.Fatal("the poisoned message was not stored")
}
