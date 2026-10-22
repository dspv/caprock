package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
)

// testClock is a clock a test moves by hand.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func attentionOf(t *testing.T, e *env) *ModuleAttention {
	t.Helper()
	var st AdminState
	if code := e.send(t, http.MethodGet, "/v1/admin", "", &st); code != 200 {
		t.Fatalf("admin: %d", code)
	}
	for _, m := range st.Installed {
		if m.ID == "alpha" {
			return m.Attention
		}
	}
	t.Fatalf("alpha is not listed: %+v", st.Installed)
	return nil
}

// A keyed module reports what waits; the admin state carries it, a frame says
// so, and count 0 clears it.
func TestAModuleReportsAttention(t *testing.T) {
	clock := &testClock{t: time.UnixMilli(1_700_000_000_000)}
	e := newModuleEnv(t, func(d *Deps) { d.Now = clock.now })
	e.install(t, "alpha", "Ops")
	e.admin.key = e.key(`"alpha"`)
	sub := e.api.d.Bus.Subscribe(8)
	defer sub.Unsubscribe()

	if a := attentionOf(t, e.env); a != nil {
		t.Fatalf("attention before any report: %+v", a)
	}
	var got ModuleAttention
	body := `{"count":2,"items":[{"label":" Review PR 42 ","href":"#review/42"},{"label":"Approve deploy","href":"#deploy"}]}`
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", body, &got); code != 200 {
		t.Fatalf("put: %d", code)
	}
	if got.Count != 2 || len(got.Items) != 2 || got.Items[0].Label != "Review PR 42" || got.UpdatedAt != clock.now().UnixMilli() {
		t.Fatalf("kept %+v", got)
	}
	select {
	case f := <-sub.C:
		if f.Type != bus.FrameAdmin {
			t.Fatalf("frame %s", f.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("no admin frame")
	}
	if a := attentionOf(t, e.env); a == nil || a.Count != 2 || a.Items[1].Href != "#deploy" {
		t.Fatalf("admin state: %+v", a)
	}

	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", `{"count":0,"items":[{"label":"x","href":"#x"}]}`, &got); code != 200 || got.Count != 0 {
		t.Fatalf("clear: %d %+v", code, got)
	}
	if a := attentionOf(t, e.env); a != nil {
		t.Fatalf("after clear: %+v", a)
	}
}

// Anything but a sane report is refused, and a refused one changes nothing.
func TestModuleAttentionIsChecked(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Ops")
	e.admin.key = e.key(`"alpha"`)
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", `{"count":1,"items":[{"label":"ok","href":"#ok"}]}`, nil); code != 200 {
		t.Fatalf("a good report: %d", code)
	}
	items := func(n int) string {
		parts := make([]string, n)
		for i := range parts {
			parts[i] = `{"label":"l","href":"#h"}`
		}
		return `{"count":9,"items":[` + strings.Join(parts, ",") + `]}`
	}
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", items(8), nil); code != 200 {
		t.Errorf("eight items: %d", code)
	}
	long := strings.Repeat("é", 81)
	for name, body := range map[string]string{
		"nine items":       items(9),
		"negative count":   `{"count":-1}`,
		"long label":       `{"count":1,"items":[{"label":"` + long + `","href":"#a"}]}`,
		"empty label":      `{"count":1,"items":[{"label":"  ","href":"#a"}]}`,
		"absolute url":     `{"count":1,"items":[{"label":"a","href":"https://example.com/#a"}]}`,
		"protocol":         `{"count":1,"items":[{"label":"a","href":"javascript:alert(1)"}]}`,
		"bare hash":        `{"count":1,"items":[{"label":"a","href":"#"}]}`,
		"space in href":    `{"count":1,"items":[{"label":"a","href":"#a b"}]}`,
		"newline in label": `{"count":1,"items":[{"label":"a\nb","href":"#a"}]}`,
		"unknown field":    `{"count":1,"note":"x"}`,
		"not json":         `count=1`,
	} {
		if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", body, nil); code != 400 {
			t.Errorf("%s: %d", name, code)
		}
	}
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", `{"count":1,"items":[{"label":"`+strings.Repeat("é", 80)+`","href":"#a"}]}`, nil); code != 200 {
		t.Errorf("an 80-character label: %d", code)
	}
	if a := attentionOf(t, e.env); a == nil || a.Count != 1 {
		t.Fatalf("a refused report changed what is kept: %+v", a)
	}
}

// Only a module the admin key names may report, and only an installed one.
func TestModuleAttentionNeedsTheKey(t *testing.T) {
	e := newModuleEnv(t)
	e.install(t, "alpha", "Ops")
	e.install(t, "beta", "Beta")
	body := `{"count":1}`
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", body, nil); code != 403 {
		t.Fatalf("without a key: %d", code)
	}
	e.admin.key = e.key(`"alpha","gamma"`)
	if code := e.send(t, http.MethodPut, "/v1/x/beta/attention", body, nil); code != 403 {
		t.Errorf("a module the key does not name: %d", code)
	}
	if code := e.send(t, http.MethodPut, "/v1/x/gamma/attention", body, nil); code != 404 {
		t.Errorf("named but not installed: %d", code)
	}
	if !controllerRoutes["PUT /v1/x/{id}/attention"] {
		t.Error("attention is not a controller route, like the module's store")
	}
}

// It survives a restart (a new server on the same database), and a report
// no newer than a day stops showing after one.
func TestModuleAttentionPersistsAndExpires(t *testing.T) {
	clock := &testClock{t: time.UnixMilli(1_700_000_000_000)}
	e := newModuleEnv(t, func(d *Deps) { d.Now = clock.now })
	e.install(t, "alpha", "Ops")
	e.admin.key = e.key(`"alpha"`)
	if code := e.send(t, http.MethodPut, "/v1/x/alpha/attention", `{"count":3,"items":[{"label":"Review","href":"#r"}]}`, nil); code != 200 {
		t.Fatalf("put: %d", code)
	}

	d := e.api.d
	d.Bus = bus.New()
	srv := httptest.NewServer(New(d))
	t.Cleanup(srv.Close)
	again := &env{srv: srv, st: e.st}
	if a := attentionOf(t, again); a == nil || a.Count != 3 || len(a.Items) != 1 || a.Items[0].Href != "#r" {
		t.Fatalf("after a restart: %+v", a)
	}

	clock.add(23 * time.Hour)
	if a := attentionOf(t, again); a == nil {
		t.Fatal("gone before a day")
	}
	clock.add(2 * time.Hour)
	if a := attentionOf(t, again); a != nil {
		t.Fatalf("still shown after a day without a report: %+v", a)
	}
	if code := again.send(t, http.MethodPut, "/v1/x/alpha/attention", `{"count":1}`, nil); code != 200 {
		t.Fatalf("a fresh report: %d", code)
	}
	if a := attentionOf(t, again); a == nil || a.Count != 1 || len(a.Items) != 0 {
		t.Fatalf("a fresh report: %+v", a)
	}
}
