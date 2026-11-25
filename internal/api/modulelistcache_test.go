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

// A write reads again only the pages that cover the document it wrote: an
// update on the second page leaves the first page's tag and bytes as they
// were, a new document past the last full page changes only the page after
// it, and one between two pages only the page whose ids it falls among.
func TestModuleDocListByPage(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Alpha")
	if code := e.send(t, http.MethodPut, "/v1/admin", `{"key":"`+e.key(`"alpha"`)+`"}`, nil); code != 200 {
		t.Fatalf("set key: %d", code)
	}
	reads := map[string]int{}
	listModuleDocs = func(ctx context.Context, q store.Querier, module, collection, after string, limit int) ([]store.ModuleDoc, error) {
		reads[after]++
		return store.ListModuleDocs(ctx, q, module, collection, after, limit)
	}
	t.Cleanup(func() { listModuleDocs = store.ListModuleDocs })
	get := func(after, tag string) (int, string, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, e.srv.URL+"/v1/x/alpha/docs/notes?limit=2&after="+after, nil)
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
		return resp.StatusCode, resp.Header.Get("ETag"), string(b)
	}
	put := func(method, doc, body string) {
		t.Helper()
		if code := e.send(t, method, "/v1/x/alpha/docs/notes/"+doc, body, nil); code != 200 {
			t.Fatalf("%s %s: %d", method, doc, code)
		}
	}
	for _, d := range []string{"a", "b", "c", "d"} {
		put(http.MethodPut, d, `{"x":"`+d+`"}`)
	}
	pages := []string{"", "b", "d"} // [a b] [c d] [] (the last one not full)
	tags, bodies := map[string]string{}, map[string]string{}
	for _, p := range pages {
		code, tag, body := get(p, "")
		if code != 200 || reads[p] != 1 {
			t.Fatalf("page after %q: %d, %d reads", p, code, reads[p])
		}
		tags[p], bodies[p] = tag, body
	}
	// check asks every page with and without its tag, and wants a read only
	// for the pages in changed.
	check := func(what string, changed ...string) {
		t.Helper()
		before := map[string]int{}
		for k, v := range reads {
			before[k] = v
		}
		for _, p := range pages {
			moved := false
			for _, c := range changed {
				moved = moved || c == p
			}
			code, tag, body := get(p, tags[p])
			switch {
			case moved && (code != 200 || tag == tags[p] || reads[p] != before[p]+1):
				t.Fatalf("%s: page after %q was not read again: %d, %d reads", what, p, code, reads[p]-before[p])
			case !moved && (code != http.StatusNotModified || tag != tags[p]):
				t.Fatalf("%s: unchanged page after %q: %d %q", what, p, code, tag)
			}
			if moved {
				tags[p], bodies[p] = tag, body
			}
			code, tag, body = get(p, "")
			if code != 200 || tag != tags[p] || body != bodies[p] {
				t.Fatalf("%s: page after %q without a tag: %d", what, p, code)
			}
		}
		for _, p := range pages {
			want := before[p]
			for _, c := range changed {
				if c == p {
					want++
				}
			}
			if reads[p] != want {
				t.Fatalf("%s: page after %q read %d times, want %d", what, p, reads[p]-before[p], want-before[p])
			}
		}
	}
	put(http.MethodPatch, "c", `{"x":"c2"}`)
	check("an update on the second page", "b")
	if !strings.Contains(bodies["b"], `"c2"`) {
		t.Fatalf("the second page after its update: %s", bodies["b"])
	}
	put(http.MethodPut, "e", `{"x":"e"}`)
	check("a new document past the last full page", "d")
	put(http.MethodPut, "bb", `{"x":"bb"}`)
	check("a new document between the first two pages", "b")
	put(http.MethodDelete, "a", ``)
	check("a delete on the first page", "")
}

