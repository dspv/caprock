package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoopbackAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:6061": true,
		"[::1]:6061":     true,
		"127.0.0.1:0":    true,
		"0.0.0.0:6061":   false,
		"localhost:6061": false,
		"10.0.0.2:6061":  false,
		":6061":          false,
		"6061":           false,
		"":               false,
	} {
		if got := loopbackAddr(addr); got != want {
			t.Errorf("loopbackAddr(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestMemHandlerSplitsGoAndSQLite(t *testing.T) {
	rec := httptest.NewRecorder()
	memHandler(rec, httptest.NewRequest(http.MethodGet, "/debug/caprock/mem", nil))
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var got map[string]float64
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("not JSON: %v: %s", err, rec.Body.String())
	}
	if got["/memory/classes/total:bytes"] <= 0 || got["/memory/classes/heap/objects:bytes"] <= 0 {
		t.Errorf("Go runtime figures missing: %v", got)
	}
	for _, k := range []string{"sqlite_bytes", "sqlite_allocs", "sqlite_mmaps", "/gc/gomemlimit:bytes"} {
		if _, ok := got[k]; !ok {
			t.Errorf("%s missing: %v", k, got)
		}
	}
}
