package termbuf

import (
	"strings"
	"testing"
)

func visible(rows []string) string {
	var out []string
	for _, r := range rows {
		if r != "" {
			out = append(out, r)
		}
	}
	return strings.Join(out, "\n")
}

func TestScreenPlacesWordsByCursorMoves(t *testing.T) {
	// Claude Code writes a line as words between absolute column moves.
	got := Screen([]byte("Do\x1b[4Gyou\x1b[8Gwant\x1b[13Gto\x1b[16Gproceed?"), 40, 5)
	if got[0] != "Do you want to proceed?" {
		t.Fatalf("got %q", got[0])
	}
}

func TestScreenErasesAFrameDrawnOver(t *testing.T) {
	// A renderer draws a menu, erases it line by line moving up, and draws
	// the next frame where it was.
	b := "header\r\n❯ 1. Yes\r\n  2. No\r\n" +
		"\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G" + "done\r\n"
	got := visible(Screen([]byte(b), 40, 10))
	if got != "header\ndone" {
		t.Fatalf("got %q", got)
	}
}

func TestScreenScrollsAndKeepsTheBottom(t *testing.T) {
	var b strings.Builder
	for i := range 30 {
		b.WriteString("line ")
		b.WriteString(strings.Repeat("x", i%3))
		b.WriteString("\r\n")
	}
	b.WriteString("last")
	got := Screen([]byte(b.String()), 20, 5)
	if got[4] != "last" || !strings.HasPrefix(got[3], "line") {
		t.Fatalf("got %q", got)
	}
}

func TestScreenAltBufferAndAbsoluteMoves(t *testing.T) {
	b := "main text\x1b[?1049h\x1b[2J\x1b[3;5Hin alt\x1b[1;1Htop"
	got := Screen([]byte(b), 20, 5)
	if got[2] != "    in alt" || got[0] != "top" {
		t.Fatalf("alt: %q", got)
	}
	got = Screen([]byte(b+"\x1b[?1049l"), 20, 5)
	if got[0] != "main text" {
		t.Fatalf("back on main: %q", got)
	}
}

func TestScreenSkipsWhatDoesNotDraw(t *testing.T) {
	// Colours, a title, a mode, a cut UTF-8 rune and a cut sequence at the
	// end print nothing.
	b := "\x80\x9fA\x1b[1;38;2;10;20;30mB\x1b[0m\x1b]0;title\x07C\x1b[?2004hD\x1b[3"
	if got := Screen([]byte(b), 20, 2)[0]; got != "ABCD" {
		t.Fatalf("got %q", got)
	}
}

func TestScreenWrapsAtTheLastColumn(t *testing.T) {
	got := Screen([]byte("abcdefgh"), 5, 3)
	if got[0] != "abcde" || got[1] != "fgh" {
		t.Fatalf("got %q", got)
	}
	// Exactly full, then CR LF: one line, not two.
	got = Screen([]byte("abcde\r\nx"), 5, 3)
	if got[0] != "abcde" || got[1] != "x" {
		t.Fatalf("got %q", got)
	}
}

func TestScreenWideCharacters(t *testing.T) {
	got := Screen([]byte("日本x"), 10, 1)
	if got[0] != "日本x" {
		t.Fatalf("got %q", got)
	}
}
