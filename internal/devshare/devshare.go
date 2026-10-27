// Package devshare opens a local dev server on a phone on the same Wi-Fi
// (ADR-087): a reverse proxy for one loopback origin, on a listener of its
// own, bound to one private address of this machine on a random port, behind
// an unguessable link.
//
// A dev server listens on localhost, so a phone cannot reach it. The usual
// fix (`--host`, 0.0.0.0) puts it on every interface with no guard. A share
// is the opposite: one named address, one origin, a token, and an end — Stop
// sharing, 30 minutes without the phone, 8 hours at most, or the daemon
// stopping. Nothing here is remembered across a restart.
//
// What a request may do is fixed when the share starts. The scheme, host and
// port forwarded to are the chosen origin's; a request names a path and
// nothing else, the dialer reaches only loopback, and no environment proxy is
// used. The first request opens /__caprock/open/<token>, which sets a cookie
// and redirects to the page; every request after that needs the cookie.
package devshare

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dspv/caprock/internal/lan"
)

// Defaults for a share's life and how many may be open at once.
const (
	DefaultIdle   = 30 * time.Minute
	DefaultMaxAge = 8 * time.Hour
	DefaultMax    = 3
	// OpenPrefix is the path of the link the QR carries, before the token.
	OpenPrefix = "/__caprock/open/"
	// ViaMark is put on every forwarded request, so a share that points at a
	// Caprock port is a stranger to its gate (internal/api lanauth).
	ViaMark = "1.1 caprock-share"
	// rewriteMax is the largest text answer whose localhost spellings are
	// rewritten; a larger one passes through as it came.
	rewriteMax = 4 << 20
)

// Errors a caller tells apart.
var (
	ErrNotLocal  = errors.New("only a local dev server's address can be opened on a phone: localhost, *.localhost, 127.x or [::1]")
	ErrOwnPort   = errors.New("that is Caprock's own port, which is never shared")
	ErrTooMany   = errors.New("three pages are shared already: stop one first")
	ErrNoAddress = errors.New("this computer has no address on a local network: is Wi-Fi on?")
	ErrClosed    = errors.New("sharing is shut down")
)

// Share is one origin opened on the network, as the dashboard sees it.
type Share struct {
	ID string `json:"id"`
	// Target is the origin forwarded to, e.g. http://localhost:5173.
	Target string `json:"target"`
	// Path is where the link lands: the page the tab showed.
	Path string `json:"path"`
	// URL is the link for the phone, token included. Loopback eyes only.
	URL string `json:"url"`
	// Address is the host:port the phone reaches, without the token.
	Address string `json:"address"`
	// Tunnelled says the address is Tailscale's rather than the Wi-Fi's.
	Tunnelled bool      `json:"tunnelled,omitempty"`
	StartedAt time.Time `json:"started_at"`
	// LastUsedAt is the last request or WebSocket traffic from a phone that
	// had the cookie; StartedAt until then.
	LastUsedAt time.Time `json:"last_used_at"`
	// ExpiresAt is when the share ends by itself if nothing happens.
	ExpiresAt time.Time `json:"expires_at"`
}

// Options configure a Manager. Zero values are the defaults.
type Options struct {
	// Address returns the address to bind. Default: PickAddress.
	Address func() (net.IP, error)
	// Forbid reports whether a target port must never be shared (the
	// daemon's own).
	Forbid func(port int) bool
	Idle   time.Duration
	MaxAge time.Duration
	Max    int
	Log    *slog.Logger
	// Now is the clock; tests move it.
	Now func() time.Time
	// Sweep is how often expiry is checked. Default: a minute.
	Sweep time.Duration
}

// Manager holds the open shares.
type Manager struct {
	opt    Options
	mu     sync.Mutex
	shares map[string]*share
	closed bool
	stop   chan struct{}
}

