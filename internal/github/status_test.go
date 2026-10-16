package github

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// statusPage is a fake githubstatus.com: it answers code with body, and
// records each request's headers.
type statusPage struct {
	mu      sync.Mutex
	code    int
	body    string
	headers []http.Header
}

func (p *statusPage) serve(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.headers = append(p.headers, r.Header.Clone())
	w.WriteHeader(p.code)
	_, _ = w.Write([]byte(p.body))
}

func (p *statusPage) set(code int, body string) {
	p.mu.Lock()
	p.code, p.body = code, body
	p.mu.Unlock()
}

func (p *statusPage) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.headers)
}

// The status page, once connected: one plain GET with no token or cookie,
// kept five minutes, and a failed read keeps the last answer with Error set
// and is not asked again for five minutes.
func TestStatusPageReadKeptAndFailed(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	page := &statusPage{}
	page.set(http.StatusOK, `{"status":{"indicator":"major","description":"Partial System Outage"},"components":[{"name":"API Requests","status":"partial_outage"},{"name":"Pages","status":"operational"}],"incidents":[{"name":"Elevated API errors","status":"investigating","impact":"major","shortlink":"https://stspg.io/y"}]}`)
	srv := httptest.NewServer(http.HandlerFunc(page.serve))
	t.Cleanup(srv.Close)
	x.s.StatusURL = srv.URL
	x.s.HTTP = srv.Client()
	ctx := context.Background()

	got, ok := x.s.StatusPage(ctx)
	if !ok || got.Indicator != "major" || got.Description != "Partial System Outage" || got.Error != "" || got.At != x.clock().UnixMilli() {
		t.Fatalf("first read = %+v %v", got, ok)
	}
	if len(got.Components) != 1 || got.Components[0].Name != "API Requests" || len(got.Incidents) != 1 || got.Incidents[0].URL != "https://stspg.io/y" {
		t.Fatalf("parts = %+v", got)
	}
	h := page.headers[0]
	if h.Get("Authorization") != "" || h.Get("Cookie") != "" {
		t.Fatalf("the status page was sent credentials: %v", h)
	}

	x.advance(4 * time.Minute)
	if again, _ := x.s.StatusPage(ctx); again.Indicator != "major" || page.count() != 1 {
		t.Fatalf("asked again within five minutes: %d requests", page.count())
	}

	x.advance(2 * time.Minute)
	page.set(http.StatusServiceUnavailable, `down`)
	failed, ok := x.s.StatusPage(ctx)
	if !ok || page.count() != 2 || failed.Indicator != "major" || !strings.Contains(failed.Error, "answered 503") {
		t.Fatalf("failed read = %+v (%d requests)", failed, page.count())
	}
	x.advance(time.Minute)
	if _, _ = x.s.StatusPage(ctx); page.count() != 2 {
		t.Fatal("a failed status page was asked again within five minutes")
	}
}
