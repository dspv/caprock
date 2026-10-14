package mail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
)

// Sign in with Google or Microsoft (ADR-057). The screen asks
// POST /v1/mail/oauth/start for the provider's page and opens it in the
// browser; the provider sends the browser back to GET /v1/mail/oauth/callback
// on this daemon, which exchanges the code, checks IMAP and SMTP, stores the
// refresh token in the secret store and creates (or switches) the account.
// The screen notices through the account list it already polls.

// flowTTL is how long a started sign-in waits for the browser.
var flowTTL = 10 * time.Minute

type oauthFlow struct {
	id       string // what the screen polls, never the state
	provider string
	verifier string
	redirect string
	expires  time.Time
}

// oauthOutcome is how a sign-in ended, kept for the screen to read.
type oauthOutcome struct {
	Status string `json:"status"` // pending | ok | error | expired
	Email  string `json:"email,omitempty"`
	Error  string `json:"error,omitempty"`
	at     time.Time
}

// oauthFlows holds started sign-ins by state, in memory only. A state is
// used once: taken out on the first callback that names it, whatever happens
// next. How each ended is kept by flow id for flowTTL, so the import screen
// can say connected or why not.
type oauthFlows struct {
	mu    sync.Mutex
	flows map[string]oauthFlow
	done  map[string]oauthOutcome
}

// finish records how the flow id ended.
func (f *oauthFlows) finish(id string, o oauthOutcome) {
	if id == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.done == nil {
		f.done = map[string]oauthOutcome{}
	}
	now := time.Now()
	for k, v := range f.done {
		if now.Sub(v.at) > flowTTL {
			delete(f.done, k)
		}
	}
	o.at = now
	f.done[id] = o
}

// status is the flow id's outcome: pending while its browser has not come
// back, expired when it never did (or the id is unknown).
func (f *oauthFlows) status(id string) oauthOutcome {
	f.mu.Lock()
	defer f.mu.Unlock()
	if o, ok := f.done[id]; ok {
		return o
	}
	now := time.Now()
	for _, fl := range f.flows {
		if fl.id == id && id != "" {
			if now.After(fl.expires) {
				break
			}
			return oauthOutcome{Status: "pending"}
		}
	}
	return oauthOutcome{Status: "expired", Error: "The sign-in was not finished in time. Start it again."}
}

func (f *oauthFlows) put(state string, fl oauthFlow) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.flows == nil {
		f.flows = map[string]oauthFlow{}
	}
	now := time.Now()
	for k, v := range f.flows {
		if now.After(v.expires) {
			delete(f.flows, k)
		}
	}
	f.flows[state] = fl
}

func (f *oauthFlows) take(state string) (oauthFlow, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fl, ok := f.flows[state]
	delete(f.flows, state)
	if !ok || time.Now().After(fl.expires) {
		return oauthFlow{}, false
	}
	return fl, true
}

func (s *Service) oauthRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /v1/mail/oauth/providers", s.oauthProviders)
	m.HandleFunc("POST /v1/mail/oauth/start", s.oauthStart)
	m.HandleFunc("GET /v1/mail/oauth/callback", s.oauthCallback)
	m.HandleFunc("GET /v1/mail/oauth/flow", s.oauthFlowStatus)
}

// oauthFlowStatus answers how the sign-in started as ?id= is going.
func (s *Service) oauthFlowStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.oauth.status(r.URL.Query().Get("id")))
}

// oauthProviders says which sign-in buttons work in this build.
func (s *Service) oauthProviders(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, oauth.Available())
}

// loopbackPort returns the port of a request that reached the daemon by a
// loopback name, or "" when it came another way (a paired phone): the
// provider sends the browser back to this machine's loopback, which only a
// browser on this machine can reach.
func loopbackPort(r *http.Request) string {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || port == "" {
		return ""
	}
	h := strings.ToLower(strings.Trim(host, "[]"))
	if h == "localhost" {
		return port
	}
	if ip := net.ParseIP(h); ip != nil && ip.IsLoopback() {
		return port
	}
	return ""
}