// A page is current while no write touches an id it covers: up to its last
// id when full, every id after `after` when not; a whole-collection touch, a
// mark from another start and one older than the writes kept are not.
func TestModuleDocsPageCurrent(t *testing.T) {
	const m, c = "page-current", "notes"
	mark := store.ModuleDocsMarkNow(m, c)
	if !store.ModuleDocsPageCurrent(m, c, mark, "", "k", true) {
		t.Fatal("an unwritten collection's page is not current")
	}
	store.TouchModuleDoc(m, c, "z")
	if !store.ModuleDocsPageCurrent(m, c, mark, "", "k", true) {
		t.Fatal("a write past a full page's last id changed it")
	}
	if store.ModuleDocsPageCurrent(m, c, mark, "", "k", false) {
		t.Fatal("a write after a page that was not full left it current")
	}
	if !store.ModuleDocsPageCurrent(m, c, mark, "z", "", false) {
		t.Fatal("a write of the page's own after id, which it does not hold, was taken as a change")
	}
	mark = store.ModuleDocsMarkNow(m, c)
	store.TouchModuleDoc(m, c, "k")
	if store.ModuleDocsPageCurrent(m, c, mark, "", "k", true) {
		t.Fatal("a write of the page's last id left it current")
	}
	if !store.ModuleDocsPageCurrent(m, c, mark, "k", "p", true) {
		t.Fatal("a write of the previous page's last id changed the next page")
	}
	mark = store.ModuleDocsMarkNow(m, c)
	store.TouchModuleDocs(m, c)
	if store.ModuleDocsPageCurrent(m, c, mark, "x", "y", true) {
		t.Fatal("a whole-collection touch left a page current")
	}
	mark = store.ModuleDocsMarkNow(m, c)
	if store.ModuleDocsPageCurrent(m, c, store.ModuleDocsMark{Boot: mark.Boot + 1, Gen: mark.Gen}, "", "", false) {
		t.Fatal("a mark from another start was current")
	}
	for range 600 {
		store.TouchModuleDoc(m, c, "z")
	}
	if store.ModuleDocsPageCurrent(m, c, mark, "", "k", true) {
		t.Fatal("a mark older than the writes kept was current")
	}
}

// The cache keeps the newest pages within its budget, drops a page a write
// changed, and never keeps one bigger than a quarter of it.
func TestModuleListCacheBounds(t *testing.T) {
	const m, coll = "cache-bounds", "notes"
	c := newModuleListCache(100)
	page := func(key string, n int) *moduleListPage {
		// Each page covers only its own key, as a full page would.
		return &moduleListPage{key: key, module: m, coll: coll, after: key, last: key + "~", full: true,
			limit: 1, mark: store.ModuleDocsMarkNow(m, coll), body: make([]byte, n)}
	}
	c.put(page("a", 20))
	c.put(page("b", 20))
	if _, ok := c.get("a"); !ok {
		t.Fatal("a kept page was not found")
	}
	store.TouchModuleDoc(m, coll, "b-")
	if _, ok := c.get("a"); !ok {
		t.Fatal("a write to another page dropped this one")
	}
	if _, ok := c.get("b"); ok || c.size != 20 {
		t.Fatalf("a page a write changed was kept (size %d)", c.size)
	}
	c.put(page("big", 26))
	if _, ok := c.get("big"); ok {
		t.Fatal("a page over a quarter of the budget was kept")
	}
	for _, k := range []string{"c", "d", "e", "f", "g"} {
		c.put(page(k, 20))
	}
	if c.size > 100 {
		t.Fatalf("size %d over the budget", c.size)
	}
	if _, ok := c.get("a"); ok {
		t.Fatal("the least recently used page outlived the budget")
	}
	if _, ok := c.get("g"); !ok {
		t.Fatal("the newest page was dropped")
	}
	t0 := time.Unix(0, 0)
	if !c.logAsker("x", t0) || c.logAsker("x", t0.Add(time.Minute)) || !c.logAsker("x", t0.Add(moduleAskerEvery)) {
		t.Fatal("a client is logged once per moduleAskerEvery")
	}
}