// New returns a Manager with nothing shared.
func New(opt Options) *Manager {
	if opt.Address == nil {
		opt.Address = PickAddress
	}
	if opt.Forbid == nil {
		opt.Forbid = func(int) bool { return false }
	}
	if opt.Idle <= 0 {
		opt.Idle = DefaultIdle
	}
	if opt.MaxAge <= 0 {
		opt.MaxAge = DefaultMaxAge
	}
	if opt.Max <= 0 {
		opt.Max = DefaultMax
	}
	if opt.Log == nil {
		opt.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Sweep <= 0 {
		opt.Sweep = time.Minute
	}
	return &Manager{opt: opt, shares: map[string]*share{}}
}

// Idle is how long a share lasts without a phone.
func (m *Manager) Idle() time.Duration { return m.opt.Idle }

// MaxAge is the longest a share lasts.
func (m *Manager) MaxAge() time.Duration { return m.opt.MaxAge }

// Max is how many shares may be open at once.
func (m *Manager) Max() int { return m.opt.Max }

// PickAddress is the address a phone on the same Wi-Fi reaches: the first
// private (RFC 1918) one, else a Tailscale one. Never 0.0.0.0.
func PickAddress() (net.IP, error) {
	all, err := lan.Addresses()
	if err != nil {
		return nil, err
	}
	return pick(all)
}

func pick(all []net.IP) (net.IP, error) {
	for _, ip := range all {
		if !lan.Tunnelled(ip) {
			return ip, nil
		}
	}
	if len(all) > 0 {
		return all[0], nil
	}
	return nil, ErrNoAddress
}

// Target is a parsed local origin and the path to land on.
type Target struct {
	Origin *url.URL // scheme://host:port, no path
	Path   string   // path and query to land on, "/" at least
	Port   int
}

// ParseTarget accepts a local dev server's address by devservers.ts's rules:
// http(s) on localhost, *.localhost, 127.x or [::1]; 0.0.0.0 and [::] become
// localhost. Anything else — another host, a LAN address, user info, another
// scheme — is ErrNotLocal.
func ParseTarget(raw string) (Target, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Target{}, ErrNotLocal
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Opaque != "" {
		return Target{}, ErrNotLocal
	}
	host := strings.ToLower(u.Hostname())
	switch {
	case host == "0.0.0.0" || host == "::":
		host = "localhost"
	case isLoopbackName(host):
	default:
		return Target{}, ErrNotLocal
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return Target{}, ErrNotLocal
	}
	origin := &url.URL{Scheme: u.Scheme, Host: net.JoinHostPort(host, port)}
	path := u.EscapedPath()
	if path == "" || path[0] != '/' {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return Target{Origin: origin, Path: path, Port: n}, nil
}

// isLoopbackName reports a host that can only mean this machine.
func isLoopbackName(h string) bool {
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// Start shares the dev server at raw, or returns the share already open for
// its origin (its idle clock restarted).
func (m *Manager) Start(raw string) (Share, error) {
	t, err := ParseTarget(raw)
	if err != nil {
		return Share{}, err
	}
	if m.opt.Forbid(t.Port) {
		return Share{}, ErrOwnPort
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Share{}, ErrClosed
	}
	for _, s := range m.shares {
		if s.target.String() == t.Origin.String() {
			s.touch(m.opt.Now())
			return s.public(m.opt), nil
		}
	}
	if len(m.shares) >= m.opt.Max {
		return Share{}, ErrTooMany
	}
	ip, err := m.opt.Address()
	if err != nil || ip == nil {
		return Share{}, ErrNoAddress
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		return Share{}, fmt.Errorf("could not listen on %s: %w", ip, err)
	}
	s := newShare(t, ln, lan.Tunnelled(ip), m.opt)
	m.shares[s.id] = s
	go s.serve(m.opt.Log)
	if len(m.shares) == 1 {
		m.stop = make(chan struct{})
		go m.sweepLoop(m.stop)
	}
	m.opt.Log.Info("sharing a dev server on the local network", "component", "devshare", "target", s.target.String(), "address", s.addr)
	return s.public(m.opt), nil
}

// List returns the open shares, oldest first.
func (m *Manager) List() []Share {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Share, 0, len(m.shares))
	for _, s := range m.shares {
		out = append(out, s.public(m.opt))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// Stop ends one share; false when there was none by that id.
func (m *Manager) Stop(id string) bool {
	m.mu.Lock()
	s, ok := m.shares[id]
	if ok {
		m.removeLocked(id)
	}
	m.mu.Unlock()
	if ok {
		s.close()
		m.opt.Log.Info("stopped sharing a dev server", "component", "devshare", "target", s.target.String())
	}
	return ok
}

// Sweep ends every share past its idle time or its longest life. The loop
// calls it every Options.Sweep; tests call it after moving the clock.
func (m *Manager) Sweep() []string {
	now := m.opt.Now()
	var done []*share
	m.mu.Lock()
	for id, s := range m.shares {
		if !now.Before(s.expires(m.opt)) {
			done = append(done, s)
			m.removeLocked(id)
		}
	}
	m.mu.Unlock()
	ids := make([]string, 0, len(done))
	for _, s := range done {
		s.close()
		ids = append(ids, s.id)
		m.opt.Log.Info("a shared dev server went unused and stopped", "component", "devshare", "target", s.target.String())
	}
	return ids
}

// Close ends every share; the Manager refuses new ones after.
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	all := make([]*share, 0, len(m.shares))
	for id, s := range m.shares {
		all = append(all, s)
		m.removeLocked(id)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.close()
	}
}

func (m *Manager) removeLocked(id string) {
	delete(m.shares, id)
	if len(m.shares) == 0 && m.stop != nil {
		close(m.stop)
		m.stop = nil
	}
}

func (m *Manager) sweepLoop(stop chan struct{}) {
	t := time.NewTicker(m.opt.Sweep)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			m.Sweep()
		}
	}
}

// ---------------------------------------------------------------------------
// One share

type share struct {
	id, token string
	target    *url.URL
	path      string
	addr      string // host:port the phone reaches
	pub       string // http://addr
	tunnelled bool
	started   time.Time
	maxAge    time.Duration
	last      atomic.Int64 // unix nanos
	now       func() time.Time
	ln        net.Listener
	srv       *http.Server
	proxy     *httputil.ReverseProxy
	conns     sync.Map // *conn → struct{}
	closeOnce sync.Once
}

func newShare(t Target, ln net.Listener, tunnelled bool, opt Options) *share {
	s := &share{
		id:        randHex(8),
		token:     randToken(),
		target:    t.Origin,
		path:      t.Path,
		addr:      ln.Addr().String(),
		tunnelled: tunnelled,
		started:   opt.Now(),
		maxAge:    opt.MaxAge,
		now:       opt.Now,
	}
	s.pub = "http://" + s.addr
	s.last.Store(s.started.UnixNano())
	s.ln = &listener{Listener: ln, s: s}
	s.proxy = s.newProxy()
	s.srv = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if cc, ok := c.(*conn); ok {
				return context.WithValue(ctx, connKey{}, cc)
			}
			return ctx
		},
	}
	return s
}

