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

func TestEventVideoAnswersAWholeFileRangeAChunkAtATime(t *testing.T) {
	e := newEnv(t)
	dir := filepath.Join(t.TempDir(), "rec")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "long.mp4")
	size := int64(videoChunk*3 + 5)
	if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	id := tldrEvent(t, e, event.KindTurnUser, "u1", `"`+p+`"`)
	// What WebKit sends for a poster: the whole file.
	for _, rng := range []string{fmt.Sprintf("bytes=0-%d", size-1), "bytes=0-"} {
		res, body := videoGet(t, e, id, p, rng)
		want := fmt.Sprintf("bytes 0-%d/%d", videoChunk-1, size)
		if res.StatusCode != http.StatusPartialContent || len(body) != videoChunk || res.Header.Get("Content-Range") != want {
			t.Errorf("%s: %d, %d bytes, %q; want 206, %d bytes, %q", rng, res.StatusCode, len(body), res.Header.Get("Content-Range"), videoChunk, want)
		}
	}
	// A range inside the chunk, and the tail, as asked.
	if res, body := videoGet(t, e, id, p, "bytes=10-19"); res.StatusCode != 206 || len(body) != 10 {
		t.Errorf("small range: %d %d", res.StatusCode, len(body))
	}
	if res, body := videoGet(t, e, id, p, "bytes=-5"); res.StatusCode != 206 || len(body) != 5 {
		t.Errorf("suffix range: %d %d", res.StatusCode, len(body))
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

// videoOpen asks the daemon to open the prompt's video, with the opener
// replaced: no player ever starts in a test.
func videoOpen(t *testing.T, e *env, id int64, path string, opened *[]string) int {
	t.Helper()
	was := openWithSystem
	openWithSystem = func(p string) error { *opened = append(*opened, p); return nil }
	t.Cleanup(func() { openWithSystem = was })
	body := strings.NewReader(fmt.Sprintf(`{"path":%q}`, path))
	res, err := http.Post(fmt.Sprintf("%s/v1/events/%d/video/open", e.srv.URL, id), "application/json", body)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func TestEventVideoOpensInTheSystemPlayerOnlyWhatThePromptNames(t *testing.T) {
	e := newEnv(t)
	p := aVideo(t, "demo clip.mov")
	other := aVideo(t, "other.mov")
	id := tldrEvent(t, e, event.KindTurnUser, "u1", `"`+p+`" what does this show?`)
	var opened []string
	if code := videoOpen(t, e, id, p, &opened); code != http.StatusNoContent {
		t.Fatalf("open: %d", code)
	}
	if code := videoOpen(t, e, id, other, &opened); code != http.StatusNotFound {
		t.Errorf("a path the prompt does not name: %d, want 404", code)
	}
	if code := videoOpen(t, e, id, "/etc/hosts", &opened); code != http.StatusBadRequest {
		t.Errorf("not a video: %d, want 400", code)
	}
	real, _ := filepath.EvalSymlinks(p)
	if len(opened) != 1 || opened[0] != real {
		t.Errorf("opened %q, want only %q", opened, real)
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
