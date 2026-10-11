package github

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

func usageRequests(x *fixture, prefix string) int {
	n := 0
	for _, r := range x.f.requests() {
		if strings.HasPrefix(r, prefix) {
			n++
		}
	}
	return n
}

// The month's Actions rows of GitHub's billing report are summed per SKU;
// other products are left out; the answer is kept for usageKept.
func TestActionsUsageReadsTheReport(t *testing.T) {
	x := newFixture(t)
	if u, e := x.s.ActionsUsage(context.Background(), ""); e != nil || u.Available || u.Reason != UsageNotConnected {
		t.Fatalf("not connected: %+v %v", u, e)
	}
	if n := len(x.f.requests()); n != 0 {
		t.Fatalf("%d requests while not connected", n)
	}
	x.connect(t)
	x.f.failWith("GET /users/ada/settings/billing/usage", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("year") != "2026" || r.URL.Query().Get("month") != "10" {
			t.Errorf("period %q", r.URL.RawQuery)
		}
		answer(w, r, 200, map[string]any{"usageItems": []any{
			map[string]any{"date": "2026-10-01", "product": "actions", "sku": "actions_linux", "quantity": 120, "unitType": "Minutes", "pricePerUnit": 0.5, "grossAmount": 60, "discountAmount": 60, "netAmount": 0},
			map[string]any{"date": "2026-10-02", "product": "Actions", "sku": "actions_linux", "quantity": 30, "unitType": "Minutes", "pricePerUnit": 0.5, "grossAmount": 15, "discountAmount": 5, "netAmount": 10},
			map[string]any{"date": "2026-10-02", "product": "actions", "sku": "actions_macos", "quantity": 10, "unitType": "Minutes", "pricePerUnit": 2, "grossAmount": 20, "discountAmount": 0, "netAmount": 20},
			map[string]any{"date": "2026-10-02", "product": "actions", "sku": "actions_storage", "quantity": 3, "unitType": "GigabyteHours", "pricePerUnit": 1, "grossAmount": 3, "discountAmount": 3, "netAmount": 0},
			map[string]any{"date": "2026-10-02", "product": "copilot", "sku": "copilot_premium_request", "quantity": 7, "unitType": "Requests", "pricePerUnit": 1, "grossAmount": 7, "discountAmount": 0, "netAmount": 7},
		}})
	})
	u, e := x.s.ActionsUsage(context.Background(), "")
	if e != nil {
		t.Fatal(e)
	}
	if !u.Available || u.Org || u.Account != "ada" || u.Year != 2026 || u.Month != 10 || u.Endpoint != "/users/ada/settings/billing/usage" {
		t.Fatalf("%+v", u)
	}
	if u.Minutes != 160 || u.GrossUSD != 98 || u.DiscountUSD != 68 || u.NetUSD != 30 || len(u.BySKU) != 3 {
		t.Fatalf("sums %+v", u)
	}
	if top := u.BySKU[0]; top.SKU != "actions_linux" || top.Quantity != 150 || top.NetUSD != 10 {
		t.Fatalf("by sku %+v", u.BySKU)
	}
	before := len(x.f.requests())
	x.advance(usageKept - time.Second)
	if _, _ = x.s.ActionsUsage(context.Background(), "ada"); len(x.f.requests()) != before {
		t.Fatal("asked again within usageKept")
	}
	x.advance(2 * time.Second)
	_, _ = x.s.ActionsUsage(context.Background(), "")
	if got := usageRequests(x, "GET /users/ada/settings/billing/usage"); got != 2 {
		t.Fatalf("%d reads after usageKept", got)
	}
	if _, e := x.s.ActionsUsage(context.Background(), "../etc"); e == nil || e.Kind != KindInvalid {
		t.Fatalf("bad owner: %v", e)
	}
}

// A token that may not read billing is an answer naming the permission, not
// an error, and does not mark the health line; it is kept like an answer.
func TestActionsUsageMissingPermission(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /users/ada/settings/billing/usage", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Accepted-GitHub-Permissions", "plan=read")
		answer(w, r, 403, map[string]any{"message": "Resource not accessible by personal access token"})
	})
	u, e := x.s.ActionsUsage(context.Background(), "")
	if e != nil {
		t.Fatal(e)
	}
	if u.Available || u.Reason != UsagePermission || len(u.Needs) != 1 || u.Needs[0] != "plan=read" || u.Error == nil || u.Error.Status != 403 {
		t.Fatalf("%+v", u)
	}
	if st := x.s.Status(); st.Health.Error != nil {
		t.Fatalf("health line marked: %+v", st.Health.Error)
	}
	before := len(x.f.requests())
	if _, _ = x.s.ActionsUsage(context.Background(), ""); len(x.f.requests()) != before {
		t.Fatal("a refusal was asked again at once")
	}

	// An organization: its own endpoint, and the documented permission when
	// GitHub names none.
	x.f.failWith("GET /organizations/acme/settings/billing/usage", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 403, map[string]any{"message": "Must have admin rights to the organization."})
	})
	u, e = x.s.ActionsUsage(context.Background(), "acme")
	if e != nil {
		t.Fatal(e)
	}
	if !u.Org || u.Reason != UsagePermission || len(u.Needs) != 2 || !strings.Contains(u.Needs[0], "Administration") {
		t.Fatalf("org %+v", u)
	}
}

func TestActionsUsageNotFound(t *testing.T) {
	x := newFixture(t)
	x.connect(t)
	x.f.failWith("GET /users/ada/settings/billing/usage", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 404, map[string]any{"message": "Not Found"})
	})
	u, e := x.s.ActionsUsage(context.Background(), "")
	if e != nil {
		t.Fatal(e)
	}
	if u.Available || u.Reason != UsageNotFound || u.Error == nil || !strings.Contains(u.Error.Message, "enhanced billing") {
		t.Fatalf("%+v", u)
	}
	// A server error is not kept: it is asked again next time.
	x.f.failWith("GET /users/ada/settings/billing/usage", func(w http.ResponseWriter, r *http.Request) {
		answer(w, r, 503, map[string]any{"message": "unavailable"})
	})
	x.advance(usageKept)
	if u, _ = x.s.ActionsUsage(context.Background(), ""); u.Reason != UsageError {
		t.Fatalf("%+v", u)
	}
	before := len(x.f.requests())
	_, _ = x.s.ActionsUsage(context.Background(), "")
	if len(x.f.requests()) == before {
		t.Fatal("a failed read was kept")
	}
}
