package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubSupport stands in for caprock.dev/api/support and records every body.
// Tests never reach the real site: CAPROCK_SUPPORT_URL points here.
func stubSupport(t *testing.T, status int) func() []map[string]any {
	t.Helper()
	var got []map[string]any
	var mu sync.Mutex
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		got = append(got, m)
		mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(site.Close)
	t.Setenv("CAPROCK_SUPPORT_URL", site.URL)
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), got...)
	}
}

// A tiny image of each type: only the leading bytes are checked.
var (
	shotPNG  = append([]byte("\x89PNG\r\n\x1a\n"), 1, 2, 3)
	shotJPEG = []byte{0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3}
	shotWEBP = []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
)

// supportServer is a daemon with a known version, a viewer and a controller
// phone, and a logger whose output the test reads.
func supportServer(t *testing.T) (s *Server, viewer, controller string, logs *bytes.Buffer) {
	t.Helper()
	logs = &bytes.Buffer{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s, _, v, c := pairedPhones(t, Deps{Version: "1.2.3", Log: log})
	return s, v.Token, c.Token, logs
}

// What reaches the site is exactly the text, the email, the screenshots, and
// the version and OS the daemon adds — a field the page adds is dropped.
func TestSupportForwardsExactlyTheReport(t *testing.T) {
	s, _, _, logs := supportServer(t)
	got := stubSupport(t, http.StatusOK)

	text := "The deck went blank after I pressed ⌘B — καλημέρα"
	body := `{"text":` + jsonString(text) + `,"email":" me@example.com ","screenshots":[` +
		`{"name":"C:\\Users\\me\\shot.png","type":"image/png","data":"` + b64(shotPNG) + `"},` +
		`{"name":"b.jpg","type":"image/jpeg","data":"` + b64(shotJPEG) + `"},` +
		`{"name":"c.webp","type":"image/webp","data":"` + b64(shotWEBP) + `"}],` +
		`"version":"9","os":"x","machine":"m","transcript":"secret"}`
	w := call(t, s, machine, "", "POST", "/v1/support", body)
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
		t.Fatalf("support: %d %s", w.Code, w.Body.String())
	}
	if w := call(t, s, machine, "", "POST", "/v1/support", `{"text":"short"}`); w.Code != http.StatusOK {
		t.Fatalf("text alone: %d %s", w.Code, w.Body.String())
	}
	bodies := got()
	if len(bodies) != 2 {
		t.Fatalf("site got %d bodies, want 2", len(bodies))
	}
	osArch := runtime.GOOS + "/" + runtime.GOARCH
	want := []map[string]any{
		{
			"text":  text,
			"email": "me@example.com",
			"screenshots": []any{
				map[string]any{"name": "shot.png", "type": "image/png", "data": b64(shotPNG)},
				map[string]any{"name": "b.jpg", "type": "image/jpeg", "data": b64(shotJPEG)},
				map[string]any{"name": "c.webp", "type": "image/webp", "data": b64(shotWEBP)},
			},
			"version": "1.2.3",
			"os":      osArch,
		},
		{"text": "short", "version": "1.2.3", "os": osArch},
	}
	for i := range want {
		if !reflect.DeepEqual(bodies[i], want[i]) {
			t.Errorf("site got %v,\nwant exactly %v", bodies[i], want[i])
		}
	}
	for _, secret := range []string{"blank", "καλημέρα", "me@example.com", b64(shotPNG)} {
		if strings.Contains(logs.String(), secret) {
			t.Errorf("the log holds %q: %s", secret, logs.String())
		}
	}
}

