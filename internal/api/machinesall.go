package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/peers"
)

// One view across computers (ADR-067, Phase 3): ?machines=all on the
// session list and the cost summary. This machine asks each computer it
// reaches the same question through its channel, at once, and answers with
// what each one said, naming every computer that did not answer and why —
// never counting it as nothing (rule 6). Each computer prices its own
// sessions with its own pricing table and says which; nothing is re-priced
// here. Loopback only, as every route that reaches another computer: a phone
// or computer paired with this machine is refused (not transitive).
//
// Nothing about another computer is stored: each answer is kept in memory
// for machinesAllFresh, so a screen that polls every few seconds costs the
// relay one read per computer in that time, not one per poll.

// machinesAllFresh is how long one computer's answer to one question is
// served from here.
const machinesAllFresh = 30 * time.Second

// machinesAllWait bounds one computer's answer; one that does not answer in
// time is named, never waited on by the others.
const machinesAllWait = 8 * time.Second

// machinesAll reads ?machines=: false for none, true for "all"; anything
// else, or "all" from anything but this machine's own clients, is refused
// and answered here.
func (s *Server) machinesAll(w http.ResponseWriter, r *http.Request) (all, ok bool) {
	switch r.URL.Query().Get("machines") {
	case "":
		return false, true
	case "all":
		if !s.machinesLocal(w, r) {
			return false, false
		}
		return true, true
	default:
		s.failCode(w, http.StatusBadRequest, errors.New("machines is all or absent"))
		return false, false
	}
}

type machinesAllEntry struct {
	got  machineAnswer
	at   time.Time
	read time.Time
}

// machinesAllCache is each computer's last answer, by computer and path.
type machinesAllCache struct {
	mu sync.Mutex
	m  map[string]machinesAllEntry
}

// machineAsked is one computer's answer for a ?machines=all view.
type machineAsked struct {
	peers.Status
	machineAnswer
	// At is when Body was read, unix ms by this machine's clock.
	At int64
}

// askEveryMachine asks every computer path at once, from here when its
// answer is fresh, in the order the computers were added. A computer known
// to wait for Allow, removed there, or answering with another key is named
// with that state and not asked.
func (s *Server) askEveryMachine(ctx context.Context, path string) []machineAsked {
	list := s.d.Machines.List()
	out := make([]machineAsked, len(list))
	var wg sync.WaitGroup
	for i, m := range list {
		out[i].Status = m
		switch m.Status {
		case peers.StatusPending, peers.StatusRevoked, "refused":
			out[i].machineAnswer = machineAnswer{Status: m.Status, Error: m.Error}
			continue
		}
		key := m.ID + " " + path
		c := &s.machAll
		c.mu.Lock()
		e, kept := c.m[key]
		c.mu.Unlock()
		if kept && time.Since(e.read) < machinesAllFresh {
			out[i].machineAnswer, out[i].At = e.got, e.at.UnixMilli()
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			got := s.askMachine(ctx, id, path, machinesAllWait)
			now := time.Now()
			out[i].machineAnswer = got
			if got.Body != nil {
				out[i].At = now.UnixMilli()
			}
			c.mu.Lock()
			if c.m == nil {
				c.m = map[string]machinesAllEntry{}
			}
			c.m[key] = machinesAllEntry{got: got, at: now, read: now}
			c.mu.Unlock()
		}(i, m.ID)
	}
	wg.Wait()
	s.machAll.mu.Lock()
	for k, e := range s.machAll.m {
		if time.Since(e.read) > 10*time.Minute {
			delete(s.machAll.m, k) // a question nobody asks any more, or a computer forgotten
		}
	}
	s.machAll.mu.Unlock()
	return out
}

// MachineCost is one computer's line in the summary's ?machines=all: its
// figures when it answered, and why not when it did not.
type MachineCost struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// The figures it stated for the same range and agent, priced there with
	// its own table (PricingVersion). Absent when it did not answer: unknown,
	// never zero.
	CostUSD        *float64        `json:"cost_usd,omitempty"`
	Tokens         *int64          `json:"tokens,omitempty"`
	Sessions       *int64          `json:"sessions,omitempty"`
	Turns          *int64          `json:"turns,omitempty"`
	PricingVersion string          `json:"pricing_version,omitempty"`
	Unpriced       json.RawMessage `json:"unpriced,omitempty"`
	// At is when the figures were read, unix ms by this machine's clock.
	At int64 `json:"at,omitempty"`
}

// AcrossMachines sums this machine and every computer that answered.
type AcrossMachines struct {
	CostUSD  float64 `json:"cost_usd"`
	Tokens   int64   `json:"tokens"`
	Sessions int64   `json:"sessions"`
	Turns    int64   `json:"turns"`
	// Answered counts what the sum holds, this machine included; Of is how
	// many computers there are, this machine included. Answered < Of means
	// the sum is not the whole, and the missing ones are named in machines.
	Answered int `json:"answered"`
	Of       int `json:"of"`
	// Unpriced says some part of the sum had volume its machine could not
	// price: the cost is what could be priced, not the whole.
	Unpriced bool `json:"unpriced,omitempty"`
}

