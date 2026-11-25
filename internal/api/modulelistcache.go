package api

import (
	"container/list"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// moduleListCache keeps the answers to a private module's document lists by
// page, each with the collection's mark it was read at and the ids it covers.
// While no write since that mark touched a document the page covers
// (store.ModuleDocsPageCurrent), the page is what a read would give, so a
// client that asks again — with the page's tag or without one — is answered
// from here with nothing read.
//
// Why: the 0.188.0 ETag reached the clients that keep ETags — a browser, the
// Ops scripts while one runs — but most of the asking comes from short-lived
// processes that start with no tag. On the owner's Mac module lists were
// still ~7,100 an hour and 37% of all the daemon's disk reads (744 MB in 11
// minutes, the 2026-11-24 audit).
//
// By page, not by collection, since 2026-11-25: the owner's busiest
// collection, twelve pages, takes about 2,000 writes an hour, all to
// documents on two of its pages, and with a tag for the whole collection
// every write sent all twelve back to the database. That was still 1.44 GB
// of the daemon's 5.2 GB of disk reads in an hour.
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

// moduleListPage is one page of a collection's list as it was read.
type moduleListPage struct {
	key                 string
	module, coll, after string
	limit               int
	mark                store.ModuleDocsMark
	// last is the page's last id; full whether it held limit documents
	// (store.ModuleDocsPageCurrent).
	last string
	full bool
	body []byte
}

// tag is the page's ETag (moduleListTag at the mark it was read at).
func (p *moduleListPage) tag() string {
	return moduleListTag(p.module, p.coll, p.after, p.limit, p.mark)
}

// moduleListCacheBytes is the cache's budget. The owner's Ops module lists
// about 26 MB in all, 21 MB of it one collection in twelve pages of 1.3–2.1
// MB each (2026-11-24). A machine with no module keeps nothing.
const moduleListCacheBytes = 32 << 20

func newModuleListCache(max int) *moduleListCache {
	return &moduleListCache{max: max, order: list.New(), pages: map[string]*list.Element{}, seen: map[string]time.Time{}}
}

// get returns the page kept under key while it is current.
func (c *moduleListCache) get(key string) (*moduleListPage, bool) {
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
	if !store.ModuleDocsPageCurrent(p.module, p.coll, p.mark, p.after, p.last, p.full) {
		// A write changed it: this page will never be answered again.
		c.remove(el)
		return nil, false
	}
	c.order.MoveToFront(el)
	return p, true
}

// put keeps a page.
func (c *moduleListCache) put(p *moduleListPage) {
	if c == nil || len(p.body) > c.max/4 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.pages[p.key]; ok {
		c.remove(el)
	}
	c.pages[p.key] = c.order.PushFront(p)
	c.size += len(p.body)
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
