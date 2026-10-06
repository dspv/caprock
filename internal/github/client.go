// Package github is Caprock's GitHub integration (F14, .ai/21-app.md
// § GitHub): a small REST client in the daemon, the token sources it may use,
// the OAuth device flow, and the pull-request state each worktree shows.
//
// The token never leaves the daemon. It is sent to the API host and nowhere
// else — not to git (a push uses the user's own credentials, through the
// Changes push), not to the interface, not to a log. Requests are
// conditional (ETag), so an unchanged answer is a 304 GitHub does not count;
// the rate-limit headers are read on every answer, and once a limit is hit
// nothing is asked until it lifts.
package github

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultAPI and DefaultWeb are the only hosts the token or the device flow
// ever reach. Tests point a Client elsewhere (Service.API), and the daemon
// admits an override only for a loopback address (internal/daemon).
const (
	DefaultAPI = "https://api.github.com"
	DefaultWeb = "https://github.com"
)

// maxBody is the most of one answer read; a page of 100 check runs is far below.
const maxBody = 8 << 20

// maxCached bounds the ETag cache.
const maxCached = 512

// Rate is the last rate-limit reading, per resource ("core", "search").
type Rate struct {
	Resource  string `json:"resource"`
	Limit     int    `json:"limit"`
	Remaining int    `json:"remaining"`
	ResetAt   int64  `json:"reset_at"` // unix ms
	Used      int    `json:"used"`
}

// cached is one conditional answer kept for its ETag.
type cached struct {
	etag   string
	body   []byte
	header http.Header
	at     time.Time
}

// client is the REST client. A Service owns one.
type client struct {
	base string
	http *http.Client
	now  func() time.Time

	mu      sync.Mutex
	cache   map[string]cached
	rates   map[string]Rate
	blocked map[string]time.Time // resource -> no request before
}

func newClient(base string, hc *http.Client, now func() time.Time) *client {
	return &client{base: strings.TrimRight(base, "/"), http: hc, now: now, cache: map[string]cached{}, rates: map[string]Rate{}, blocked: map[string]time.Time{}}
}

// request is one call.
type request struct {
	method string
	path   string // "/user/repos?page=2", or a full URL on the API host
	body   any
	doing  string // what the person would call it: "Listing your repositories"
	token  string
	source string // where the token came from, for the 401 hint
}

// response is one answer: the body, and whether it came from the cache (304).
type response struct {
	status    int
	header    http.Header
	body      []byte
	notModded bool
}

// resourceOf is the rate-limit bucket a path draws on.
func resourceOf(path string) string {
	if strings.HasPrefix(path, "/search/") {
		return "search"
	}
	return "core"
}

// cacheKey ties an answer to the token that read it, so another account
// never sees it, without keeping the token itself.
func cacheKey(token, u string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:6]) + " " + u
}