// Anything outside the limits is refused here and never reaches the site.
func TestSupportRefusesWhatIsOutsideTheLimits(t *testing.T) {
	s, _, _, logs := supportServer(t)
	got := stubSupport(t, http.StatusOK)
	shot := func(typ string, data []byte) string {
		return `{"name":"s","type":"` + typ + `","data":"` + b64(data) + `"}`
	}
	big := append(append([]byte{}, shotPNG...), make([]byte, 4<<20)...)   // over 4 MB
	three := append(append([]byte{}, shotPNG...), make([]byte, 3<<20)...) // 3 MB: three are over 8 MB together
	for name, body := range map[string]string{
		"empty body":     ``,
		"no text":        `{}`,
		"blank text":     `{"text":"  \n "}`,
		"text too long":  `{"text":"` + strings.Repeat("é", 8001) + `"}`,
		"bad email":      `{"text":"x","email":"not an address"}`,
		"named email":    `{"text":"x","email":"Name <a@b.co>"}`,
		"local email":    `{"text":"x","email":"a@localhost"}`,
		"long email":     `{"text":"x","email":"` + strings.Repeat("a", 250) + `@b.co"}`,
		"four shots":     `{"text":"x","screenshots":[` + strings.Repeat(shot("image/png", shotPNG)+",", 3) + shot("image/png", shotPNG) + `]}`,
		"gif":            `{"text":"x","screenshots":[` + shot("image/gif", []byte("GIF89a")) + `]}`,
		"type mismatch":  `{"text":"x","screenshots":[` + shot("image/png", shotJPEG) + `]}`,
		"not an image":   `{"text":"x","screenshots":[` + shot("image/jpeg", []byte("hello")) + `]}`,
		"empty shot":     `{"text":"x","screenshots":[{"name":"s","type":"image/png","data":""}]}`,
		"bad base64":     `{"text":"x","screenshots":[{"name":"s","type":"image/png","data":"@@@"}]}`,
		"shot over 4 MB": `{"text":"x","screenshots":[` + shot("image/png", big) + `]}`,
		"over 8 MB":      `{"text":"x","screenshots":[` + shot("image/png", three) + `,` + shot("image/png", three) + `,` + shot("image/png", three) + `]}`,
		"long name":      `{"text":"x","screenshots":[{"name":"` + strings.Repeat("n", 201) + `","type":"image/png","data":"` + b64(shotPNG) + `"}]}`,
	} {
		if w := call(t, s, machine, "", "POST", "/v1/support", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400 (%s)", name, w.Code, w.Body.String())
		}
	}
	// The limit is characters, not bytes: 8000 two-byte letters pass.
	if w := call(t, s, machine, "", "POST", "/v1/support", `{"text":"`+strings.Repeat("é", 8000)+`"}`); w.Code != http.StatusOK {
		t.Errorf("8000 characters: %d %s", w.Code, w.Body.String())
	}
	if n := len(got()); n != 1 {
		t.Fatalf("site got %d bodies, want only the valid one", n)
	}
	if logs.Len() != 0 {
		t.Errorf("refusals were logged: %s", logs.String())
	}
}

// A site that fails is a 502 with an error that names neither the text nor
// the address; nothing is retried.
func TestSupportReportsAFailure(t *testing.T) {
	s, _, _, _ := supportServer(t)
	got := stubSupport(t, http.StatusInternalServerError)
	w := call(t, s, machine, "", "POST", "/v1/support", `{"text":"private words","email":"me@example.com"}`)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("support: %d, want 502", w.Code)
	}
	var e struct{ Error string }
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil || e.Error == "" {
		t.Fatalf("502 body: %s", w.Body.String())
	}
	for _, leak := range []string{"private", "me@example.com", "127.0.0.1"} {
		if strings.Contains(e.Error, leak) {
			t.Errorf("error %q holds %q", e.Error, leak)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(got()); n != 1 {
		t.Fatalf("site got %d bodies, want exactly one (no retry)", n)
	}

	// And a site that cannot be reached at all.
	t.Setenv("CAPROCK_SUPPORT_URL", "http://127.0.0.1:1/api/support")
	if w := call(t, s, machine, "", "POST", "/v1/support", `{"text":"x"}`); w.Code != http.StatusBadGateway {
		t.Fatalf("unreachable: %d, want 502", w.Code)
	}
}

// A phone that controls may send a report; a viewer may not.
func TestSupportFromThePhone(t *testing.T) {
	s, viewer, controller, _ := supportServer(t)
	got := stubSupport(t, http.StatusOK)
	if w := call(t, s, testPhone, viewer, "POST", "/v1/support", `{"text":"from a viewer"}`); w.Code != http.StatusForbidden {
		t.Errorf("viewer: %d, want 403", w.Code)
	}
	if w := call(t, s, testPhone, controller, "POST", "/v1/support", `{"text":"from the phone"}`); w.Code != http.StatusOK {
		t.Fatalf("controller: %d %s", w.Code, w.Body.String())
	}
	bodies := got()
	if len(bodies) != 1 || bodies[0]["text"] != "from the phone" {
		t.Fatalf("site got %v", bodies)
	}
}
