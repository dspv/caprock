package ingest

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// The old cap counted bytes and sliced mid-rune, which clipped Cyrillic prose
// at about half the intended length and left U+FFFD at the end of a fifth of
// truncated rows — on the closing summaries people came back for.
func TestClipRunes(t *testing.T) {
	t.Run("short text is untouched", func(t *testing.T) {
		if got := clipRunes("привет", 10); got != "привет" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("counts runes, not bytes", func(t *testing.T) {
		// 100 Cyrillic characters = 200 bytes. A byte cap of 100 would have cut
		// this in half; a rune cap must not touch it.
		in := strings.Repeat("я", 100)
		if got := clipRunes(in, 100); got != in {
			t.Fatalf("clipped at %d runes, want untouched", utf8.RuneCountInString(got))
		}
	})

	t.Run("never splits a rune", func(t *testing.T) {
		in := strings.Repeat("ё", 50)
		got := clipRunes(in, 10)
		if strings.ContainsRune(got, utf8.RuneError) {
			t.Fatalf("truncation corrupted a rune: %q", got)
		}
		if !utf8.ValidString(got) {
			t.Fatalf("result is not valid UTF-8: %q", got)
		}
		if want := strings.Repeat("ё", 10) + "…"; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	})

	t.Run("emoji and combining marks survive", func(t *testing.T) {
		in := strings.Repeat("🔑", 20)
		got := clipRunes(in, 5)
		if strings.ContainsRune(got, utf8.RuneError) || !utf8.ValidString(got) {
			t.Fatalf("corrupted: %q", got)
		}
	})

	t.Run("a closing summary is kept whole", func(t *testing.T) {
		// Real summaries measured on live data ran to ~2.4k characters; the cap
		// must sit well above that so the useful content is never the casualty.
		summary := strings.Repeat("Готово, вот что изменилось. ", 80) // ~2240 runes
		if got := clipRunes(summary, MaxAssistantText); got != summary {
			t.Fatalf("a %d-rune summary was clipped", utf8.RuneCountInString(summary))
		}
	})
}
