package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// One list across computers (ADR-067, Phase 2): GET /v1/machines/sessions is
// the running sessions of every computer this machine reaches, read through
// each one's channel and kept here for a few seconds, so every window, the
// sidebar and Now share one read per computer instead of each asking each
// computer on its own clock. A computer's daemon says when something there
// changed (daemon/machinewatch.go), which drops its entry at once.

// machineSessionsFresh is how long a computer's list is served from here
// before it is read again. A prompt or a notification there drops it sooner.
const machineSessionsFresh = 10 * time.Second

// machineSessionsWait bounds one computer's read; one that does not answer
// in time is listed as it stood, never holding up the others.
const machineSessionsWait = 8 * time.Second

// machineSessionsPath is what is asked of each computer: its running
// sessions, chats left out, as its own sidebar lists them.
const machineSessionsPath = "/v1/sessions?active=true&chats=exclude&limit=50"

// MachineSessions is one computer's running sessions as GET
// /v1/machines/sessions lists them.
type MachineSessions struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Status is how the computer stands: online, or why its sessions are not
	// listed — offline, pending (waiting for Allow there), revoked (removed
	// there), refused (another key), error.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// Sessions is its GET /v1/sessions answer, as it sent it; absent when
	// the last read failed: a list from before it went offline is not what
	// runs there now.
	Sessions json.RawMessage `json:"sessions,omitempty"`
	// At is when Sessions was read, unix ms by this machine's clock; LastOK
	// when a read last succeeded (0: never).
	At     int64 `json:"at,omitempty"`
	LastOK int64 `json:"last_ok,omitempty"`
}

type machineSessionsEntry struct {
	MachineSessions
	read time.Time
	// reading is closed when the read in flight ends; nil when none is.
	reading chan struct{}
}

// machineSessionsCache is each computer's last read.
type machineSessionsCache struct {
	mu sync.Mutex
	m  map[string]*machineSessionsEntry
}

// MachineChanged drops computer id's kept list, so the next read asks it:
// its daemon said a prompt began or ended there, or its channel came up or
// went down.
func (s *Server) MachineChanged(id string) {
	s.machSessions.mu.Lock()
	if e := s.machSessions.m[id]; e != nil {
		e.read = time.Time{}
	}
	s.machSessions.mu.Unlock()
}

// handleMachineSessions answers every computer's running sessions.
func (s *Server) handleMachineSessions(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"machines": s.machineSessions(r.Context())})
}

// machineSessions reads each computer at once, from here when its list is
// fresh, and answers in the order the computers were added.
func (s *Server) machineSessions(ctx context.Context) []MachineSessions {
	list := s.d.Machines.List()
	out := make([]MachineSessions, len(list))
	var wg sync.WaitGroup
	for i, m := range list {
		wg.Add(1)
		go func(i int, m peers.Status) {
			defer wg.Done()
			out[i] = s.machineSessionsOf(ctx, m)
		}(i, m)
	}
	wg.Wait()
	s.machSessions.mu.Lock()
	for id := range s.machSessions.m {
		known := false
		for _, m := range list {
			known = known || m.ID == id
		}
		if !known {
			delete(s.machSessions.m, id) // forgotten
		}
	}
	s.machSessions.mu.Unlock()
	return out
}

// machineSessionsOf is one computer's entry: kept, or read now. Two callers
// at once share one read.
func (s *Server) machineSessionsOf(ctx context.Context, m peers.Status) MachineSessions {
	base := MachineSessions{ID: m.ID, Name: m.Name, Status: m.Status, Error: m.Error}
	switch m.Status {
	case peers.StatusPending, peers.StatusRevoked, "refused":
		// Nothing there answers this machine until its owner acts: said,
		// not asked again on every read.
		return base
	}
	c := &s.machSessions
	c.mu.Lock()
	if c.m == nil {
		c.m = map[string]*machineSessionsEntry{}
	}
	e := c.m[m.ID]
	if e == nil {
		e = &machineSessionsEntry{}
		c.m[m.ID] = e
	}
	if !e.read.IsZero() && time.Since(e.read) < machineSessionsFresh {
		got := e.MachineSessions
		c.mu.Unlock()
		got.Name = m.Name
		return got
	}
	if wait := e.reading; wait != nil {
		c.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		c.mu.Lock()
		got := e.MachineSessions
		c.mu.Unlock()
		got.Name = m.Name
		if got.ID == "" {
			return base
		}
		return got
	}
	done := make(chan struct{})
	e.reading = done
	lastOK := e.LastOK
	c.mu.Unlock()

	got := s.readMachineSessions(ctx, base)
	if got.Sessions != nil {
		lastOK = got.At
	}
	got.LastOK = lastOK
	c.mu.Lock()
	e.MachineSessions = got
	e.read = time.Now()
	e.reading = nil
	c.mu.Unlock()
	close(done)
	return got
}

// readMachineSessions asks the computer through its channel and says what it
// answered, in the words the proxy uses.
func (s *Server) readMachineSessions(ctx context.Context, base MachineSessions) MachineSessions {
	out := base
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), machineSessionsWait)
	defer cancel()
	req, _ := http.NewRequestWithContext(rctx, http.MethodGet, "http://machine"+machineSessionsPath, nil)
	req.Header.Set("Accept", "application/json")
	res, err := s.d.Machines.Do(base.ID, req)
	if err != nil {
		out.Status, out.Error = machineState(err), err.Error()
		return out
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	switch {
	case err != nil:
		out.Status, out.Error = "offline", err.Error()
	case res.StatusCode == http.StatusOK && json.Valid(b):
		out.Status, out.Error = "online", ""
		out.Sessions, out.At = json.RawMessage(b), time.Now().UnixMilli()
	case res.StatusCode == http.StatusUnauthorized:
		// Ask once, through a channel only it can speak on.
		cctx, ccancel := context.WithTimeout(context.WithoutCancel(ctx), machineLeaveWait)
		st, _ := s.d.Machines.Check(cctx, base.ID)
		ccancel()
		out.Status, out.Error = st.Status, st.Error
	case res.StatusCode == http.StatusForbidden:
		// A computer waiting to be allowed there says so in its error.
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		out.Status, out.Error = peers.StatusPending, e.Error
	default:
		var e struct {
			Error  string `json:"error"`
			Status string `json:"status"`
		}
		_ = json.Unmarshal(b, &e)
		out.Status, out.Error = "error", e.Error
		if e.Status != "" {
			out.Status = e.Status
		}
		if out.Error == "" {
			out.Error = res.Status
		}
	}
	return out
}

// machineState is the word for a channel error: offline, refused or error.
func machineState(err error) string {
	switch {
	case errors.Is(err, remote.ErrMachineOffline), errors.Is(err, remote.ErrRelayUnreachable), errors.Is(err, context.DeadlineExceeded):
		return "offline"
	case errors.Is(err, remote.ErrRefused):
		return "refused"
	}
	return "error"
}