func (s *Service) oauthStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		// LoginHint is the address the import screen is connecting, so the
		// provider's page starts on that account.
		LoginHint string `json:"login_hint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	p, ok := oauth.Lookup(req.Provider)
	if !ok {
		fail(w, 400, fmt.Errorf("unknown provider %q", req.Provider))
		return
	}
	if p.ClientID == "" {
		fail(w, 409, fmt.Errorf("sign-in with %s is not set up in this build", p.Label))
		return
	}
	port := loopbackPort(r)
	if port == "" {
		fail(w, 403, errors.New("sign in on the computer Caprock runs on: the browser has to come back to it"))
		return
	}
	state := oauth.RandomString(24)
	verifier := oauth.RandomString(48) // 64 characters; RFC 7636 wants 43–128
	redirect := p.RedirectURI(port)
	id := oauth.RandomString(12)
	s.oauth.put(state, oauthFlow{id: id, provider: p.Name, verifier: verifier, redirect: redirect, expires: time.Now().Add(flowTTL)})
	writeJSON(w, map[string]string{"auth_url": p.AuthCodeURLHint(state, verifier, redirect, strings.TrimSpace(req.LoginHint)), "flow": id})
}

func (s *Service) oauthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if loopbackPort(r) == "" {
		oauthPage(w, 403, false, "This page only works on the computer Caprock runs on.")
		return
	}
	fl, ok := s.oauth.take(q.Get("state"))
	if !ok {
		oauthPage(w, 400, false, "This sign-in link has expired or was already used. Start again from Mail in Caprock.")
		return
	}
	p, _ := oauth.Lookup(fl.provider)
	failed := func(code int, msg string) {
		s.oauth.finish(fl.id, oauthOutcome{Status: "error", Error: msg})
		oauthPage(w, code, false, msg)
	}
	if e := q.Get("error"); e != "" {
		msg := q.Get("error_description")
		if msg == "" {
			msg = e
		}
		failed(400, p.Label+" did not sign you in: "+msg)
		return
	}
	code := q.Get("code")
	if code == "" {
		failed(400, "The answer from "+p.Label+" carried no code. Start again from Mail in Caprock.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	a, err := s.connectOAuth(ctx, p, code, fl)
	if err != nil {
		failed(502, err.Error())
		return
	}
	s.oauth.finish(fl.id, oauthOutcome{Status: "ok", Email: a.Email})
	oauthPage(w, 200, true, a.Email+" is connected. You can close this tab and go back to Caprock.")
}

// connectOAuth turns an authorization code into a working account.
func (s *Service) connectOAuth(ctx context.Context, p oauth.Provider, code string, fl oauthFlow) (store.Account, error) {
	t, err := p.Exchange(ctx, code, fl.verifier, fl.redirect)
	if err != nil {
		return store.Account{}, err
	}
	email, err := oauth.EmailFromIDToken(t.IDToken)
	if err != nil {
		return store.Account{}, err
	}
	if t.RefreshToken == "" {
		return store.Account{}, fmt.Errorf("%s gave no refresh token, so Caprock could not stay signed in. Remove Caprock's access in your %s account settings and sign in again", p.Label, p.Label)
	}
	a := store.Account{
		Email: email, Username: email, Auth: oauth.AuthPrefix + p.Name,
		IMAPHost: p.IMAPHost, IMAPPort: p.IMAPPort, IMAPTLS: p.IMAPTLS,
		SMTPHost: p.SMTPHost, SMTPPort: p.SMTPPort, SMTPTLS: p.SMTPTLS,
	}
	// Checked before anything is stored, like a password.
	if a, err = engine.TestAccount(a, t.AccessToken); err != nil {
		return a, err
	}
	a.Username = email
	s.leaveSample()
	st, eng, err := s.parts(ctx)
	if err != nil {
		return a, err
	}
	accts, err := st.Accounts(ctx)
	if err != nil {
		return a, err
	}
	var existing *store.Account
	for i := range accts {
		if strings.EqualFold(accts[i].Email, email) {
			existing = &accts[i]
			break
		}
	}
	if existing != nil {
		// Same address again: switch it to this sign-in, keep its mail,
		// name, colour and signature.
		cur := *existing
		cur.Username, cur.IMAPHost, cur.IMAPPort, cur.IMAPTLS = a.Username, a.IMAPHost, a.IMAPPort, a.IMAPTLS
		cur.SMTPHost, cur.SMTPPort, cur.SMTPTLS = a.SMTPHost, a.SMTPPort, a.SMTPTLS
		if err := s.sec.Set(cur.ID, t.RefreshToken); err != nil {
			return a, fmt.Errorf("keychain: %w", err)
		}
		if err := st.UpdateAccount(ctx, cur); err != nil {
			return a, err
		}
		if err := st.SetAuth(ctx, cur.ID, a.Auth); err != nil {
			return a, err
		}
		cur.Auth = a.Auth
		a = cur
	} else {
		id, err := st.AddAccount(ctx, a)
		if err != nil {
			return a, err
		}
		if err := s.sec.Set(id, t.RefreshToken); err != nil {
			_ = st.DeleteAccount(ctx, id)
			return a, fmt.Errorf("keychain: %w", err)
		}
		a.ID = id
	}
	oauth.Remember(t)
	eng.StartAccount(a.ID)
	s.version.Add(1)
	return a, nil
}

// oauthPage is the small page the browser lands on: self-contained, no
// script, nothing loaded from anywhere.
func oauthPage(w http.ResponseWriter, code int, ok bool, msg string) {
	title, mark := "Could not connect", "&#x2715;"
	if ok {
		title, mark = "Connected", "&#x2713;"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s · Caprock Mail</title>
<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f2;color:#1d1d1b}@media(prefers-color-scheme:dark){body{background:#1b1b1a;color:#ecebe7}}main{max-width:32rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}.m{font-size:2rem}</style></head>
<body><main><div class="m">%s</div><h1>%s</h1><p>%s</p></main></body></html>`, title, mark, title, html.EscapeString(msg))
}
