package devshare

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// clock is a test clock that only moves when told.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// loopback binds shares to 127.0.0.1: tests never open a real LAN listener.
func loopback() (net.IP, error) { return net.IPv4(127, 0, 0, 1), nil }

func newManager(t *testing.T, opts ...func(*Options)) (*Manager, *clock) {
	t.Helper()
	c := &clock{t: time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)}
	o := Options{Address: loopback, Now: c.Now, Sweep: time.Hour}
	for _, f := range opts {
		f(&o)
	}
	m := New(o)
	t.Cleanup(m.Close)
	return m, c
}

// upstream is a dev server on loopback that records what reached it.
type upstream struct {
	*httptest.Server
	mu   sync.Mutex
	reqs []*http.Request
}

func (u *upstream) last() *http.Request {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.reqs) == 0 {
		return nil
	}
	return u.reqs[len(u.reqs)-1]
}

func (u *upstream) count() int { u.mu.Lock(); defer u.mu.Unlock(); return len(u.reqs) }

func newUpstream(t *testing.T, h http.HandlerFunc) *upstream {
	t.Helper()
	u := &upstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.reqs = append(u.reqs, r.Clone(context.Background()))
		u.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(u.Close)
	return u
}

// localhostURL spells an httptest server's address as a dev server prints it.
func localhostURL(s *httptest.Server) string {
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(s.URL, "http://"))
	return "http://localhost:" + port
}

func noRedirect() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Timeout: 5 * time.Second}
}

func phone(t *testing.T) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 5 * time.Second}
}

func TestParseTarget(t *testing.T) {
	ok := map[string][2]string{
		"http://localhost:5173/":         {"http://localhost:5173", "/"},
		"localhost:3000":                 {"http://localhost:3000", "/"},
		"http://127.0.0.1:8000/a/b?x=1":  {"http://127.0.0.1:8000", "/a/b?x=1"},
		"http://app.localhost:5173/shop": {"http://app.localhost:5173", "/shop"},
		"http://[::1]:8080":              {"http://[::1]:8080", "/"},
		"http://0.0.0.0:5173":            {"http://localhost:5173", "/"},
		"https://localhost:5173":         {"https://localhost:5173", "/"},
		"http://localhost":               {"http://localhost:80", "/"},
	}
	for in, want := range ok {
		got, err := ParseTarget(in)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got.Origin.String() != want[0] || got.Path != want[1] {
			t.Errorf("%q = %s %s, want %s %s", in, got.Origin, got.Path, want[0], want[1])
		}
	}
	for _, in := range []string{"", "http://192.168.1.5:3000", "http://example.com", "file:///etc/passwd", "ftp://localhost:21", "http://user:pw@localhost:3000", "http://localhost.example.com:80", "http://10.0.0.1", "http://localhost:0", "http://localhost:99999"} {
		if _, err := ParseTarget(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

func TestTokenAndCookieGate(t *testing.T) {
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "page "+r.URL.Path) })
	m, _ := newManager(t)
	sh, err := m.Start(localhostURL(up.Server) + "/about?x=1")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + sh.Address

	// No cookie, no token: refused, nothing reaches the dev server.
	res, err := noRedirect().Get(base + "/about")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("no token: %d", res.StatusCode)
	}
	// A wrong token, same length and not.
	for _, tok := range []string{strings.Repeat("A", 43), "nope", ""} {
		res, err = noRedirect().Get(base + OpenPrefix + tok)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("wrong token %q: %d", tok, res.StatusCode)
		}
	}
	// A forged cookie.
	req, _ := http.NewRequest("GET", base+"/", nil)
	req.AddCookie(&http.Cookie{Name: "caprock_share_" + sh.ID, Value: strings.Repeat("A", 43)})
	res, err = noRedirect().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("forged cookie: %d", res.StatusCode)
	}
	if up.count() != 0 {
		t.Fatalf("the dev server was reached %d times without the token", up.count())
	}

	// The link: a cookie and a redirect to the page the tab showed.
	res, err = noRedirect().Get(sh.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/about?x=1" {
		t.Fatalf("open: %d %q", res.StatusCode, res.Header.Get("Location"))
	}
	if res.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("no Referrer-Policy on the link's answer")
	}
	var ck *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == "caprock_share_"+sh.ID {
			ck = c
		}
	}
	if ck == nil || !ck.HttpOnly || ck.SameSite != http.SameSiteLaxMode || ck.Path != "/" {
		t.Fatalf("cookie: %+v", ck)
	}

	// A phone following the link lands on the page.
	ph := phone(t)
	res, err = ph.Get(sh.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != 200 || string(b) != "page /about" {
		t.Fatalf("through the share: %d %q", res.StatusCode, b)
	}
}

