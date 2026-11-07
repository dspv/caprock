package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// fakeMany is several computers: each with a state, and either a handler
// standing for its API or an error its channel fails with.
type fakeMany struct {
	mu   sync.Mutex
	list []peers.Status
	far  map[string]http.Handler
	errs map[string]error
	asks map[string]int
}

func (f *fakeMany) List() []peers.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]peers.Status(nil), f.list...)
}
func (f *fakeMany) Get(id string) (peers.Status, error) {
	for _, m := range f.List() {
		if m.ID == id {
			return m, nil
		}
	}
	return peers.Status{}, peers.ErrUnknown
}
func (f *fakeMany) Check(_ context.Context, id string) (peers.Status, error) { return f.Get(id) }
func (f *fakeMany) Pair(context.Context, string) (peers.Status, error) {
	return peers.Status{}, errors.New("no")
}
func (f *fakeMany) Rename(string, string) error         { return nil }
func (f *fakeMany) Leave(context.Context, string) error { return nil }
func (f *fakeMany) Forget(string) error                 { return nil }
func (f *fakeMany) OpenWS(context.Context, string, string, []string) (MachineSocket, error) {
	return nil, errors.New("no sockets here")
}
func (f *fakeMany) Do(id string, req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	if f.asks == nil {
		f.asks = map[string]int{}
	}
	f.asks[id+" "+req.URL.Path]++
	err, h := f.errs[id], f.far[id]
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Result(), nil
}
func (f *fakeMany) asked(id, path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.asks[id+" "+path]
}

// threeComputers is this machine plus: Mac mini, which answers; Linux VM,
// offline; and a box still waiting for Allow there.
func threeComputers(t *testing.T, mini http.HandlerFunc) *fakeMany {
	t.Helper()
	return &fakeMany{
		list: []peers.Status{
			{ID: "mini", Name: "Mac mini", Status: "online"},
			{ID: "vm", Name: "Linux VM", Status: "online"},
			{ID: "box", Name: "Box", Status: peers.StatusPending},
		},
		far:  map[string]http.Handler{"mini": mini},
		errs: map[string]error{"vm": remote.ErrMachineOffline},
	}
}

// The cost summary across computers sums this machine and every computer
// that answered, each priced by its own table, and names the others with
// why — never counting them as $0 (rule 6).
func TestCostAcrossComputers(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var asked atomic.Value
	fm := threeComputers(t, func(w http.ResponseWriter, r *http.Request) {
		asked.Store(r.URL.RawQuery)
		_, _ = w.Write([]byte(`{"range":"7d","sessions":3,"turns":40,"tokens_in":1000,"tokens_out":500,"cache_read":200,"cache_write":100,"cost_usd":12.5,"pricing_version":"2026-10-01","unpriced":{"turns":2,"tokens":50,"models":["x-1"]}}`))
	})
	e.api.d.Machines = fm
	var here SummaryResponse
	if code := e.get(t, "/v1/stats/summary?range=7d", &here); code != 200 || here.Machines != nil || here.All != nil {
		t.Fatalf("without machines=all: %d, machines %v all %v", code, here.Machines, here.All)
	}
	var sum SummaryResponse
	if code := e.get(t, "/v1/stats/summary?range=7d&agent=claude&machines=all", &sum); code != 200 {
		t.Fatalf("machines=all: %d", code)
	}
	if q, _ := asked.Load().(string); !strings.Contains(q, "range=7d") || !strings.Contains(q, "agent=claude") || strings.Contains(q, "machines") {
		t.Fatalf("the computer was asked %q: the same range and agent, never machines=all", q)
	}
	if len(sum.Machines) != 3 {
		t.Fatalf("machines: %+v", sum.Machines)
	}
	mini, vm, box := sum.Machines[0], sum.Machines[1], sum.Machines[2]
	if mini.Status != "online" || mini.CostUSD == nil || *mini.CostUSD != 12.5 || *mini.Tokens != 1800 || *mini.Sessions != 3 || mini.PricingVersion != "2026-10-01" || len(mini.Unpriced) == 0 || mini.At == 0 {
		t.Fatalf("Mac mini: %+v", mini)
	}
	if vm.Status != "offline" || vm.CostUSD != nil || vm.Error == "" {
		t.Fatalf("Linux VM: %+v", vm)
	}
	if box.Status != peers.StatusPending || box.CostUSD != nil || fm.asked("box", "/v1/stats/summary") != 0 {
		t.Fatalf("Box: %+v, asked %d times", box, fm.asked("box", "/v1/stats/summary"))
	}
	a := sum.All
	if a == nil || a.Answered != 2 || a.Of != 4 || !a.Unpriced {
		t.Fatalf("all: %+v", a)
	}
	if got, want := a.CostUSD, sum.CostUSD+12.5; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("all cost %v, want this machine's %v + 12.5", got, sum.CostUSD)
	}
	if a.Sessions != sum.Sessions+3 || a.Turns != sum.Turns+40 {
		t.Fatalf("all sessions/turns: %+v", a)
	}
	// An offline computer is said in the JSON without a figure at all.
	b, _ := json.Marshal(vm)
	if strings.Contains(string(b), "cost_usd") {
		t.Fatalf("an offline computer carries a cost: %s", b)
	}
	// Kept a while: the screen polls, the relay is asked once.
	e.get(t, "/v1/stats/summary?range=7d&agent=claude&machines=all", &sum)
	if n := fm.asked("mini", "/v1/stats/summary"); n != 1 {
		t.Fatalf("two polls asked Mac mini %d times", n)
	}
}

