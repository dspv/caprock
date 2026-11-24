package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// A client that asks again without If-None-Match — a fresh script, a page
// that keeps no ETags — gets the same page from memory while the collection
// is unchanged, and nothing is read; a write reads it again once.
func TestModuleDocListServedFromMemory(t *testing.T) {
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
	get := func(path string) (int, string, string) {
		t.Helper()
		resp, err := http.Get(e.srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if ct := resp.Header.Get("Content-Type"); resp.StatusCode == 200 && !strings.HasPrefix(ct, "application/json") {
			t.Errorf("Content-Type %q", ct)
		}
		return resp.StatusCode, resp.Header.Get("ETag"), string(b)
	}
	for _, d := range []string{"a", "b", "c"} {
		if code := e.send(t, http.MethodPut, "/v1/x/alpha/docs/notes/"+d, `{"x":"`+d+`"}`, nil); code != 200 {
			t.Fatalf("set %s: %d", d, code)
		}
	}
	const path = "/v1/x/alpha/docs/notes?limit=2"
	code, tag, first := get(path)
	if code != 200 || reads != 1 || !strings.Contains(first, `"next":"b"`) {
		t.Fatalf("first list: %d %s, %d reads", code, first, reads)
	}
	for i := 0; i < 5; i++ {
		code, again, body := get(path)
		if code != 200 || again != tag || body != first {
			t.Fatalf("asked again: %d %q %s", code, again, body)
		}
	}
	if reads != 1 {
		t.Fatalf("an unchanged page was read %d times", reads)
	}
	// The next page is its own page.
	if code, _, body := get(path + "&after=b"); code != 200 || !strings.Contains(body, `"id":"c"`) || reads != 2 {
		t.Fatalf("next page: %d %s, %d reads", code, body, reads)
	}
	// A write: read again once, and the new page is what is answered.
	if code := e.send(t, http.MethodPatch, "/v1/x/alpha/docs/notes/a", `{"x":"changed"}`, nil); code != 200 {
		t.Fatal(code)
	}
	code, next, body := get(path)
	if code != 200 || next == tag || !strings.Contains(body, `"changed"`) || reads != 3 {
		t.Fatalf("after a write: %d %q %s, %d reads", code, next, body, reads)
	}
	if _, _, again := get(path); again != body || reads != 3 {
		t.Fatalf("after a write, asked again: %d reads", reads)
	}
}

// The cache keeps the newest pages within its budget, drops a page whose
// collection moved on, and never keeps one bigger than a quarter of it.
func TestModuleListCacheBounds(t *testing.T) {
	c := newModuleListCache(100)
	c.put("a", "t1", make([]byte, 20))
	c.put("b", "t1", make([]byte, 20))
	if _, ok := c.get("a", "t1"); !ok {
		t.Fatal("a kept page was not found")
	}
	if _, ok := c.get("a", "t2"); ok {
		t.Fatal("a page was answered for another tag")
	}
	if _, ok := c.get("a", "t1"); ok || c.size != 20 {
		t.Fatalf("a page whose tag moved on was kept (size %d)", c.size)
	}
	c.put("big", "t1", make([]byte, 26))
	if _, ok := c.get("big", "t1"); ok {
		t.Fatal("a page over a quarter of the budget was kept")
	}
	for _, k := range []string{"c", "d", "e", "f", "g"} {
		c.put(k, "t1", make([]byte, 20))
	}
	if c.size > 100 {
		t.Fatalf("size %d over the budget", c.size)
	}
	if _, ok := c.get("b", "t1"); ok {
		t.Fatal("the least recently used page outlived the budget")
	}
	if _, ok := c.get("g", "t1"); !ok {
		t.Fatal("the newest page was dropped")
	}
	t0 := time.Unix(0, 0)
	if !c.logAsker("x", t0) || c.logAsker("x", t0.Add(time.Minute)) || !c.logAsker("x", t0.Add(moduleAskerEvery)) {
		t.Fatal("a client is logged once per moduleAskerEvery")
	}
}
