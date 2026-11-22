package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A collection's list carries an ETag. Asked again with it while nothing was
// written, the answer is a 304 and nothing is read; every write, another page
// and a restart each give a tag the old one does not match.
func TestModuleDocListETag(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Alpha")
	if code := e.send(t, http.MethodPut, "/v1/admin", `{"key":"`+e.key(`"alpha"`)+`"}`, nil); code != 200 {
		t.Fatalf("set key: %d", code)
	}
	reads := 0
	listModuleDocs = func(ctx context.Context, q store.Querier, module, collection, after string, limit int) ([]store.ModuleDoc, error) {
		reads++
		return store.ListModuleDocs(ctx, q, module, collection, after, limit)
	}
	t.Cleanup(func() { listModuleDocs = store.ListModuleDocs })
	list := func(path, tag string) (int, string, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, e.srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if tag != "" {
			req.Header.Set("If-None-Match", tag)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusForbidden {
			if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
				t.Errorf("%s: Cache-Control %q", path, cc)
			}
		}
		return resp.StatusCode, resp.Header.Get("ETag"), string(b)
	}
	for _, d := range []string{"a", "b"} {
		if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/"+d, `{"x":1}`, nil); code != 200 {
			t.Fatalf("set %s: %d", d, code)
		}
	}
	const path = "/v1/x/alpha/docs/notes?limit=1000"
	code, tag, body := list(path, "")
	if code != 200 || tag == "" || !strings.Contains(body, `"id":"b"`) || reads != 1 {
		t.Fatalf("first list: %d %q %s, %d reads", code, tag, body, reads)
	}

	// Unchanged: a 304, no body, the same tag, and no read.
	for _, h := range []string{tag, "W/" + tag, `"other", ` + tag} {
		code, again, body := list(path, h)
		if code != http.StatusNotModified || again != tag || body != "" {
			t.Fatalf("If-None-Match %s: %d %q %q", h, code, again, body)
		}
	}
	if reads != 1 {
		t.Fatalf("an unchanged collection was read again: %d reads", reads)
	}

	// Another page, or the same rows asked for another way, is another tag.
	seen := map[string]bool{tag: true}
	for _, p := range []string{"/v1/x/alpha/docs/notes", "/v1/x/alpha/docs/notes?limit=1", "/v1/x/alpha/docs/notes?limit=1000&after=a"} {
		code, other, _ := list(p, tag)
		if code != 200 || seen[other] {
			t.Fatalf("%s with the first page's tag: %d %q", p, code, other)
		}
		seen[other] = true
	}
	// Another collection's writes do not move this one's tag.
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/other/z", `{}`, nil); code != 200 {
		t.Fatal(code)
	}
	if code, _, _ := list(path, tag); code != http.StatusNotModified {
		t.Fatalf("a write to another collection moved this one: %d", code)
	}

	// Every write moves it: a set, an update, a delete.
	for _, w := range []struct{ method, path, body string }{
		{http.MethodPut, "/v1/x/alpha/docs/notes/c", `{"y":2}`},
		{http.MethodPatch, "/v1/x/alpha/docs/notes/c", `{"y":3}`},
		{http.MethodDelete, "/v1/x/alpha/docs/notes/c", ``},
	} {
		if code := e.send(t, w.method, w.path, w.body, nil); code != 200 {
			t.Fatalf("%s %s: %d", w.method, w.path, code)
		}
		before := reads
		code, next, body := list(path, tag)
		if code != 200 || next == tag || reads != before+1 || !strings.Contains(body, `"docs"`) {
			t.Fatalf("after %s: %d %q, %d reads", w.method, code, next, reads-before)
		}
		tag = next
	}
	// The daemon's own writes move it too (a Telegram message, attention).
	if _, err := store.SetModuleDoc(context.Background(), e.st.DB(), "alpha", "notes", "t", []byte(`{}`), 2); err != nil {
		t.Fatal(err)
	}
	if code, next, _ := list(path, tag); code != 200 || next == tag {
		t.Fatalf("after the daemon's own write: %d", code)
	}

	// A tag from an earlier start: the same collection and generation under
	// another boot value never matches.
	_, tag, _ = list(path, "")
	parts := strings.SplitN(strings.Trim(tag, `"`), ".", 2)
	if len(parts) != 2 {
		t.Fatalf("tag %q", tag)
	}
	old := `"` + parts[0] + "x." + parts[1] + `"`
	if code, _, _ := list(path, old); code != 200 {
		t.Fatalf("a tag from before a restart matched: %d", code)
	}

	// Without the key, a matching tag is no way in.
	if code := e.send(t, http.MethodDelete, "/v1/admin", ``, nil); code != 200 {
		t.Fatal(code)
	}
	if code, _, _ := list(path, tag); code != http.StatusForbidden {
		t.Fatalf("a matching tag without the key: %d", code)
	}
}
