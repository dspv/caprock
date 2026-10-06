package github

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/projects"
)

// FrameGitHub is the live frame this package sends: {kind: "account",
// account: Status} when the connection changes, {kind: "pr", pr: PR} when a
// worktree's pull request does, {kind: "pr_gone", project_id, worktree} when
// one is no longer followed.
const FrameGitHub bus.FrameType = "github"

// Polling bounds. A followed pull request is asked about at most once a
// minute, and less often while nothing changes (up to MaxPoll); a push, a new
// pull request or a person pressing Refresh asks sooner, never more often
// than kickGap.
const (
	MinPoll = 60 * time.Second
	MaxPoll = 8 * time.Minute
	kickGap = 10 * time.Second
	// ghTokenTTL is how long the GitHub CLI's token is kept in memory before
	// gh is asked again; a 401 asks again at once.
	ghTokenTTL = 10 * time.Minute
	// userEvery is how often /user is read while connected, so the health
	// line's "last worked" and a revoked token are current without any PR.
	userEvery = 10 * time.Minute
)

// Config is where the choice of source and the client id live
// (config.json). The token itself is never there.
type Config interface {
	Source() string
	SetSource(string) error
	ClientID() string
	Notify() bool
	SetNotify(bool) error
}

// Worktrees is what the service needs from the projects list
// (projects.Service).
type Worktrees interface {
	List(ctx context.Context) ([]projects.View, error)
	Changes(ctx context.Context, id int64, worktree string) (projects.Changes, error)
	Push(ctx context.Context, id int64, worktree string) (projects.RemoteResult, projects.Changes, error)
	AddRemote(ctx context.Context, id int64, name, url string) (projects.Changes, error)
	Subjects(ctx context.Context, id int64, worktree, base string) ([]string, error)
}

// TokenSource is the GitHub CLI (GHCLI) or a test's stand-in.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
	Found() bool
}