func TestForwardsToTheOriginOnly(t *testing.T) {
	other := newUpstream(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "other") })
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "dev") })
	m, _ := newManager(t)
	sh, err := m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	ph := phone(t)
	if res, err := ph.Get(sh.URL); err != nil {
		t.Fatal(err)
	} else {
		_ = res.Body.Close()
	}
	u, _ := url.Parse("http://" + sh.Address)
	cookies := ph.Jar.Cookies(u)

	// The request names a path; `..` stays on the origin.
	req, _ := http.NewRequest("GET", "http://"+sh.Address+"/a/../../b", nil)
	req.Header.Set("Origin", "http://"+sh.Address)
	req.Header.Set("Referer", "http://"+sh.Address+"/from")
	req.Header.Set("Cookie", cookies[0].Name+"="+cookies[0].Value+"; theirs=1")
	res, err := noRedirect().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(b) != "dev" {
		t.Fatalf("got %q", b)
	}
	got := up.last()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(up.URL, "http://"))
	if got.Host != "localhost:"+port {
		t.Errorf("Host = %q, want localhost:%s", got.Host, port)
	}
	if o := got.Header.Get("Origin"); o != "http://localhost:"+port {
		t.Errorf("Origin = %q", o)
	}
	if ref := got.Header.Get("Referer"); ref != "http://localhost:"+port+"/from" {
		t.Errorf("Referer = %q", ref)
	}
	if v := got.Header.Get("Via"); v != ViaMark {
		t.Errorf("Via = %q", v)
	}
	if c := got.Header.Get("Cookie"); c != "theirs=1" {
		t.Errorf("Cookie reaching the dev server = %q (the share's must be removed)", c)
	}
	if got.Header.Get("Accept-Encoding") != "" {
		t.Errorf("Accept-Encoding forwarded: %q", got.Header.Get("Accept-Encoding"))
	}

	// An absolute-form request line naming another server is refused, by Host.
	raw, err := net.Dial("tcp", sh.Address)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	fmt.Fprintf(raw, "GET %s/ HTTP/1.1\r\nHost: %s\r\nCookie: %s=%s\r\nConnection: close\r\n\r\n", other.URL, sh.Address, cookies[0].Name, cookies[0].Value)
	resp, err := http.ReadResponse(bufio.NewReader(raw), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("absolute-form to another server: %d", resp.StatusCode)
	}
	// A Host that is not the share's (DNS rebinding).
	req, _ = http.NewRequest("GET", "http://"+sh.Address+"/", nil)
	req.Host = "evil.example:80"
	req.AddCookie(cookies[0])
	res, err = noRedirect().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusMisdirectedRequest {
		t.Errorf("foreign Host: %d", res.StatusCode)
	}
	// CONNECT is not a tunnel.
	req, _ = http.NewRequest("CONNECT", "http://"+sh.Address, nil)
	req.AddCookie(cookies[0])
	res, err = noRedirect().Do(req)
	if err == nil {
		_ = res.Body.Close()
		if res.StatusCode != http.StatusMethodNotAllowed && res.StatusCode != http.StatusMisdirectedRequest {
			t.Errorf("CONNECT: %d", res.StatusCode)
		}
	}
	if other.count() != 0 {
		t.Fatalf("another server was reached %d times", other.count())
	}
}