// do sends one request and returns the answer, or an Error.
func (c *client) do(ctx context.Context, r request) (response, *Error) {
	now := c.now()
	res := resourceOf(r.path)
	c.mu.Lock()
	until := c.blocked[res]
	c.mu.Unlock()
	if until.After(now) {
		return response{}, &Error{Kind: KindRateLimit, Doing: r.doing, RetryAt: until.UnixMilli(), At: now.UnixMilli(),
			Message: fmt.Sprintf("GitHub's rate limit is in force; Caprock waits until %s before asking again.", until.Local().Format("15:04:05"))}
	}
	u := r.path
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		u = c.base + r.path
	} else if !strings.HasPrefix(u, c.base+"/") {
		// A Link header naming another host: never send the token there.
		return response{}, errorf(KindGitHub, r.doing, "GitHub pointed to %s, which is not the API host; not followed", hostOf(u))
	}
	var body io.Reader
	if r.body != nil {
		b, err := json.Marshal(r.body)
		if err != nil {
			return response{}, errorf(KindInvalid, r.doing, "could not encode the request: %v", err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, r.method, u, body)
	if err != nil {
		return response{}, errorf(KindInvalid, r.doing, "bad request: %v", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "caprock")
	if r.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.token)
	}
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	key := cacheKey(r.token, u)
	var prev cached
	if r.method == http.MethodGet {
		c.mu.Lock()
		prev = c.cache[key]
		c.mu.Unlock()
		if prev.etag != "" {
			req.Header.Set("If-None-Match", prev.etag)
		}
	}
	hr, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil && errors.Is(err, context.Canceled) {
			return response{}, errorf(KindNetwork, r.doing, "cancelled")
		}
		return response{}, errorf(KindNetwork, r.doing, "could not reach GitHub (%s): %s. Check the connection; Caprock tries again later.", hostOf(u), netReason(err))
	}
	defer hr.Body.Close()
	b, err := io.ReadAll(io.LimitReader(hr.Body, maxBody))
	if err != nil {
		return response{}, errorf(KindNetwork, r.doing, "the answer from GitHub was cut off: %s", netReason(err))
	}
	c.noteRate(res, hr.Header)
	if hr.StatusCode == http.StatusNotModified && prev.etag != "" {
		return response{status: http.StatusOK, header: prev.header, body: prev.body, notModded: true}, nil
	}
	if hr.StatusCode < 200 || hr.StatusCode > 299 {
		e := classify(hr, b, r.doing, r.source, now)
		if e.Kind == KindRateLimit {
			c.mu.Lock()
			c.blocked[res] = time.UnixMilli(e.RetryAt)
			c.mu.Unlock()
		}
		return response{}, e
	}
	if et := hr.Header.Get("ETag"); et != "" && r.method == http.MethodGet {
		c.mu.Lock()
		if len(c.cache) >= maxCached {
			c.evictOldest()
		}
		c.cache[key] = cached{etag: et, body: b, header: hr.Header.Clone(), at: now}
		c.mu.Unlock()
	}
	return response{status: hr.StatusCode, header: hr.Header, body: b}, nil
}

// evictOldest drops the oldest cached answer. Called with mu held.
func (c *client) evictOldest() {
	var oldest string
	var at time.Time
	for k, v := range c.cache {
		if oldest == "" || v.at.Before(at) {
			oldest, at = k, v.at
		}
	}
	delete(c.cache, oldest)
}

// noteRate keeps the rate-limit headers of an answer.
func (c *client) noteRate(res string, h http.Header) {
	limit, err1 := strconv.Atoi(h.Get("X-RateLimit-Limit"))
	remaining, err2 := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	if err1 != nil || err2 != nil {
		return
	}
	reset, _ := strconv.ParseInt(h.Get("X-RateLimit-Reset"), 10, 64)
	used, _ := strconv.Atoi(h.Get("X-RateLimit-Used"))
	if r := h.Get("X-RateLimit-Resource"); r != "" {
		res = r
	}
	c.mu.Lock()
	c.rates[res] = Rate{Resource: res, Limit: limit, Remaining: remaining, ResetAt: reset * 1000, Used: used}
	c.mu.Unlock()
}

// rate is the core reading, and when requests are paused (0 when not).
func (c *client) rate() (Rate, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var paused int64
	for _, t := range c.blocked {
		if t.After(c.now()) && t.UnixMilli() > paused {
			paused = t.UnixMilli()
		}
	}
	return c.rates["core"], paused
}

// forget drops every cached answer and rate reading (on disconnect).
func (c *client) forget() {
	c.mu.Lock()
	c.cache = map[string]cached{}
	c.rates = map[string]Rate{}
	c.blocked = map[string]time.Time{}
	c.mu.Unlock()
}

// forgetCache drops the cached answers (a new token), keeping the rate
// readings the connecting call just made.
func (c *client) forgetCache() {
	c.mu.Lock()
	c.cache = map[string]cached{}
	c.mu.Unlock()
}

// hostOf is a URL's host, for a message.
func hostOf(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return u
	}
	return p.Host
}

// netReason is a network error without the URL Go repeats in it.
func netReason(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

// nextLink is the rel="next" URL of a Link header, "" when there is none.
func nextLink(h http.Header) string {
	for _, part := range strings.Split(h.Get("Link"), ",") {
		seg := strings.Split(part, ";")
		if len(seg) < 2 {
			continue
		}
		for _, p := range seg[1:] {
			if strings.TrimSpace(p) == `rel="next"` {
				return strings.Trim(strings.TrimSpace(seg[0]), "<>")
			}
		}
	}
	return ""
}

// decode reads a JSON answer into v.
func decode(r response, doing string, v any) *Error {
	if err := json.Unmarshal(r.body, v); err != nil {
		return errorf(KindGitHub, doing, "GitHub's answer could not be read: %v", err)
	}
	return nil
}