func (s *share) serve(log *slog.Logger) {
	if err := s.srv.Serve(s.ln); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
		log.Warn("a dev-server share stopped", "component", "devshare", "err", err)
	}
}

func (s *share) touch(t time.Time) { s.last.Store(t.UnixNano()) }

func (s *share) lastUsed() time.Time { return time.Unix(0, s.last.Load()) }

func (s *share) expires(opt Options) time.Time {
	idle := s.lastUsed().Add(opt.Idle)
	hard := s.started.Add(opt.MaxAge)
	if hard.Before(idle) {
		return hard
	}
	return idle
}

func (s *share) public(opt Options) Share {
	return Share{
		ID:         s.id,
		Target:     s.target.String(),
		Path:       s.path,
		URL:        s.pub + OpenPrefix + s.token,
		Address:    s.addr,
		Tunnelled:  s.tunnelled,
		StartedAt:  s.started,
		LastUsedAt: s.lastUsed(),
		ExpiresAt:  s.expires(opt),
	}
}

// close shuts the listener and every connection it accepted, the hijacked
// WebSockets included (http.Server.Close leaves those alone).
func (s *share) close() {
	s.closeOnce.Do(func() {
		_ = s.srv.Close()
		// srv.Close closes only the listeners Serve has registered. A Stop
		// that lands before the Serve goroutine runs left the port
		// accepting (seen on a Windows runner, 2026-10-27), so the
		// listener is closed here too.
		_ = s.ln.Close()
		s.conns.Range(func(k, _ any) bool {
			_ = k.(*conn).Conn.Close()
			return true
		})
	})
}

func (s *share) cookieName() string { return "caprock_share_" + s.id }

