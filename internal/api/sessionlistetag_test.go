package api

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// The session list carries an ETag; asked again with it while nothing
// changed, the answer is a 304 with no body. A new event is a new tag.
func TestSessionListETag(t *testing.T) {
	e := newEnv(t)
	hookPost(t, e, `{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"t1","cwd":"/p"}`)
	list := func(tag string) (int, string, string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/sessions", nil)
		if tag != "" {
			req.Header.Set("If-None-Match", tag)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
			t.Errorf("Cache-Control %q", cc)
		}
		if resp.Header.Get("X-Total-Count") == "" {
			t.Error("no X-Total-Count")
		}
		return resp.StatusCode, resp.Header.Get("ETag"), string(b)
	}
	code, tag, body := list("")
	if code != 200 || tag == "" || !strings.Contains(body, `"s1"`) {
		t.Fatalf("first: %d %q %s", code, tag, body)
	}
	if code, again, body := list(tag); code != http.StatusNotModified || again != tag || body != "" {
		t.Fatalf("unchanged: %d %q %q", code, again, body)
	}
	if code, _, _ := list(`"other"`); code != 200 {
		t.Fatalf("another tag: %d", code)
	}
	hookPost(t, e, `{"session_id":"s2","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/p/a"},"tool_use_id":"t2","cwd":"/p"}`)
	if code, next, body := list(tag); code != 200 || next == tag || !strings.Contains(body, `"s2"`) {
		t.Fatalf("after a new session: %d %q", code, next)
	}
}
