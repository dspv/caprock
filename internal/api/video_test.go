package api

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/event"
)

// videoGet asks for the prompt's video, with an optional Range.
func videoGet(t *testing.T, e *env, id int64, path, rng string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/events/%d/video?path=%s", e.srv.URL, id, url.QueryEscape(path)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

// aVideo writes a small file under a folder with a space in its name, as
// the macOS data directory has, and returns its path.
func aVideo(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "Screen Recordings")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("0123456789abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestEventVideoServesAPathThePromptNames(t *testing.T) {
	e := newEnv(t)
	p := aVideo(t, "demo clip.mov")
	id := tldrEvent(t, e, event.KindTurnUser, "u1", `"`+p+`" what does this show?`)

	res, body := videoGet(t, e, id, p, "")
	if res.StatusCode != 200 || body != "0123456789abcdef" {
		t.Fatalf("whole file: %d %q", res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); ct != "video/quicktime" {
		t.Errorf("Content-Type %q, want video/quicktime", ct)
	}
	if res.Header.Get("Accept-Ranges") != "bytes" {
		t.Errorf("Accept-Ranges %q: a WebKit <video> plays nothing without ranges", res.Header.Get("Accept-Ranges"))
	}
	// WebKit opens with bytes=0-1, then asks for what it needs.
	res, body = videoGet(t, e, id, p, "bytes=0-1")
	if res.StatusCode != http.StatusPartialContent || body != "01" || res.Header.Get("Content-Range") != "bytes 0-1/16" {
		t.Fatalf("range: %d %q %q", res.StatusCode, body, res.Header.Get("Content-Range"))
	}
}

func TestEventVideoTakesAShellEscapedPath(t *testing.T) {
	e := newEnv(t)
	p := aVideo(t, "demo clip.mp4")
	id := tldrEvent(t, e, event.KindTurnUser, "u1", strings.ReplaceAll(p, " ", `\ `)+" look")
	res, _ := videoGet(t, e, id, p, "")
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("escaped path: %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

func TestEventVideoRefusesWhatThePromptDidNotName(t *testing.T) {
	e := newEnv(t)
	p := aVideo(t, "a.mov")
	other := aVideo(t, "b.mov")
	doc := filepath.Join(filepath.Dir(p), "notes.txt")
	if err := os.WriteFile(doc, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	prompt := tldrEvent(t, e, event.KindTurnUser, "u1", `"`+p+`" and "`+doc+`"`)
	reply := tldrEvent(t, e, event.KindTurnAssistant, "a1", `"`+other+`"`)

	for _, c := range []struct {
		name string
		id   int64
		path string
		want int
	}{
		{"another video", prompt, other, 404},
		{"named in a reply, not a prompt", reply, other, 404},
		{"no such event", 999999, p, 404},
		{"not a video", prompt, doc, 400},
		{"relative", prompt, "a.mov", 400},
		{"named but gone", tldrEvent(t, e, event.KindTurnUser, "u2", `"`+p+`x.mov"`), p + "x.mov", 404},
	} {
		if res, body := videoGet(t, e, c.id, c.path, ""); res.StatusCode != c.want {
			t.Errorf("%s: %d %q, want %d", c.name, res.StatusCode, body, c.want)
		}
	}
}
