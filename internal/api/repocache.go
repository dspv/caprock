package api

import (
	"context"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/gitremote"
)

// repoTTL is how long a directory's repository answer is reused. The session
// page polls every 5 s and the Projects panel every 30 s, and each answer is a
// few `git` processes; a remote or a branch changes far less often than that.
const repoTTL = time.Minute

// repoCache answers gitremote.Lookup per directory, at most once per repoTTL.
type repoCache struct {
	mu sync.Mutex
	m  map[string]repoEntry
	// lookup is gitremote.Lookup; replaceable in tests.
	lookup func(ctx context.Context, dir string) (gitremote.Repo, bool)
	now    func() time.Time
}

type repoEntry struct {
	at   time.Time
	repo gitremote.Repo
	ok   bool
}

func newRepoCache() *repoCache {
	return &repoCache{m: map[string]repoEntry{}, lookup: gitremote.Lookup, now: time.Now}
}

// get returns the directory's repository, or ok=false when it is not in one.
// The lock is not held across git: two first requests for one directory may
// both run it, which is cheaper than serialising every directory behind one.
func (c *repoCache) get(ctx context.Context, dir string) (gitremote.Repo, bool) {
	if dir == "" {
		return gitremote.Repo{}, false
	}
	c.mu.Lock()
	e, hit := c.m[dir]
	c.mu.Unlock()
	if hit && c.now().Sub(e.at) < repoTTL {
		return e.repo, e.ok
	}
	r, ok := c.lookup(ctx, dir)
	c.mu.Lock()
	if len(c.m) > 500 { // bounded: directories come from the user's own sessions
		c.m = map[string]repoEntry{}
	}
	c.m[dir] = repoEntry{at: c.now(), repo: r, ok: ok}
	c.mu.Unlock()
	return r, ok
}