// ServeHTTP is the gate in front of the proxy.
func (s *share) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// DNS rebinding: a name an attacker controls that resolves here carries
	// its own Host. Only the address the QR named is answered.
	if !strings.EqualFold(r.Host, s.addr) {
		http.Error(w, "this address is not shared", http.StatusMisdirectedRequest)
		return
	}
	if r.Method == http.MethodConnect {
		http.Error(w, "not a proxy", http.StatusMethodNotAllowed)
		return
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, OpenPrefix); ok {
		if !sameToken(rest, s.token) {
			s.refuse(w)
			return
		}
		s.authorize(r)
		http.SetCookie(w, &http.Cookie{
			Name: s.cookieName(), Value: s.token, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode, MaxAge: int(s.maxAge / time.Second),
		})
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// The page the share was started on, never one named by the request:
		// no open redirect.
		http.Redirect(w, r, s.path, http.StatusSeeOther)
		return
	}
	c, err := r.Cookie(s.cookieName())
	if err != nil || !sameToken(c.Value, s.token) {
		s.refuse(w)
		return
	}
	s.authorize(r)
	s.proxy.ServeHTTP(w, r)
}

// authorize marks the request's connection as the phone's, so its WebSocket
// traffic keeps the share alive, and counts the request as use.
func (s *share) authorize(r *http.Request) {
	s.touch(s.now())
	if c, ok := r.Context().Value(connKey{}).(*conn); ok {
		c.ok.Store(true)
	}
}

func (s *share) refuse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_, _ = io.WriteString(w, refusedPage)
}

const refusedPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not shared</title>` +
	`<body style="font:16px/1.45 -apple-system,system-ui,sans-serif;margin:32px 20px;color:#222">` +
	`<h1 style="font-size:20px">This page is not shared with this phone</h1>` +
	`<p>Scan the QR code in Caprock again. Sharing may have stopped: it ends after 30 minutes without use, or when someone presses Stop sharing.</p>`

func sameToken(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---------------------------------------------------------------------------
// The proxy

func (s *share) newProxy() *httputil.ReverseProxy {
	tr := &http.Transport{
		Proxy:                 nil, // never an environment proxy
		DialContext:           s.dial,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
		// An https dev server on loopback is self-signed as a rule; the
		// connection never leaves the machine.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: s.target.Hostname()}, //nolint:gosec // loopback only, ADR-087
	}
	origin := s.target.Scheme + "://" + s.target.Host
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(s.target)
			pr.Out.Host = s.target.Host
			h := pr.Out.Header
			if o := h.Get("Origin"); o != "" && strings.EqualFold(o, s.pub) {
				h.Set("Origin", origin)
			}
			if ref := h.Get("Referer"); strings.HasPrefix(ref, s.pub+"/") || ref == s.pub {
				h.Set("Referer", origin+strings.TrimPrefix(ref, s.pub))
			}
			stripCookie(h, s.cookieName())
			// Identity, so a text answer's localhost spellings can be read.
			h.Del("Accept-Encoding")
			h.Set("Via", ViaMark)
		},
		Transport:      tr,
		FlushInterval:  -1, // EventSource and streamed HTML flow as they come
		ModifyResponse: s.modifyResponse,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprintf(w, "The dev server at %s did not answer. Is it still running on the computer?\n", origin)
		},
	}
}

// dial reaches the target and nothing else: the address the request names is
// ignored. A name is tried on 127.0.0.1 and then [::1], since a Node server
// on macOS often listens on ::1 alone.
func (s *share) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	host, port := s.target.Hostname(), s.target.Port()
	var cands []string
	if ip := net.ParseIP(host); ip != nil {
		cands = []string{host}
	} else {
		cands = []string{"127.0.0.1", "::1"}
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	var last error
	for _, h := range cands {
		ip := net.ParseIP(h)
		if ip == nil || !ip.IsLoopback() {
			continue
		}
		c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(h, port))
		if err == nil {
			return c, nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("no loopback address to dial")
	}
	return nil, last
}

func stripCookie(h http.Header, name string) {
	vals := h.Values("Cookie")
	if len(vals) == 0 {
		return
	}
	var keep []string
	for _, v := range vals {
		for _, part := range strings.Split(v, ";") {
			p := strings.TrimSpace(part)
			if p == "" || strings.HasPrefix(p, name+"=") {
				continue
			}
			keep = append(keep, p)
		}
	}
	h.Del("Cookie")
	if len(keep) > 0 {
		h.Set("Cookie", strings.Join(keep, "; "))
	}
}

// spellings returns the target origin as a page may write it, and what each
// becomes on the share: https and wss turn into http and ws, since the phone
// reaches the share over plain http.
func (s *share) spellings() [][2]string {
	port := s.target.Port()
	hosts := []string{s.target.Hostname()}
	if isLoopbackName(s.target.Hostname()) {
		for _, h := range []string{"localhost", "127.0.0.1", "[::1]"} {
			if h != s.target.Hostname() {
				hosts = append(hosts, h)
			}
		}
	}
	var out [][2]string
	for _, h := range hosts {
		hp := h + ":" + port
		out = append(out,
			[2]string{"https://" + hp, "http://" + s.addr},
			[2]string{"wss://" + hp, "ws://" + s.addr},
			[2]string{"//" + hp, "//" + s.addr},
		)
	}
	return out
}

func (s *share) rewrite(b []byte) []byte {
	for _, sp := range s.spellings() {
		if bytes.Contains(b, []byte(sp[0])) {
			b = bytes.ReplaceAll(b, []byte(sp[0]), []byte(sp[1]))
		}
	}
	return b
}

func (s *share) rewriteString(v string) string { return string(s.rewrite([]byte(v))) }

func (s *share) modifyResponse(res *http.Response) error {
	if loc := res.Header.Get("Location"); loc != "" {
		res.Header.Set("Location", s.rewriteString(loc))
	}
	if cs := res.Header.Values("Set-Cookie"); len(cs) > 0 {
		res.Header.Del("Set-Cookie")
		for _, c := range cs {
			res.Header.Add("Set-Cookie", phoneCookie(c))
		}
	}
	if res.StatusCode == http.StatusSwitchingProtocols || !rewritable(res) {
		return nil
	}
	if res.ContentLength > rewriteMax {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, rewriteMax+1))
	if err != nil {
		return err
	}
	if len(body) > rewriteMax {
		// Too large to hold: hand it on as it came, what was read first.
		res.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(body), res.Body), res.Body}
		return nil
	}
	_ = res.Body.Close()
	out := s.rewrite(body)
	res.Body = io.NopCloser(bytes.NewReader(out))
	res.ContentLength = int64(len(out))
	res.Header.Set("Content-Length", strconv.Itoa(len(out)))
	return nil
}

// rewritable is an identity-encoded text answer that may name the origin.
func rewritable(res *http.Response) bool {
	if enc := res.Header.Get("Content-Encoding"); enc != "" && !strings.EqualFold(enc, "identity") {
		return false
	}
	mt, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	switch {
	case mt == "text/html", mt == "text/css", mt == "application/json", mt == "application/manifest+json":
		return true
	case strings.HasSuffix(mt, "javascript"), mt == "text/ecmascript":
		return true
	}
	return false
}

// phoneCookie drops what would stop a phone on plain http keeping a dev
// server's cookie: a Domain naming localhost, and Secure.
func phoneCookie(c string) string {
	parts := strings.Split(c, ";")
	out := parts[:1]
	for _, p := range parts[1:] {
		k, v, _ := strings.Cut(strings.TrimSpace(p), "=")
		switch strings.ToLower(k) {
		case "secure":
			continue
		case "domain":
			if isLoopbackName(strings.TrimPrefix(strings.ToLower(v), ".")) {
				continue
			}
		}
		out = append(out, p)
	}
	return strings.Join(out, ";")
}

// ---------------------------------------------------------------------------
// Connections

type connKey struct{}

// listener wraps each accepted connection so the share can count a phone's
// traffic and close every connection, WebSockets included, when it ends.
type listener struct {
	net.Listener
	s *share
}

func (l *listener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	cc := &conn{Conn: c, s: l.s}
	l.s.conns.Store(cc, struct{}{})
	return cc, nil
}

type conn struct {
	net.Conn
	s    *share
	ok   atomic.Bool // a request on it carried the cookie
	gone sync.Once
}

func (c *conn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 && c.ok.Load() {
		c.s.touch(c.s.now())
	}
	return n, err
}

func (c *conn) Close() error {
	c.gone.Do(func() { c.s.conns.Delete(c) })
	return c.Conn.Close()
}

func randToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