// summaryTokens is every token the summary counts: input with cache reads
// and writes, and output.
func summaryTokens(in, out, read, write int64) int64 { return in + out + read + write }

// costAcross adds every computer's summary for the same range and agent to
// this machine's.
func (s *Server) costAcross(ctx context.Context, rng, agent string, here *SummaryResponse) ([]MachineCost, *AcrossMachines) {
	q := url.Values{}
	q.Set("range", rng)
	if agent != "" {
		q.Set("agent", agent)
	}
	asked := s.askEveryMachine(ctx, "/v1/stats/summary?"+q.Encode())
	all := &AcrossMachines{
		CostUSD: here.CostUSD, Sessions: here.Sessions, Turns: here.Turns,
		Tokens:   summaryTokens(here.TokensIn, here.TokensOut, here.CacheRead, here.CacheWrite),
		Answered: 1, Of: 1 + len(asked), Unpriced: here.Unpriced != nil,
	}
	out := make([]MachineCost, 0, len(asked))
	for _, a := range asked {
		mc := MachineCost{ID: a.ID, Name: a.Name, Status: a.machineAnswer.Status, Error: a.machineAnswer.Error}
		var theirs struct {
			Sessions   *int64          `json:"sessions"`
			Turns      *int64          `json:"turns"`
			TokensIn   int64           `json:"tokens_in"`
			TokensOut  int64           `json:"tokens_out"`
			CacheRead  int64           `json:"cache_read"`
			CacheWrite int64           `json:"cache_write"`
			CostUSD    *float64        `json:"cost_usd"`
			Pricing    string          `json:"pricing_version"`
			Unpriced   json.RawMessage `json:"unpriced"`
		}
		if a.Body != nil && json.Unmarshal(a.Body, &theirs) == nil && theirs.CostUSD != nil && theirs.Sessions != nil && theirs.Turns != nil {
			tokens := summaryTokens(theirs.TokensIn, theirs.TokensOut, theirs.CacheRead, theirs.CacheWrite)
			mc.CostUSD, mc.Tokens, mc.Sessions, mc.Turns = theirs.CostUSD, &tokens, theirs.Sessions, theirs.Turns
			mc.PricingVersion, mc.At = theirs.Pricing, a.At
			if len(theirs.Unpriced) > 0 && string(theirs.Unpriced) != "null" {
				mc.Unpriced, all.Unpriced = theirs.Unpriced, true
			}
			all.CostUSD += *theirs.CostUSD
			all.Tokens += tokens
			all.Sessions += *theirs.Sessions
			all.Turns += *theirs.Turns
			all.Answered++
		} else if mc.Status == "online" {
			// It answered, but not with a summary this machine reads: named,
			// not counted.
			mc.Status, mc.Error = "error", "its answer is not a cost summary"
		}
		out = append(out, mc)
	}
	return out, all
}

// MachineListed is one computer in the session list's ?machines=all: how it
// stands, and how many of its sessions are in the list.
type MachineListed struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// Count is how many of its sessions it answered with; absent when it did
	// not answer.
	Count *int `json:"count,omitempty"`
	// At is when they were read, unix ms by this machine's clock.
	At int64 `json:"at,omitempty"`
}

// sessionsAcross merges this machine's sessions with every computer's answer
// to the same query: each of theirs tagged with machine and machine_name,
// the whole ordered newest first by last_event_at as each machine stated it
// (clocks are not corrected), and cut to limit when one was asked.
func (s *Server) sessionsAcross(ctx context.Context, q url.Values, limit int, here []SessionSummary) ([]json.RawMessage, []MachineListed) {
	q = cloneValues(q)
	q.Del("machines")
	asked := s.askEveryMachine(ctx, "/v1/sessions?"+q.Encode())
	type row struct {
		at  int64
		raw json.RawMessage
	}
	rows := make([]row, 0, len(here))
	for _, sum := range here {
		b, err := json.Marshal(sum)
		if err != nil {
			continue
		}
		rows = append(rows, row{at: sum.LastEventAt, raw: b})
	}
	listed := make([]MachineListed, 0, len(asked))
	for _, a := range asked {
		ml := MachineListed{ID: a.ID, Name: a.Name, Status: a.machineAnswer.Status, Error: a.machineAnswer.Error}
		var theirs []map[string]json.RawMessage
		if a.Body != nil && json.Unmarshal(a.Body, &theirs) == nil {
			n := 0
			for _, m := range theirs {
				var at int64
				_ = json.Unmarshal(m["last_event_at"], &at)
				m["machine"], _ = json.Marshal(a.ID)
				m["machine_name"], _ = json.Marshal(a.Name)
				b, err := json.Marshal(m)
				if err != nil {
					continue
				}
				rows = append(rows, row{at: at, raw: b})
				n++
			}
			ml.Count, ml.At = &n, a.At
		} else if ml.Status == "online" {
			ml.Status, ml.Error = "error", "its answer is not a session list"
		}
		listed = append(listed, ml)
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].at > rows[j].at })
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	out := make([]json.RawMessage, len(rows))
	for i, r := range rows {
		out[i] = r.raw
	}
	return out, listed
}

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v))
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
