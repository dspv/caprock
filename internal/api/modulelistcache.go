package api

import (
	"container/list"
	"net/http"
	"strings"
	"sync"
	"time"
)

// moduleListCache keeps the answers to a private module's document lists by
// page, each with the tag it was read at. While the collection's generation
// holds (store.ModuleDocsVersion), the tag is the same and so is the page, so
// a client that asks again without If-None-Match is answered from here with
// nothing read.
//
// Why: the 0.188.0 ETag reached the clients that keep ETags — a browser, the
// Ops scripts while one runs — but most of the asking comes from short-lived
// processes that start with no tag. On the owner's Mac module lists were
// still ~7,100 an hour and 37% of all the daemon's disk reads (744 MB in 11
// minutes, the 2026-11-24 audit).
//
// Bounded by bytes: the least recently answered pages go first, and a page
// larger than a quarter of the budget is never kept.
type moduleListCache struct {
	mu    sync.Mutex
	max   int
	size  int
	order *list.List // of *moduleListPage, most recent first
	pages map[string]*list.Element
	// seen is when each client was last logged as asking (logAsker).
	seen map[string]time.Time
}

type moduleListPage struct {
	key, tag string
	body     []byte
}

// moduleListCacheBytes is the cache's budget. The owner's Ops module lists
// about 26 MB in all, 21 MB of it one collection in twelve pages of 1.3–2.1
// MB each (2026-11-24). A machine with no module keeps nothing.
const moduleListCacheBytes = 32 << 20

func newModuleListCache(max int) *moduleListCache {
	return &moduleListCache{max: max, order: list.New(), pages: map[string]*list.Element{}, seen: map[string]time.Time{}}
}

// get returns the page kept under key when it was read at tag.
func (c *moduleListCache) get(key, tag string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.pages[key]
	if !ok {
		return nil, false
	}
	p := el.Value.(*moduleListPage)
	if p.tag != tag {
		// The collection moved on: this page will never be asked for again.
		c.remove(el)
		return nil, false
	}
	c.order.MoveToFront(el)
	return p.body, true
}

// put keeps a page read at tag.
func (c *moduleListCache) put(key, tag string, body []byte) {
	if c == nil || len(body) > c.max/4 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.pages[key]; ok {
		c.remove(el)
	}
	c.pages[key] = c.order.PushFront(&moduleListPage{key: key, tag: tag, body: body})
	c.size += len(body)
	for c.size > c.max {
		c.remove(c.order.Back())
	}
}

func (c *moduleListCache) remove(el *list.Element) {
	p := el.Value.(*moduleListPage)
	c.order.Remove(el)
	delete(c.pages, p.key)
	c.size -= len(p.body)
}

// moduleAskerEvery is how often one client's list reads are logged.
const moduleAskerEvery = 10 * time.Minute

// logAsker reports whether a list read by this client should be logged now:
// once per client per moduleAskerEvery, so the log says who asks without a
// line per request.
func (c *moduleListCache) logAsker(client string, now time.Time) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if at, ok := c.seen[client]; ok && now.Sub(at) < moduleAskerEvery {
		return false
	}
	if len(c.seen) > 256 {
		for k, at := range c.seen {
			if now.Sub(at) >= moduleAskerEvery {
				delete(c.seen, k)
			}
		}
	}
	c.seen[client] = now
	return true
}

// moduleAsker names the client of a list read for the debug log: the user
// agent's first word (a browser, Python's urllib, curl), whether it is a
// paired device, and whether it sent a tag.
func moduleAsker(r *http.Request) string {
	ua := r.UserAgent()
	if i := strings.IndexByte(ua, ' '); i > 0 {
		ua = ua[:i]
	}
	if ua == "" {
		ua = "no user agent"
	}
	where := "local"
	if !isLocal(r) {
		where = "device"
	}
	tagged := "without a tag"
	if r.Header.Get("If-None-Match") != "" {
		tagged = "with a tag"
	}
	return ua + ", " + where + ", " + tagged
}