// User is the account the token belongs to.
type User struct {
	Login     string `json:"login"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
	HTMLURL   string `json:"html_url,omitempty"`
}

// Health is the line Settings shows: when GitHub last answered, the last
// error with what was being done, the rate limit, and any pause.
type Health struct {
	LastOKAt    int64  `json:"last_ok_at,omitempty"`
	Error       *Error `json:"error,omitempty"`
	Rate        *Rate  `json:"rate,omitempty"`
	PausedUntil int64  `json:"paused_until,omitempty"`
}

// Sources says which sources exist here, without reading a token.
type Sources struct {
	GH     bool   `json:"gh"`               // the GitHub CLI is installed
	Stored bool   `json:"stored"`           // Caprock holds a token
	Store  string `json:"store"`            // keychain | file
	OAuth  bool   `json:"oauth"`            // a client id is configured
	Client string `json:"client,omitempty"` // that client id (public)
}

// Status is GET /v1/github.
type Status struct {
	Connected bool   `json:"connected"`
	Source    string `json:"source,omitempty"`
	User      *User  `json:"user,omitempty"`
	// Scopes are a classic or OAuth token's; ScopesKnown is false for a
	// fine-grained token, whose permissions GitHub does not list.
	Scopes      []string `json:"scopes"`
	ScopesKnown bool     `json:"scopes_known"`
	TokenKind   string   `json:"token_kind,omitempty"`
	CheckedAt   int64    `json:"checked_at,omitempty"`
	Sources     Sources  `json:"sources"`
	Health      Health   `json:"health"`
	Device      *Device  `json:"device,omitempty"`
	Notify      bool     `json:"notify"`
	Tracked     int      `json:"tracked"`
}

// Service is the integration. Fill the exported fields, then Start.
type Service struct {
	API, Web string
	HTTP     *http.Client
	Store    TokenStore
	GH       TokenSource
	Config   Config
	Projects Worktrees
	Bus      *bus.Bus
	Log      *slog.Logger
	Now      func() time.Time
	// Sleep waits between device-flow polls; tests shorten it.
	Sleep func(context.Context, time.Duration) bool

	c    *client
	once sync.Once
	ctx  context.Context
	kick chan struct{}

	mu        sync.Mutex
	tok       string // the token in use, in memory only
	tokSource string
	tokAt     time.Time
	stored    bool
	user      *User
	scopes    []string
	scopesOK  bool
	kind      string
	checkedAt int64
	lastOK    int64
	lastErr   *Error
	userAt    time.Time

	device       *Device
	deviceCancel context.CancelFunc

	track *tracker
}

func (s *Service) init() {
	s.once.Do(func() {
		if s.API == "" {
			s.API = DefaultAPI
		}
		if s.Web == "" {
			s.Web = DefaultWeb
		}
		if s.HTTP == nil {
			s.HTTP = &http.Client{Timeout: 20 * time.Second}
		}
		if s.Now == nil {
			s.Now = time.Now
		}
		if s.Log == nil {
			s.Log = slog.Default()
		}
		if s.Sleep == nil {
			s.Sleep = sleepCtx
		}
		if s.ctx == nil {
			s.ctx = context.Background()
		}
		s.c = newClient(s.API, s.HTTP, s.Now)
		s.kick = make(chan struct{}, 1)
		s.track = newTracker()
	})
}

// Start reads whether a token is stored and starts following pull requests.
// Nothing is sent to GitHub unless a source was chosen.
func (s *Service) Start(ctx context.Context) {
	s.ctx = ctx
	s.init()
	if s.Store != nil {
		if t, err := s.Store.Get(ctx); err == nil && t != "" {
			s.mu.Lock()
			s.stored = true
			s.mu.Unlock()
		} else if err != nil {
			s.Log.Warn("github: reading the stored token failed", "component", "github", "err", err)
		}
	}
	go s.loop(ctx)
	s.Kick(0)
}

// source is the chosen source, "" when not connected.
func (s *Service) source() string {
	if s.Config == nil {
		return ""
	}
	return s.Config.Source()
}

// token is the token to send for doing, from the chosen source.
func (s *Service) token(ctx context.Context, doing string) (string, string, *Error) {
	src := s.source()
	if src == "" {
		return "", "", errorf(KindNotConnected, doing, "GitHub is not connected. Connect it in Settings → GitHub.")
	}
	s.mu.Lock()
	if s.tok != "" && s.tokSource == src && (src != SourceGH || s.Now().Sub(s.tokAt) < ghTokenTTL) {
		t := s.tok
		s.mu.Unlock()
		return t, src, nil
	}
	s.mu.Unlock()
	var tok string
	var err error
	switch src {
	case SourceGH:
		if s.GH == nil {
			return "", src, errorf(KindNotConnected, doing, "the GitHub CLI is not available here")
		}
		tok, err = s.GH.Token(ctx)
	default:
		if s.Store == nil {
			return "", src, errorf(KindNotConnected, doing, "no token store")
		}
		tok, err = s.Store.Get(ctx)
		if err == nil && tok == "" {
			err = errors.New("the stored token is gone (removed from the " + s.Store.Kind() + "); connect GitHub again in Settings → GitHub")
		}
	}
	if err != nil {
		return "", src, errorf(KindNotConnected, doing, "%s", err.Error())
	}
	s.mu.Lock()
	s.tok, s.tokSource, s.tokAt = tok, src, s.Now()
	s.mu.Unlock()
	return tok, src, nil
}

// dropToken forgets the token in memory, so the next call reads it again.
func (s *Service) dropToken() {
	s.mu.Lock()
	s.tok, s.tokSource = "", ""
	s.mu.Unlock()
}

// call sends r with the chosen source's token and records the outcome on
// the health line. A 401 with the GitHub CLI's token reads it again once
// (the user may have run gh auth login since).
func (s *Service) call(ctx context.Context, r request) (response, *Error) {
	s.init()
	tok, src, e := s.token(ctx, r.doing)
	if e != nil {
		s.noteErr(e)
		return response{}, e
	}
	r.token, r.source = tok, src
	res, e := s.c.do(ctx, r)
	if e != nil && e.Kind == KindAuth && src == SourceGH {
		s.dropToken()
		if tok2, _, e2 := s.token(ctx, r.doing); e2 == nil && tok2 != tok {
			r.token = tok2
			res, e = s.c.do(ctx, r)
		}
	}
	if e != nil {
		if e.Kind == KindAuth {
			s.dropToken()
		}
		s.noteErr(e)
		return response{}, e
	}
	s.noteOK()
	return res, nil
}

func (s *Service) noteOK() {
	s.mu.Lock()
	s.lastOK = s.Now().UnixMilli()
	s.lastErr = nil
	s.mu.Unlock()
}

func (s *Service) noteErr(e *Error) {
	if e.Kind == KindNotConnected && s.source() == "" {
		return // not connected is a state, not an error on the health line
	}
	s.mu.Lock()
	s.lastErr = e
	s.mu.Unlock()
	s.Log.Info("github call failed", "component", "github", "doing", e.Doing, "kind", e.Kind, "status", e.Status)
}

// readUser reads /user with tok (not yet the chosen source's, when
// connecting) and the scopes its answer carries.
func (s *Service) readUser(ctx context.Context, tok, src, doing string) (*User, []string, bool, *Error) {
	res, e := s.c.do(ctx, request{method: http.MethodGet, path: "/user", doing: doing, token: tok, source: src})
	if e != nil {
		return nil, nil, false, e
	}
	var u User
	if e := decode(res, doing, &u); e != nil {
		return nil, nil, false, e
	}
	_, known := res.header[http.CanonicalHeaderKey("X-OAuth-Scopes")]
	scopes := splitList(res.header.Get("X-OAuth-Scopes"), ",")
	return &u, scopes, known, nil
}

// refreshUser reads the account with the chosen source's token.
func (s *Service) refreshUser(ctx context.Context) *Error {
	tok, src, e := s.token(ctx, "Reading your GitHub account")
	if e != nil {
		s.noteErr(e)
		return e
	}
	u, scopes, known, e := s.readUser(ctx, tok, src, "Reading your GitHub account")
	if e != nil && e.Kind == KindAuth && src == SourceGH {
		s.dropToken()
		if tok2, _, e2 := s.token(ctx, "Reading your GitHub account"); e2 == nil && tok2 != tok {
			tok = tok2
			u, scopes, known, e = s.readUser(ctx, tok, src, "Reading your GitHub account")
		}
	}
	if e != nil {
		s.noteErr(e)
		return e
	}
	s.mu.Lock()
	s.user, s.scopes, s.scopesOK, s.kind = u, scopes, known, tokenKind(tok)
	s.checkedAt = s.Now().UnixMilli()
	s.userAt = s.Now()
	s.mu.Unlock()
	s.noteOK()
	return nil
}

// Status is the connection as Settings shows it. It sends nothing.
func (s *Service) Status() Status {
	s.init()
	src := s.source()
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{Connected: src != "", Source: src, Scopes: []string{}}
	if src != "" {
		st.User, st.ScopesKnown, st.TokenKind, st.CheckedAt = s.user, s.scopesOK, s.kind, s.checkedAt
		if s.scopes != nil {
			st.Scopes = append(st.Scopes, s.scopes...)
		}
		st.Health = Health{LastOKAt: s.lastOK, Error: s.lastErr}
		if r, paused := s.c.rate(); r.Limit > 0 || paused > 0 {
			if r.Limit > 0 {
				st.Health.Rate = &r
			}
			st.Health.PausedUntil = paused
		}
	}
	st.Sources.Stored = s.stored
	if s.Store != nil {
		st.Sources.Store = s.Store.Kind()
	}
	if s.GH != nil {
		st.Sources.GH = s.GH.Found()
	}
	if s.Config != nil {
		st.Sources.Client = s.Config.ClientID()
		st.Sources.OAuth = st.Sources.Client != ""
		st.Notify = s.Config.Notify()
	}
	if s.device != nil {
		d := *s.device
		st.Device = &d
	}
	st.Tracked = s.track.count()
	return st
}

// publishAccount tells every open window the connection changed.
func (s *Service) publishAccount() {
	if s.Bus != nil {
		s.Bus.Publish(bus.Frame{Type: FrameGitHub, Data: map[string]any{"kind": "account", "account": s.Status()}})
	}
}

// Connect switches to a source after proving its token works: the GitHub
// CLI's login, or a pasted token (stored only once GitHub accepted it).
func (s *Service) Connect(ctx context.Context, source, pasted string) (Status, *Error) {
	s.init()
	const doing = "Connecting GitHub"
	var tok string
	switch source {
	case SourceGH:
		if s.GH == nil {
			return Status{}, errorf(KindNotConnected, doing, "%s", ErrGHMissing.Error())
		}
		t, err := s.GH.Token(ctx)
		if err != nil {
			return Status{}, errorf(KindNotConnected, doing, "%s", err.Error())
		}
		tok = t
	case SourceToken:
		tok = strings.TrimSpace(pasted)
		if err := checkPasted(tok); err != nil {
			return Status{}, errorf(KindInvalid, doing, "%s", err.Error())
		}
	default:
		return Status{}, errorf(KindInvalid, doing, "unknown source %q; use gh or token (the device flow has its own endpoint)", source)
	}
	u, scopes, known, e := s.readUser(ctx, tok, source, doing)
	if e != nil {
		s.noteErr(e)
		return Status{}, e
	}
	if err := s.adopt(ctx, source, tok); err != nil {
		return Status{}, errorf(KindState, doing, "%s", err.Error())
	}
	s.mu.Lock()
	s.user, s.scopes, s.scopesOK, s.kind = u, scopes, known, tokenKind(tok)
	s.checkedAt = s.Now().UnixMilli()
	s.userAt = s.Now()
	s.mu.Unlock()
	s.noteOK()
	s.publishAccount()
	s.Kick(0)
	return s.Status(), nil
}

// adopt makes source the one in use. Caprock holds at most one token: a
// pasted or device-flow token replaces the stored one, and choosing the
// GitHub CLI removes it.
func (s *Service) adopt(ctx context.Context, source, tok string) error {
	if s.Store != nil {
		var err error
		if source == SourceGH {
			err = s.Store.Delete(ctx)
		} else {
			err = s.Store.Set(ctx, tok)
		}
		if err != nil {
			return errors.New("could not keep the token in the " + s.Store.Kind() + ": " + err.Error())
		}
		s.mu.Lock()
		s.stored = source != SourceGH
		s.mu.Unlock()
	}
	if err := s.Config.SetSource(source); err != nil {
		return err
	}
	s.c.forgetCache()
	s.mu.Lock()
	s.tok, s.tokSource, s.tokAt = tok, source, s.Now()
	s.lastErr = nil
	s.mu.Unlock()
	return nil
}

// Disconnect stops using GitHub and removes what Caprock stored: the token
// it holds, if any. The GitHub CLI's own login is never touched.
func (s *Service) Disconnect(ctx context.Context) (Status, error) {
	s.init()
	s.CancelDevice()
	if s.Store != nil {
		if err := s.Store.Delete(ctx); err != nil {
			return Status{}, errors.New("could not remove the token from the " + s.Store.Kind() + ": " + err.Error())
		}
	}
	if err := s.Config.SetSource(""); err != nil {
		return Status{}, err
	}
	s.c.forget()
	s.mu.Lock()
	s.stored = false
	s.tok, s.tokSource = "", ""
	s.user, s.scopes, s.scopesOK, s.kind, s.checkedAt = nil, nil, false, "", 0
	s.lastOK, s.lastErr = 0, nil
	s.device = nil
	s.mu.Unlock()
	for _, k := range s.track.clear() {
		s.publishGone(k)
	}
	s.publishAccount()
	return s.Status(), nil
}

// SetNotify switches the CI and review notifications.
func (s *Service) SetNotify(on bool) (Status, error) {
	s.init()
	if err := s.Config.SetNotify(on); err != nil {
		return Status{}, err
	}
	return s.Status(), nil
}

// StartDevice begins the device flow: GitHub's code for the user to enter,
// then a background wait for the token.
func (s *Service) StartDevice(ctx context.Context) (Device, *Error) {
	s.init()
	clientID := ""
	if s.Config != nil {
		clientID = s.Config.ClientID()
	}
	if clientID == "" {
		return Device{}, errorf(KindDisabled, "Connecting GitHub", "signing in with GitHub needs a Caprock OAuth app; set github_client_id in config.json (docs/app.md § GitHub), or use the GitHub CLI or a token")
	}
	s.CancelDevice()
	dc, e := startDevice(ctx, s.HTTP, s.Web, clientID)
	if e != nil {
		s.noteErr(e)
		return Device{}, e
	}
	d := &Device{State: "pending", UserCode: dc.UserCode, VerificationURI: dc.VerificationURI, Interval: max(dc.Interval, 5),
		ExpiresAt: s.Now().Add(time.Duration(dc.ExpiresIn) * time.Second).UnixMilli()}
	wctx, cancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	s.device, s.deviceCancel = d, cancel
	out := *d
	s.mu.Unlock()
	go s.waitDevice(wctx, clientID, dc, d)
	return out, nil
}

// waitDevice polls until the code is entered, refused or expired.
func (s *Service) waitDevice(ctx context.Context, clientID string, dc deviceCode, d *Device) {
	tok, state, e := pollDevice(ctx, s.HTTP, s.Web, clientID, dc, s.Sleep)
	if ctx.Err() != nil {
		return
	}
	if e == nil {
		var u *User
		var scopes []string
		var known bool
		u, scopes, known, e = s.readUser(ctx, tok, SourceOAuth, "Connecting GitHub")
		if e == nil {
			if err := s.adopt(ctx, SourceOAuth, tok); err != nil {
				e = errorf(KindState, "Connecting GitHub", "%s", err.Error())
			} else {
				s.mu.Lock()
				s.user, s.scopes, s.scopesOK, s.kind = u, scopes, known, tokenKind(tok)
				s.checkedAt = s.Now().UnixMilli()
				s.mu.Unlock()
				s.noteOK()
			}
		}
		if e != nil {
			state = "error"
		}
	}
	s.mu.Lock()
	if s.device == d {
		d.State, d.Error = state, e
	}
	s.mu.Unlock()
	s.publishAccount()
	s.Kick(0)
}

// DeviceState is the device flow's state, nil when none was started.
func (s *Service) DeviceState() *Device {
	s.init()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.device == nil {
		return nil
	}
	d := *s.device
	return &d
}

// CancelDevice abandons a device flow in progress.
func (s *Service) CancelDevice() {
	s.init()
	s.mu.Lock()
	cancel := s.deviceCancel
	s.device, s.deviceCancel = nil, nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// sortedKeys is m's keys in order, for a stable answer.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