// machines is all or absent, and only this machine's own clients may ask.
func TestMachinesAllIsThisMachinesOnly(t *testing.T) {
	s := machinesServer(t, &fakeMachines{status: "online", far: http.NotFoundHandler()})
	if w := serve(s, local("GET", "/v1/sessions?machines=some", "")); w.Code != 400 {
		t.Fatalf("machines=some: %d", w.Code)
	}
	for _, path := range []string{"/v1/sessions?machines=all", "/v1/stats/summary?machines=all"} {
		r := local("GET", path, "")
		r.Header.Set("Via", "1.1 caprock-remote")
		if w := serve(s, r); w.Code != 401 && w.Code != 403 {
			t.Fatalf("%s relayed: %d", path, w.Code)
		}
	}
	// A paired phone: the gate lets it read the list, the handler refuses
	// to reach further.
	s2, _, viewer, _ := pairedPhones(t, Deps{Machines: &fakeMachines{status: "online", far: http.NotFoundHandler()}})
	if w := serve(s2, fromDevice("GET", "/v1/sessions?machines=all", "", viewer.Token)); w.Code != 403 {
		t.Fatalf("a phone asking machines=all: %d %s", w.Code, w.Body)
	}
}

// The session list across computers: theirs tagged with the computer, all
// newest first, the ones that did not answer named.
func TestSessionsAcrossComputers(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	var first atomic.Value
	fm := threeComputers(t, func(w http.ResponseWriter, r *http.Request) {
		first.CompareAndSwap(nil, r.URL.RawQuery)
		_, _ = w.Write([]byte(`[{"session_id":"far-new","last_event_at":9999999999999},{"session_id":"far-old","last_event_at":1}]`))
	})
	e.api.d.Machines = fm
	var got struct {
		Sessions []map[string]any `json:"sessions"`
		Machines []MachineListed  `json:"machines"`
	}
	if code := e.get(t, "/v1/sessions?active=true&machines=all", &got); code != 200 {
		t.Fatalf("machines=all: %d", code)
	}
	if q, _ := first.Load().(string); q != "active=true" {
		t.Fatalf("the computer was asked %q, want the same query without machines", q)
	}
	if len(got.Sessions) < 3 || got.Sessions[0]["session_id"] != "far-new" || got.Sessions[0]["machine"] != "mini" || got.Sessions[0]["machine_name"] != "Mac mini" {
		t.Fatalf("sessions: %+v", got.Sessions)
	}
	last := got.Sessions[len(got.Sessions)-1]
	if last["session_id"] != "far-old" {
		t.Fatalf("not newest first: %+v", got.Sessions)
	}
	for _, s := range got.Sessions {
		if s["session_id"] == "s1" && s["machine"] != nil {
			t.Fatalf("this machine's session is tagged: %+v", s)
		}
	}
	if len(got.Machines) != 3 || got.Machines[0].Count == nil || *got.Machines[0].Count != 2 || got.Machines[1].Status != "offline" || got.Machines[1].Count != nil || got.Machines[2].Status != peers.StatusPending {
		t.Fatalf("machines: %+v", got.Machines)
	}
	if code := e.get(t, "/v1/sessions?machines=all&limit=1", &got); code != 200 || len(got.Sessions) != 1 {
		t.Fatalf("limit: %d %d", code, len(got.Sessions))
	}
	if code := e.get(t, "/v1/sessions?machines=all&dir=/x", nil); code != 400 {
		t.Fatalf("dir with machines=all: %d", code)
	}
}
