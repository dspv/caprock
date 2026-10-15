package peers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/remote"
)

// Errors a caller turns into an answer.
var (
	// ErrUnknown is a computer this machine has not paired with.
	ErrUnknown = errors.New("no such computer")
	// ErrSelf is a pairing link for this machine itself.
	ErrSelf = errors.New("that link is for this computer")
	// ErrNoCode is a link without a code: the target's owner has to show
	// one first.
	ErrNoCode = errors.New("that link carries no code: show a new code on that computer")
	// ErrBadCode is the target refusing the code — wrong, expired, used, or
	// never issued; it does not say which, on purpose (internal/pairing).
	ErrBadCode = errors.New("that computer did not accept the code: show a new one there")
	// ErrNotAccepting is a target with no pairing open: access from
	// anywhere is off there.
	ErrNotAccepting = errors.New("that computer is not accepting pairings: turn on access from anywhere there")
)

// Statuses beyond remote.ClientState's.
const (
	// StatusRevoked is a computer that answered GET /v1/pair/me with 401:
	// its owner removed this machine, or reset its pairing. Kept, not
	// deleted — the user decides to forget it — and asked again on the next
	// check, so a computer that was wrong about it comes back by itself.
	StatusRevoked = "revoked"
)

// Options configure a Manager.
type Options struct {
	// Dir is the data directory machines.json lives in.
	Dir string
	// Self is this machine's own relay id, refused as a target; "" when
	// unknown.
	Self string
	// Name is what the targets list this machine as.
	Name string
	Log  *slog.Logger
	// HTTPClient dials relays; nil is the default client.
	HTTPClient *http.Client
	// Idle overrides how long a channel with nothing open stays up.
	Idle time.Duration
}

// Status is one computer as the dashboard and the CLI see it. No token.
type Status struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Relay   string `json:"relay"`
	AddedAt int64  `json:"added_at"`
	// Status is the channel's (idle, connecting, online, offline, refused)
	// or StatusRevoked.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// Version is the Caprock the computer runs, from its last Welcome.
	Version string `json:"version,omitempty"`
	// Role is this machine's role there as the computer last said it:
	// viewer or controller; empty until asked.
	Role string `json:"role,omitempty"`
	// LastSeen is when the computer last answered, unix milliseconds by
	// this machine's clock; 0 for not since this daemon started.
	LastSeen int64 `json:"last_seen,omitempty"`
	// Streams is how many requests and sockets are open to it.
	Streams int `json:"streams"`
}

// Manager keeps the computers and a channel, opened on demand, to each.
type Manager struct {
	opt Options
	log *slog.Logger

	mu    sync.Mutex
	list  []Machine
	peers map[string]*peer
}

type peer struct {
	client   *remote.Client
	role     string
	lastSeen time.Time
	revoked  bool
	checking bool
}

// Open loads machines.json. The Manager is usable even when that fails: the
// error says why the list is empty, for the log.
func Open(opt Options) (*Manager, error) {
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	m := &Manager{opt: opt, log: opt.Log, peers: map[string]*peer{}}
	ms, err := Read(opt.Dir)
	if err != nil {
		return m, fmt.Errorf("peers: %s: %w", File, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mach := range ms {
		p, err := m.newPeer(mach)
		if err != nil {
			m.log.Warn("a saved computer cannot be reached as written; skipping it", "component", "peers", "id", mach.ID, "err", err)
			continue
		}
		m.list = append(m.list, mach)
		m.peers[mach.ID] = p
	}
	return m, nil
}

func (m *Manager) newPeer(mach Machine) (*peer, error) {
	c, err := remote.NewClient(remote.ClientOptions{
		Target:     remote.Target{Relay: mach.Relay, HostID: mach.ID, Key: mach.Key},
		Log:        m.log,
		HTTPClient: m.opt.HTTPClient,
		Idle:       m.opt.Idle,
	})
	if err != nil {
		return nil, err
	}
	return &peer{client: c}, nil
}

// Close hangs up every channel.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.peers {
		p.client.Close()
	}
}

// List is every computer, in the order it was added.
func (m *Manager) List() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Status, 0, len(m.list))
	for _, mach := range m.list {
		out = append(out, m.statusLocked(mach))
	}
	return out
}

// Get is one computer.
func (m *Manager) Get(id string) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mach, ok := m.findLocked(id)
	if !ok {
		return Status{}, ErrUnknown
	}
	return m.statusLocked(mach), nil
}

