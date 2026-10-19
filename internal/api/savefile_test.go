package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// SaveFile (a file forwarded to the Telegram bot, ADR-081) keeps what the
// paste endpoint keeps, plus a voice note, in a directory of its own under
// the paste folder; anything else is refused with a sentence the bot shows.
func TestSaveFileTakesThePasteListAndAudio(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct{ name, mime, want string }{
		{"photo.jpg", "image/jpeg", "photo.jpg"},
		{"voice.ogg", "audio/ogg", "voice.ogg"},
		{"", "audio/ogg", "audio.oga"},
		{"memo.m4a", "", "memo.m4a"},
		{"report.pdf", "application/pdf", "report.pdf"},
	} {
		path, err := SaveFile(dir, now, c.name, c.mime, []byte("data"))
		if err != nil {
			t.Fatalf("%q: %v", c.name, err)
		}
		if filepath.Base(path) != c.want || !strings.HasPrefix(path, filepath.Join(dir, "paste")+string(filepath.Separator)) {
			t.Fatalf("%q saved as %q", c.name, path)
		}
		if b, _ := os.ReadFile(path); string(b) != "data" {
			t.Fatalf("%q holds %q", c.name, b)
		}
	}
	if _, err := SaveFile(dir, now, "tool.exe", "application/octet-stream", []byte("MZ")); err == nil || err.Error() != ".exe is not a type Caprock keeps" {
		t.Fatalf("an .exe: %v", err)
	}
	if _, err := SaveFile(dir, now, "big.png", "image/png", make([]byte, pasteLimit+1)); err == nil {
		t.Fatal("a file over 10 MB was kept")
	}
}
