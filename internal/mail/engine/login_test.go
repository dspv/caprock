package engine

import (
	"context"
	"reflect"
	"strings"
	"testing"

	store "github.com/dspv/caprock/internal/mail/mailstore"
)

func TestSignInNames(t *testing.T) {
	icloud := store.Account{Email: "dima@northwind.io", Username: "dima@northwind.io", IMAPHost: "imap.mail.me.com", SMTPHost: "smtp.mail.me.com"}
	if got := imapNames(icloud); !reflect.DeepEqual(got, []string{"dima@northwind.io", "dima"}) {
		t.Errorf("icloud imap names = %v", got)
	}
	icloud.Username = "dima"
	if got := smtpNames(icloud); !reflect.DeepEqual(got, []string{"dima", "dima@icloud.com", "dima@northwind.io"}) {
		t.Errorf("icloud smtp names = %v", got)
	}
	gmail := store.Account{Email: "a@gmail.com", Username: "a@gmail.com", IMAPHost: "imap.gmail.com", SMTPHost: "smtp.gmail.com"}
	if got := imapNames(gmail); !reflect.DeepEqual(got, []string{"a@gmail.com"}) {
		t.Errorf("gmail imap names = %v", got)
	}
}

// A sign-in name the server refuses is retried with the address, for IMAP
// and SMTP, and the name that worked is kept.
func TestRefusedNameFallsBackToTheAddress(t *testing.T) {
	h := newHarness(t)
	a := h.acc
	a.Username = "not-the-login"
	got, err := TestAccount(a, "pw")
	if err != nil {
		t.Fatal(err)
	}
	if got.Username != "me@fake.test" {
		t.Fatalf("username kept = %q", got.Username)
	}
	// A wrong password is still a refusal, with no endless retries.
	if _, err := TestAccount(a, "wrong"); err == nil || !strings.Contains(err.Error(), "IMAP") {
		t.Fatalf("wrong password: %v", err)
	}
	// The worker heals a stored wrong name on its first connection.
	if err := h.st.UpdateAccount(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if err := h.e.Start(); err != nil {
		t.Fatal(err)
	}
	h.waitFor("username healed", func() bool {
		acc, _ := h.st.Account(context.Background(), a.ID)
		return acc.Username == "me@fake.test"
	})
	// Sending with a stored name SMTP refuses still goes out.
	acc, _ := h.st.Account(context.Background(), a.ID)
	acc.Username = "not-the-login"
	if err := sendSMTP(acc, "pw", []string{"x@example.com"}, []byte("Subject: hi\r\n\r\nhi\r\n")); err != nil {
		t.Fatal(err)
	}
}