func (m *Manager) findLocked(id string) (Machine, bool) {
	for _, mach := range m.list {
		if mach.ID == id {
			return mach, true
		}
	}
	return Machine{}, false
}

func (m *Manager) statusLocked(mach Machine) Status {
	s := Status{ID: mach.ID, Name: mach.Name, Relay: mach.Relay, AddedAt: mach.AddedAt}
	p := m.peers[mach.ID]
	if p == nil {
		s.Status = "offline"
		return s
	}
	st := p.client.State()
	s.Status, s.Error, s.Version, s.Streams = st.Status, st.Error, st.Version, st.Streams
	s.Role = p.role
	if !p.lastSeen.IsZero() {
		s.LastSeen = p.lastSeen.UnixMilli()
	}
	if p.revoked {
		s.Status, s.Error = StatusRevoked, "that computer removed this one: pair again there to reach it"
	}
	return s
}

// Pair redeems link's code on the computer it names, through the relay, and
// keeps the device token it is given. The role is the one the target's owner
// chose when showing the code (ADR-034, ADR-067); nothing this machine sends
// names one. Pairing with a computer already on the list replaces its entry.
func (m *Manager) Pair(ctx context.Context, link string) (Status, error) {
	info, err := remote.ParsePairLink(link)
	if err != nil {
		return Status{}, err
	}
	if info.Code == "" {
		return Status{}, ErrNoCode
	}
	if m.opt.Self != "" && info.HostID == m.opt.Self {
		return Status{}, ErrSelf
	}
	mach := Machine{ID: info.HostID, Key: info.Key, Relay: info.Relay, Name: cleanName(info.Name)}
	p, err := m.newPeer(mach)
	if err != nil {
		return Status{}, err
	}
	body, _ := json.Marshal(map[string]string{"code": info.Code, "name": m.opt.Name})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://machine/v1/pair", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := p.client.RoundTrip(req)
	if err != nil {
		p.client.Close()
		return Status{}, err
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	_ = res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		p.client.Close()
		return Status{}, ErrBadCode
	case http.StatusConflict:
		p.client.Close()
		return Status{}, ErrNotAccepting
	default:
		p.client.Close()
		return Status{}, fmt.Errorf("that computer answered %d to pairing", res.StatusCode)
	}
	var got struct {
		Token string `json:"token"`
		ID    string `json:"id"`
	}
	if err := json.Unmarshal(b, &got); err != nil || got.Token == "" {
		p.client.Close()
		return Status{}, errors.New("that computer's answer to pairing carried no token")
	}
	mach.Token, mach.DeviceID, mach.AddedAt = got.Token, got.ID, time.Now().UnixMilli()
	if mach.Name == "" {
		mach.Name = cleanName(p.client.State().Name)
	}
	if mach.Name == "" {
		mach.Name = "a computer"
	}
	p.lastSeen = time.Now()

	m.mu.Lock()
	list := make([]Machine, 0, len(m.list)+1)
	for _, old := range m.list {
		if old.ID != mach.ID {
			list = append(list, old)
		}
	}
	list = append(list, mach)
	if err := Write(m.opt.Dir, list); err != nil {
		m.mu.Unlock()
		p.client.Close()
		// The computer now lists a device whose token nobody holds; its
		// owner can remove it. Said, not hidden.
		return Status{}, fmt.Errorf("paired, but could not save it (remove this computer's entry there): %w", err)
	}
	if old := m.peers[mach.ID]; old != nil {
		old.client.Close()
	}
	m.list = list
	m.peers[mach.ID] = p
	m.mu.Unlock()
	m.log.Info("paired with a computer", "component", "peers", "id", mach.ID, "name", mach.Name)

	// Learn the role now, so the first list says it; a failure here is not a
	// failure to pair.
	if st, err := m.Check(ctx, mach.ID); err == nil {
		return st, nil
	}
	return m.Get(mach.ID)
}