func TestRewritesLocalhostSpellings(t *testing.T) {
	var origin string
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/go":
			http.Redirect(w, r, origin+"/landed", http.StatusFound)
		case "/js":
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, `new WebSocket("ws://localhost:`+portOf(origin)+`/hmr")`)
		case "/bin":
			w.Header().Set("Content-Type", "image/png")
			_, _ = io.WriteString(w, origin)
		default:
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "1", Domain: "localhost", Secure: true, Path: "/"})
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, `<a href="`+origin+`/x">x</a> <img src="http://127.0.0.1:`+portOf(origin)+`/i.png">`)
		}
	})
	origin = localhostURL(up.Server)
	m, _ := newManager(t)
	sh, err := m.Start(origin)
	if err != nil {
		t.Fatal(err)
	}
	ph := phone(t)
	res, err := ph.Get(sh.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	pub := "http://" + sh.Address
	if want := `<a href="` + pub + `/x">x</a> <img src="` + pub + `/i.png">`; string(b) != want {
		t.Errorf("html = %q, want %q", b, want)
	}
	if sc := res.Header.Get("Set-Cookie"); strings.Contains(strings.ToLower(sc), "domain=localhost") || strings.Contains(strings.ToLower(sc), "secure") {
		t.Errorf("Set-Cookie kept what a phone cannot keep: %q", sc)
	}
	get := func(p string) (*http.Response, string) {
		u, _ := url.Parse(pub)
		req, _ := http.NewRequest("GET", pub+p, nil)
		for _, c := range ph.Jar.Cookies(u) {
			req.AddCookie(c)
		}
		res, err := noRedirect().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		return res, string(b)
	}
	if _, js := get("/js"); js != `new WebSocket("ws://`+sh.Address+`/hmr")` {
		t.Errorf("js = %q", js)
	}
	if r, _ := get("/go"); r.Header.Get("Location") != pub+"/landed" {
		t.Errorf("Location = %q", r.Header.Get("Location"))
	}
	if _, bin := get("/bin"); bin != origin {
		t.Errorf("a binary answer was rewritten: %q", bin)
	}
}

func portOf(origin string) string {
	u, _ := url.Parse(origin)
	return u.Port()
}

func TestWebSocketForwarded(t *testing.T) {
	var gotHost, gotOrigin string
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotOrigin = r.Host, r.Header.Get("Origin")
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"localhost:*"}})
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		for {
			typ, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			_ = c.Write(context.Background(), typ, append([]byte("echo "), b...))
		}
	})
	m, clk := newManager(t)
	sh, err := m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	ph := phone(t)
	if res, err := ph.Get(sh.URL); err != nil {
		t.Fatal(err)
	} else {
		_ = res.Body.Close()
	}
	u, _ := url.Parse("http://" + sh.Address)
	hdr := http.Header{}
	for _, c := range ph.Jar.Cookies(u) {
		hdr.Add("Cookie", c.Name+"="+c.Value)
	}
	hdr.Set("Origin", "http://"+sh.Address)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Without the cookie the upgrade is refused.
	if _, _, err := websocket.Dial(ctx, "ws://"+sh.Address+"/hmr", nil); err == nil {
		t.Fatal("a WebSocket without the cookie got through")
	}

	c, _, err := websocket.Dial(ctx, "ws://"+sh.Address+"/hmr", &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if err := c.Write(ctx, websocket.MessageText, []byte("hi")); err != nil {
		t.Fatal(err)
	}
	_, b, err := c.Read(ctx)
	if err != nil || string(b) != "echo hi" {
		t.Fatalf("echo: %q %v", b, err)
	}
	if !strings.HasPrefix(gotHost, "localhost:") || !strings.HasPrefix(gotOrigin, "http://localhost:") {
		t.Errorf("upgrade reached the dev server as Host %q Origin %q", gotHost, gotOrigin)
	}

	// Traffic on the open socket is use: 20 minutes on, a message, 20 more,
	// and the share is still there.
	clk.Add(20 * time.Minute)
	_ = c.Write(ctx, websocket.MessageText, []byte("again"))
	if _, _, err := c.Read(ctx); err != nil {
		t.Fatal(err)
	}
	clk.Add(20 * time.Minute)
	if gone := m.Sweep(); len(gone) != 0 {
		t.Fatalf("a share in use was swept: %v", gone)
	}
	// Then nothing for the idle time: it ends, and the open socket with it.
	clk.Add(DefaultIdle)
	if gone := m.Sweep(); len(gone) != 1 {
		t.Fatalf("swept %v", gone)
	}
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("the WebSocket outlived its share")
	}
	if conn, err := net.DialTimeout("tcp", sh.Address, time.Second); err == nil {
		_ = conn.Close()
		t.Fatal("the share's port still accepts")
	}
}

