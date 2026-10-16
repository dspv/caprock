package fakemail

import (
	"bytes"
	"testing"
	"time"
)

// Two messages rendered at the same clock reading still get two Message-IDs.
// Windows' time.Now() can repeat across a tight loop, and a shared ID threads
// the messages into one conversation (TestTriageRealMailOnlyWhenAIOn saw one
// conversation where it delivered three).
func TestRawMessageIDsAreUniqueAtOneInstant(t *testing.T) {
	at := time.Date(2026, 10, 16, 9, 0, 0, 0, time.UTC)
	id := func(raw []byte) string {
		_, rest, _ := bytes.Cut(raw, []byte("Message-ID: <"))
		v, _, _ := bytes.Cut(rest, []byte(">"))
		return string(v)
	}
	a := id(Msg{From: "a@example.com", To: "me@fake.test", Subject: "hello 0", Date: at}.Raw())
	b := id(Msg{From: "a@example.com", To: "me@fake.test", Subject: "hello 1", Date: at}.Raw())
	if a == "" || a == b {
		t.Fatalf("Message-IDs %q and %q", a, b)
	}
}