// Rename changes what this machine calls a computer. The computer itself is
// not told.
func (m *Manager) Rename(id, name string) error {
	name = cleanName(name)
	if name == "" {
		return errors.New("a computer needs a name")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	list := append([]Machine(nil), m.list...)
	found := false
	for i := range list {
		if list[i].ID == id {
			list[i].Name, found = name, true
		}
	}
	if !found {
		return ErrUnknown
	}
	if err := Write(m.opt.Dir, list); err != nil {
		return err
	}
	m.list = list
	return nil
}

// Forget deletes a computer and its token here. The computer still lists
// this machine until its owner removes it there (asking it to is ADR-067's
// next step, DELETE /v1/pair/me).
func (m *Manager) Forget(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	list := make([]Machine, 0, len(m.list))
	for _, mach := range m.list {
		if mach.ID != id {
			list = append(list, mach)
		}
	}
	if len(list) == len(m.list) {
		return ErrUnknown
	}
	if err := Write(m.opt.Dir, list); err != nil {
		return err
	}
	m.list = list
	if p := m.peers[id]; p != nil {
		p.client.Close()
		delete(m.peers, id)
	}
	return nil
}

// lookup is a computer's token and channel.
func (m *Manager) lookup(id string) (string, *peer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mach, ok := m.findLocked(id)
	p := m.peers[id]
	if !ok || p == nil {
		return "", nil, ErrUnknown
	}
	return mach.Token, p, nil
}

func (m *Manager) seen(p *peer) {
	m.mu.Lock()
	p.lastSeen = time.Now()
	m.mu.Unlock()
}

// Do carries req to computer id as this machine's paired device there. Only
// the path and query travel. Whatever identifies the caller here — cookies,
// Origin, a device token of this machine's own — is removed, and this
// machine's token on that computer is set; the target's gate decides the
// rest.
func (m *Manager) Do(id string, req *http.Request) (*http.Response, error) {
	tok, p, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	r := req.Clone(req.Context())
	for k := range r.Header {
		ck := http.CanonicalHeaderKey(k)
		if ck == "Cookie" || ck == "Origin" || ck == "Referer" || ck == "Authorization" || strings.HasPrefix(ck, "Sec-") {
			r.Header.Del(k)
		}
	}
	r.Header.Set("X-Caprock-Device", tok)
	res, err := p.client.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	m.seen(p)
	// A 401 anywhere but pairing may mean this machine was removed there:
	// ask, rather than believe one answer (ADR-058's phone does the same).
	if res.StatusCode == http.StatusUnauthorized && !strings.HasPrefix(r.URL.Path, "/v1/pair") {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_, _ = m.Check(ctx, id)
		}()
	}
	return res, nil
}

// OpenWS opens a WebSocket at path on computer id, offering protocols plus
// this machine's device token there (as caprock.device.<token>, the way a
// phone's browser carries it). The socket's Subprotocol may be that token's;
// a caller passing it on must not echo it.
func (m *Manager) OpenWS(ctx context.Context, id, path string, protocols []string) (*remote.WSConn, error) {
	tok, p, err := m.lookup(id)
	if err != nil {
		return nil, err
	}
	protos := append(append([]string(nil), protocols...), "caprock.device."+tok)
	ws, err := p.client.OpenWS(ctx, path, protos)
	if err != nil {
		return nil, err
	}
	m.seen(p)
	return ws, nil
}

// Check asks computer id who this machine is there (GET /v1/pair/me) and
// records the answer: the role, or that the token is no longer known. Any
// other answer — offline, a 5xx — says nothing about the token and changes
// nothing but the channel's own state.
func (m *Manager) Check(ctx context.Context, id string) (Status, error) {
	tok, p, err := m.lookup(id)
	if err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	if p.checking {
		m.mu.Unlock()
		return m.Get(id)
	}
	p.checking = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		p.checking = false
		m.mu.Unlock()
	}()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://machine/v1/pair/me", nil)
	req.Header.Set("X-Caprock-Device", tok)
	res, err := p.client.RoundTrip(req)
	if err != nil {
		st, _ := m.Get(id)
		return st, err
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	_ = res.Body.Close()
	m.mu.Lock()
	p.lastSeen = time.Now()
	switch res.StatusCode {
	case http.StatusUnauthorized:
		// The answer came through a channel only that computer can speak
		// on, so it is the computer's word, not a relay's.
		if !p.revoked {
			m.log.Info("a computer no longer knows this one", "component", "peers", "id", id)
		}
		p.revoked, p.role = true, ""
	case http.StatusOK:
		var me struct {
			Role string `json:"role"`
		}
		_ = json.Unmarshal(b, &me)
		p.revoked, p.role = false, me.Role
	}
	m.mu.Unlock()
	return m.Get(id)
}