func TestExpiryAndStop(t *testing.T) {
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") })
	m, clk := newManager(t)
	sh, err := m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	if !sh.ExpiresAt.Equal(sh.StartedAt.Add(DefaultIdle)) {
		t.Errorf("expires %v", sh.ExpiresAt)
	}
	// Knocking without the cookie does not keep it alive.
	clk.Add(DefaultIdle - time.Minute)
	if res, err := noRedirect().Get("http://" + sh.Address + "/"); err == nil {
		_ = res.Body.Close()
	}
	clk.Add(2 * time.Minute)
	if gone := m.Sweep(); len(gone) != 1 || gone[0] != sh.ID {
		t.Fatalf("idle share not swept: %v", gone)
	}
	if len(m.List()) != 0 {
		t.Fatal("still listed")
	}

	// The longest life holds even in use.
	sh, err = m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	ph := phone(t)
	for i := 0; i < 20; i++ {
		res, err := ph.Get(sh.URL)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		clk.Add(25 * time.Minute)
		m.Sweep()
	}
	if len(m.List()) != 0 {
		t.Fatal("a share outlived its longest life")
	}

	// Stop sharing.
	sh, err = m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	if !m.Stop(sh.ID) || m.Stop(sh.ID) {
		t.Fatal("stop")
	}
	if conn, err := net.DialTimeout("tcp", sh.Address, time.Second); err == nil {
		_ = conn.Close()
		t.Fatal("a stopped share still accepts")
	}
}

func TestStartRules(t *testing.T) {
	up := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {})
	m, _ := newManager(t, func(o *Options) { o.Forbid = func(p int) bool { return p == 22776 } })
	if _, err := m.Start("http://localhost:22776"); !errors.Is(err, ErrOwnPort) {
		t.Errorf("own port: %v", err)
	}
	if _, err := m.Start("http://192.168.1.5:5173"); !errors.Is(err, ErrNotLocal) {
		t.Errorf("LAN target: %v", err)
	}
	a, err := m.Start(localhostURL(up.Server))
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Start(localhostURL(up.Server) + "/other")
	if err != nil || b.ID != a.ID || b.URL != a.URL {
		t.Errorf("the same origin twice gave a second share: %v %v", a, b)
	}
	if strings.Contains(a.URL, "localhost") || !strings.HasPrefix(a.URL, "http://127.0.0.1:") {
		t.Errorf("link %q", a.URL)
	}
	if _, err := m.Start("http://localhost:1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("http://localhost:2"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("http://localhost:3"); !errors.Is(err, ErrTooMany) {
		t.Errorf("fourth: %v", err)
	}
	m2 := New(Options{Address: func() (net.IP, error) { return nil, ErrNoAddress }})
	defer m2.Close()
	if _, err := m2.Start("http://localhost:5173"); !errors.Is(err, ErrNoAddress) {
		t.Errorf("no address: %v", err)
	}
	m.Close()
	if _, err := m.Start("http://localhost:4"); !errors.Is(err, ErrClosed) {
		t.Errorf("after close: %v", err)
	}
}

func TestDevServerDown(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	m, _ := newManager(t)
	sh, err := m.Start(fmt.Sprintf("http://localhost:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	res, err := phone(t).Get(sh.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusBadGateway {
		t.Errorf("down: %d", res.StatusCode)
	}
}

func TestDialsIPv6Loopback(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback here")
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "v6") })}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()
	m, _ := newManager(t)
	sh, err := m.Start(fmt.Sprintf("http://localhost:%d", ln.Addr().(*net.TCPAddr).Port))
	if err != nil {
		t.Fatal(err)
	}
	res, err := phone(t).Get(sh.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(b) != "v6" {
		t.Errorf("got %d %q", res.StatusCode, b)
	}
}

func TestPickAddress(t *testing.T) {
	ts := net.IPv4(100, 101, 102, 103)
	wifi := net.IPv4(192, 168, 1, 5)
	if ip, _ := pick([]net.IP{ts, wifi}); !ip.Equal(wifi) {
		t.Errorf("picked %v over the Wi-Fi address", ip)
	}
	if ip, _ := pick([]net.IP{ts}); !ip.Equal(ts) {
		t.Errorf("picked %v", ip)
	}
	if _, err := pick(nil); !errors.Is(err, ErrNoAddress) {
		t.Errorf("none: %v", err)
	}
}

func TestPhoneCookie(t *testing.T) {
	for in, want := range map[string]string{
		"a=1; Domain=localhost; Secure; Path=/": "a=1; Path=/",
		"a=1; Domain=.localhost; HttpOnly":      "a=1; HttpOnly",
		"a=1; Domain=example.com":               "a=1; Domain=example.com",
		"a=1":                                   "a=1",
	} {
		if got := phoneCookie(in); got != want {
			t.Errorf("%q = %q, want %q", in, got, want)
		}
	}
}
