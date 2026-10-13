package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/store"
)

func TestMaskKey(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", ""},
		{"short", "…"},
		{"sk-0123456789abcd", "sk-…abcd"},
		{"sk-ζζζζζζζζζζζζζζζζ1a2b", "sk-…1a2b"}, // runes, not bytes
	} {
		if got := MaskKey(c.in); got != c.want {
			t.Errorf("MaskKey(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The DeepSeek key goes in through PUT and never comes back out: GET says a
// key is set and shows a masked hint, and a later save that does not name
// the key leaves it alone. A key that could not be one environment variable
// is refused.
func TestSettingsDeepSeekKeyIsWriteOnly(t *testing.T) {
	st, err := store.Open(context.Background(), ":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tb, _ := cost.Embedded()
	fs := &fakeSettings{}
	s := New(Deps{Store: st, Bus: bus.New(), Table: tb, Version: "test",
		Now:      time.Now,
		Status:   func(context.Context) any { return map[string]string{} },
		Settings: fs,
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	do := func(method, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+"/v1/settings", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(b)
	}

	const key = "sk-test0000000000000000feed"
	if code, _ := do(http.MethodPut, `{"deepseek_api_key":"  `+key+`\n"}`); code != 200 {
		t.Fatalf("PUT key: %d", code)
	}
	if fs.cur.DeepSeekAPIKey != key {
		t.Fatal("the key was not stored trimmed")
	}
	code, body := do(http.MethodGet, "")
	if code != 200 || strings.Contains(body, key) || strings.Contains(body, "test0000") {
		t.Fatalf("GET leaked the key or failed: %d", code)
	}
	if !strings.Contains(body, `"deepseek_key_set":true`) || !strings.Contains(body, `"deepseek_key_hint":"sk-…feed"`) {
		t.Errorf("GET does not say a key is set: %s", body)
	}
	// An unrelated save keeps it.
	if code, _ := do(http.MethodPut, `{"memory":true}`); code != 200 || fs.cur.DeepSeekAPIKey != key {
		t.Fatalf("an unrelated save dropped the key: %d", code)
	}
	if code, _ := do(http.MethodPut, `{"deepseek_api_key":"sk-a\nEVIL=1"}`); code != http.StatusBadRequest {
		t.Errorf("a key with a line break: %d, want 400", code)
	}
	// Empty is a deliberate clear: the user revokes it.
	if code, _ := do(http.MethodPut, `{"deepseek_api_key":""}`); code != 200 || fs.cur.DeepSeekAPIKey != "" {
		t.Fatalf("clearing the key: %d", code)
	}
	if _, body := do(http.MethodGet, ""); !strings.Contains(body, `"deepseek_key_set":false`) {
		t.Errorf("after clearing: %s", body)
	}
}
