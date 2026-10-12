package api

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/store"
)

// A status line run under one of Caprock's subscription directories reports
// that sign-in's windows (ADR-048): they are stored under its prefix, and the
// Default sign-in's are left as they were. A session started on a
// subscription is matched by its row when no directory is forwarded.
func TestStatuslineFilesWindowsUnderTheSubscription(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	data := filepath.Join(t.TempDir(), "caprock")
	e.api.d.DataDir = data
	post := func(body string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/statusline", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != 204 {
			t.Fatalf("statusline: %v", err)
		}
		resp.Body.Close()
	}
	dir := filepath.ToSlash(filepath.Join(data, "profiles", "ab12"))
	post(`{"session_id":"s1","five_hour":{"used_percentage":91,"resets_at":1787227200},"config_dir":"` + dir + `"}`)
	if _, ok, _ := store.LatestRateLimit(ctx, e.st.DB(), "five_hour"); ok {
		t.Fatal("a subscription's window was stored as the Default sign-in's")
	}
	got, err := store.RateLimitsWithPrefix(ctx, e.st.DB(), "sub:ab12:")
	if err != nil || len(got) != 1 || got[0].UsedPercentage != 91 {
		t.Fatalf("subscription windows: %+v %v", got, err)
	}

	if err := store.UpsertSession(ctx, e.st.DB(), "s2", store.SessionPatch{Cwd: "/x", Subscription: "cd34"}); err != nil {
		t.Fatal(err)
	}
	post(`{"session_id":"s2","seven_day":{"used_percentage":40,"resets_at":1787227200}}`)
	if got, _ := store.RateLimitsWithPrefix(ctx, e.st.DB(), "sub:cd34:"); len(got) != 1 {
		t.Fatalf("by session: %+v", got)
	}
	post(`{"session_id":"s3","five_hour":{"used_percentage":12,"resets_at":1787227200}}`)
	if s, ok, _ := store.LatestRateLimit(ctx, e.st.DB(), "five_hour"); !ok || s.UsedPercentage != 12 {
		t.Fatalf("default: %+v %v", s, ok)
	}
}

// Without a manager the endpoint says so rather than answering an empty list.
func TestSubscriptionsUnavailable(t *testing.T) {
	e := newEnv(t)
	if code := e.get(t, "/v1/subscriptions", nil); code != http.StatusNotImplemented {
		t.Fatalf("GET without a manager: %d", code)
	}
}

type fakeSubs struct{ got []SubscriptionPatch }

func (f *fakeSubs) List(context.Context) (SubscriptionsResponse, error) {
	return SubscriptionsResponse{}, nil
}
func (f *fakeSubs) Add(context.Context, string, string) (Subscription, error) {
	return Subscription{}, nil
}
func (f *fakeSubs) Update(_ context.Context, id string, p SubscriptionPatch) (Subscription, error) {
	f.got = append(f.got, p)
	return Subscription{ID: id}, nil
}
func (f *fakeSubs) Remove(context.Context, string) error { return nil }

// PATCH reads each change on its own: a name, Make default, a plan, and a
// plan of null, which clears it. A plan is held to what the main one is.
func TestSubscriptionPatch(t *testing.T) {
	e := newEnv(t)
	f := &fakeSubs{}
	e.api.d.Subscriptions = f
	patch := func(id, body string) int {
		t.Helper()
		return e.send(t, http.MethodPatch, "/v1/subscriptions/"+id, body, nil)
	}
	for _, c := range []struct {
		body string
		code int
	}{
		{`{"label":"Work"}`, 200},
		{`{"make_default":true,"agent":"claude"}`, 200},
		{`{"plan":{"kind":"flat","label":"Max 20×","usd_per_month":200}}`, 200},
		{`{"plan":null}`, 200},
		{`{"plan":{"kind":"weekly"}}`, 400},
		{`{"plan":{"kind":"flat","usd_per_month":-1}}`, 400},
		{`{}`, 400},
	} {
		if code := patch("ab12", c.body); code != c.code {
			t.Fatalf("%s: %d, want %d", c.body, code, c.code)
		}
	}
	if len(f.got) != 4 {
		t.Fatalf("patches: %+v", f.got)
	}
	if f.got[0].Label == nil || *f.got[0].Label != "Work" || f.got[0].SetPlan || f.got[0].MakeDefault {
		t.Fatalf("label: %+v", f.got[0])
	}
	if !f.got[1].MakeDefault || f.got[1].Agent != "claude" {
		t.Fatalf("make default: %+v", f.got[1])
	}
	if !f.got[2].SetPlan || f.got[2].Plan == nil || f.got[2].Plan.USDPerMonth != 200 {
		t.Fatalf("plan: %+v", f.got[2])
	}
	if !f.got[3].SetPlan || f.got[3].Plan != nil {
		t.Fatalf("clear: %+v", f.got[3])
	}
}
