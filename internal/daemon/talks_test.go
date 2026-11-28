package daemon

import (
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/talks"
)

// A hold reaches Telegram as the person and why, and where to answer it:
// never the held message itself (ADR-110).
func TestTalkHoldMessage(t *testing.T) {
	n := talks.Notice{Talk: "t_0123456789abcdef01234567", Person: "Ana", Title: "Talk with Ana: held", Body: "A message was held: it holds never-share term: 1."}
	got := talkHoldMessage(n, "https://m.caprock.dev/")
	want := "Talk with Ana: held\nA message was held: it holds never-share term: 1.\n\nAnswer it in Caprock: https://m.caprock.dev/#/talks/t_0123456789abcdef01234567"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	if got := talkHoldMessage(n, ""); strings.Contains(got, "Answer it") {
		t.Fatalf("no address, no link: %q", got)
	}
}
