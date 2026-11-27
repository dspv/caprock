package peers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
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

// Join keys, the issuing side (ADR-108): Add with a key on the computer the
// user works on. One key is open at a time. While it is, this machine waits
// at its relay under an identity made for that key alone (remote.MakeJoinKey)
// and answers two routes, and nothing else, to whoever dials it there:
//
//   - POST /v1/join/hello {secret, name}: the secret checks against the hash
//     kept here; the answer is this machine's relay key (the one every
//     channel to a computer proves) and its name, so the new computer can
//     mint a code that pre-approves this machine and no other.
//   - POST /v1/join/link {secret, link}: the new computer's pairing link
//     with that code. This machine pairs with it as `caprock machines add`
//     does (Manager.Pair); the key is spent once that succeeds.
//
// Only a hash of the secret is kept, in memory: the key itself is shown
// once, in the answer that made it, and is in no log, event or file. After
// JoinTTL, JoinTries wrong secrets, a join, or Withdraw, the rendezvous is
// hung up and its keys are dropped.

// JoinTTL is how long a join key works: long enough to install Caprock on
// the new computer first.
const JoinTTL = 15 * time.Minute

// JoinTries is how many wrong secrets burn a key.
const JoinTries = 5

// joinBurnGrace is how long a burned key's rendezvous stays connected,
// refusing everything, so the try that burned it hears its refusal.
const joinBurnGrace = 2 * time.Second

// The states of a join key (JoinState.State).
const (
	JoinNone      = "none"      // no key was made, or it was withdrawn
	JoinWaiting   = "waiting"   // open, nobody has used it yet
	JoinJoining   = "joining"   // a computer proved the secret and is linking
	JoinJoined    = "joined"    // linked: Machine says which computer
	JoinExpired   = "expired"   // JoinTTL passed unused
	JoinFailed    = "failed"    // burned by wrong secrets, or the link failed
	joinRoutePath = "/v1/join/" // the rendezvous answers nothing else
)

// JoinOptions configure the join desk.
type JoinOptions struct {
	// Relay is where the rendezvous waits: this machine's own relay, the
	// one access from anywhere uses (Settings → Use on your phone).
	Relay func() string
	// Controller is this machine's relay key, remote.HostID of the key its
	// channels prove (Options.Identity); "" refuses to make a key, since the
	// new computer could pre-approve nothing.
	Controller func() string
	Name       string
	Version    string
	Log        *slog.Logger
	// Pair links the computer a link names: Manager.Pair.
	Pair func(ctx context.Context, link string) (Status, error)
	// Base bounds every rendezvous: the daemon's life.
	Base context.Context
	// TTL overrides JoinTTL, for tests.
	TTL time.Duration
}

// JoinState is GET /v1/machines/join-key: never the key.
type JoinState struct {
	State string `json:"state"`
	// ExpiresAt is unix milliseconds, this machine's clock; 0 with no key.
	ExpiresAt int64 `json:"expires_at,omitempty"`
	// Relay is where the rendezvous waits, and RelayStatus how its
	// connection there stands (connecting, online, offline).
	Relay       string `json:"relay,omitempty"`
	RelayStatus string `json:"relay_status,omitempty"`
	// Joiner is the name the new computer gave, once it proved the secret.
	Joiner string `json:"joiner,omitempty"`
	// Machine is the computer that joined, as GET /v1/machines lists it.
	Machine *Status `json:"machine,omitempty"`
	Error   string  `json:"error,omitempty"`
}

// NewJoinKey is POST /v1/machines/join-key's answer: the key, once.
type NewJoinKey struct {
	JoinState
	Key string `json:"key"`
}

// JoinDesk holds the open join key, if any.
type JoinDesk struct {
	opt JoinOptions
	log *slog.Logger

	mu  sync.Mutex
	cur *joinKey
}

type joinKey struct {
	hash    [32]byte
	expires time.Time
	relay   string
	host    *remote.Host
	stop    context.CancelFunc
	tries   int
	state   string
	joiner  string
	machine *Status
	err     string
	// linking is held while one link is paired, so two arrive one by one.
	linking sync.Mutex
}

// NewJoinDesk makes the desk; nothing is dialled until New.
func NewJoinDesk(opt JoinOptions) *JoinDesk {
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	if opt.Base == nil {
		opt.Base = context.Background()
	}
	if opt.TTL <= 0 {
		opt.TTL = JoinTTL
	}
	return &JoinDesk{opt: opt, log: opt.Log}
}

// ErrNoIdentity is a machine with no relay key to pre-approve.
var ErrNoIdentity = errors.New("this computer has no relay key yet: open Settings → Use on your phone once, or run `caprock remote on` and off")

// New makes a key, replacing any open one, and starts waiting for it.
func (j *JoinDesk) New() (NewJoinKey, error) {
	if j.opt.Controller == nil || j.opt.Controller() == "" {
		return NewJoinKey{}, ErrNoIdentity
	}
	relay := remote.DefaultRelay
	if j.opt.Relay != nil && j.opt.Relay() != "" {
		relay = j.opt.Relay()
	}
	keys, jk, err := remote.MakeJoinKey(relay)
	if err != nil {
		return NewJoinKey{}, err
	}
	k := &joinKey{hash: sha256.Sum256(jk.Secret), expires: time.Now().Add(j.opt.TTL), relay: relay, state: JoinWaiting}
	ctx, stop := context.WithDeadline(j.opt.Base, k.expires)
	k.stop = stop
	k.host = remote.NewHost(remote.Options{
		Relay:   relay,
		Keys:    keys,
		Local:   "http://join.invalid",
		Version: j.opt.Version,
		Name:    j.opt.Name,
		Log:     j.log,
		Client:  remote.HandlerClient(j.handler(k)),
	})
	j.mu.Lock()
	if old := j.cur; old != nil {
		old.stop()
	}
	j.cur = k
	j.mu.Unlock()
	go k.host.Run(ctx)
	go func() {
		<-ctx.Done()
		j.mu.Lock()
		if k.state == JoinWaiting || k.state == JoinJoining {
			if time.Now().Before(k.expires) {
				k.state = JoinNone // withdrawn, or the daemon stopping
			} else {
				k.state = JoinExpired
			}
		}
		j.mu.Unlock()
	}()
	j.log.Info("a join key is open", "component", "peers", "relay", relay, "expires_in", j.opt.TTL.String())
	return NewJoinKey{JoinState: j.State(), Key: jk.String()}, nil
}

// State is how the open key stands.
func (j *JoinDesk) State() JoinState {
	j.mu.Lock()
	defer j.mu.Unlock()
	k := j.cur
	if k == nil {
		return JoinState{State: JoinNone}
	}
	st := JoinState{State: k.state, Relay: k.relay, Joiner: k.joiner, Machine: k.machine, Error: k.err}
	if k.state == JoinWaiting && !time.Now().Before(k.expires) {
		st.State = JoinExpired
	}
	if st.State == JoinNone {
		return JoinState{State: JoinNone}
	}
	if st.State == JoinWaiting || st.State == JoinJoining {
		st.ExpiresAt = k.expires.UnixMilli()
		st.RelayStatus = k.host.State().Status
		if e := k.host.State().Error; e != "" && st.RelayStatus != "online" {
			st.Error = e
		}
	}
	return st
}

// Withdraw closes the open key: it stops working at once.
func (j *JoinDesk) Withdraw() {
	j.mu.Lock()
	k := j.cur
	j.cur = nil
	j.mu.Unlock()
	if k != nil {
		k.stop()
	}
}

// Close is Withdraw, for the daemon's shutdown.
func (j *JoinDesk) Close() { j.Withdraw() }

// check holds a secret against k: true when it is k's. A wrong one counts,
// and JoinTries of them burn the key.
func (j *JoinDesk) check(k *joinKey, secret []byte) (ok bool, why string) {
	h := sha256.Sum256(secret)
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cur != k || (k.state != JoinWaiting && k.state != JoinJoining) || !time.Now().Before(k.expires) {
		return false, "that key no longer works: make a new one on the computer you work on"
	}
	if subtle.ConstantTimeCompare(h[:], k.hash[:]) != 1 {
		k.tries++
		if k.tries >= JoinTries {
			k.state, k.err = JoinFailed, "too many wrong keys were tried: make a new one"
			// Refused from now on (the state check above), but the rendezvous
			// hangs up only after joinBurnGrace: stopped at once, it raced the
			// answer to this very try, which then arrived as "not waiting"
			// instead of a refusal (Windows CI, 2026-11-27).
			time.AfterFunc(joinBurnGrace, k.stop)
		}
		return false, "that key is not this computer's"
	}
	return true, ""
}

type joinRequest struct {
	Secret string `json:"secret"`
	Name   string `json:"name"`
	Link   string `json:"link"`
}

// handler is everything the rendezvous answers.
func (j *JoinDesk) handler(k *joinKey) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, joinRoutePath) {
			joinAnswer(w, http.StatusNotFound, map[string]string{"error": "a join rendezvous answers nothing else"})
			return
		}
		var req joinRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
			joinAnswer(w, http.StatusBadRequest, map[string]string{"error": "send JSON"})
			return
		}
		secret, err := decodeSecret(req.Secret)
		if err != nil {
			joinAnswer(w, http.StatusUnauthorized, map[string]string{"error": "that key is not this computer's"})
			return
		}
		if ok, why := j.check(k, secret); !ok {
			joinAnswer(w, http.StatusUnauthorized, map[string]string{"error": why})
			return
		}
		switch strings.TrimPrefix(r.URL.Path, joinRoutePath) {
		case "hello":
			j.mu.Lock()
			if j.cur == k && k.state == JoinWaiting {
				k.state, k.joiner = JoinJoining, cleanName(req.Name)
			}
			j.mu.Unlock()
			joinAnswer(w, http.StatusOK, map[string]string{"controller": j.opt.Controller(), "name": j.opt.Name})
		case "link":
			j.link(w, r, k, req.Link)
		default:
			joinAnswer(w, http.StatusNotFound, map[string]string{"error": "a join rendezvous answers nothing else"})
		}
	})
}

// link pairs with the new computer's link, once.
func (j *JoinDesk) link(w http.ResponseWriter, r *http.Request, k *joinKey, link string) {
	k.linking.Lock()
	defer k.linking.Unlock()
	j.mu.Lock()
	spent := k.state == JoinJoined
	j.mu.Unlock()
	if spent {
		joinAnswer(w, http.StatusGone, map[string]string{"error": "that key was used already"})
		return
	}
	if j.opt.Pair == nil {
		joinAnswer(w, http.StatusNotImplemented, map[string]string{"error": "this computer cannot link others"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	st, err := j.opt.Pair(ctx, link)
	if err != nil {
		j.mu.Lock()
		if j.cur == k {
			k.err = err.Error()
		}
		j.mu.Unlock()
		j.log.Info("a join key's link did not pair", "component", "peers", "err", err)
		joinAnswer(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	j.mu.Lock()
	if j.cur == k {
		k.state, k.machine, k.err = JoinJoined, &st, ""
	}
	j.mu.Unlock()
	j.log.Info("a computer joined with a key", "component", "peers", "machine", st.ID, "name", st.Name, "status", st.Status)
	joinAnswer(w, http.StatusOK, map[string]string{"id": st.ID, "name": st.Name, "status": st.Status})
	// Spent: the rendezvous hangs up once the answer is on its way.
	go func() {
		time.Sleep(2 * time.Second)
		k.stop()
	}()
}

func joinAnswer(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeSecret reads the secret as the joining side sends it, base64url.
func decodeSecret(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != remote.JoinSecretSize {
		return nil, errors.New("not a join secret")
	}
	return b, nil
}

// Joining, the new computer's side: `caprock join <key>` (POST /v1/join).

// JoinWithOptions are what joining needs of the daemon it runs in.
type JoinWithOptions struct {
	// Name is what this computer calls itself to the issuer.
	Name string
	// Link mints this computer's pairing link with a code that pre-approves
	// controller (pairing.Store.NewCodeForKey) and returns it, access from
	// anywhere on and connected to its relay. Cancel withdraws that code
	// when the join fails after it.
	Link   func(ctx context.Context, controller string) (string, error)
	Cancel func()
	// HTTPClient dials the relay; nil is the default.
	HTTPClient *http.Client
	Log        *slog.Logger
}

// Joined says what a join did.
type Joined struct {
	// Controller is the issuing computer's relay key, and ControllerName
	// what it calls itself: the one computer now allowed here.
	Controller     string `json:"controller"`
	ControllerName string `json:"controller_name"`
	// Status is this computer as the issuer lists it after pairing
	// (online, normally).
	Status string `json:"status"`
}

// Errors a join tells apart.
var (
	// ErrJoinGone is a key whose rendezvous is not there: expired, used,
	// withdrawn, or the issuing computer offline.
	ErrJoinGone = errors.New("that key's computer is not waiting for it: the key expired (15 minutes), was used, or was withdrawn, or that computer is off. Make a new key there")
	// ErrJoinRefused is a key the rendezvous refused.
	ErrJoinRefused = errors.New("that computer did not accept the key")
)

// Join uses a join key: proves it to the issuer's rendezvous, mints this
// computer's link for the issuer alone, and hands it over; the issuer pairs
// with it, and is allowed here the moment it does.
func Join(ctx context.Context, raw string, opt JoinWithOptions) (Joined, error) {
	jk, err := remote.ParseJoinKey(raw)
	if err != nil {
		return Joined{}, err
	}
	if opt.Log == nil {
		opt.Log = slog.New(slog.DiscardHandler)
	}
	c, err := remote.NewClient(remote.ClientOptions{Target: jk.Target, Log: opt.Log, HTTPClient: opt.HTTPClient})
	if err != nil {
		return Joined{}, err
	}
	defer c.Close()
	secret := base64.RawURLEncoding.EncodeToString(jk.Secret)

	var hello struct {
		Controller string `json:"controller"`
		Name       string `json:"name"`
	}
	if err := joinCall(ctx, c, "hello", joinRequest{Secret: secret, Name: opt.Name}, &hello); err != nil {
		return Joined{}, err
	}
	if _, err := remote.ParseHostID(hello.Controller); err != nil {
		return Joined{}, errors.New("that computer answered without its key: update Caprock there")
	}
	link, err := opt.Link(ctx, hello.Controller)
	if err != nil {
		return Joined{}, err
	}
	var got struct {
		Status string `json:"status"`
	}
	if err := joinCall(ctx, c, "link", joinRequest{Secret: secret, Link: link}, &got); err != nil {
		if opt.Cancel != nil {
			opt.Cancel()
		}
		return Joined{}, err
	}
	return Joined{Controller: hello.Controller, ControllerName: cleanName(hello.Name), Status: got.Status}, nil
}

// joinCall is one POST to the rendezvous.
func joinCall(ctx context.Context, c *remote.Client, route string, body joinRequest, out any) error {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://join"+joinRoutePath+route, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.RoundTrip(req)
	if err != nil {
		if errors.Is(err, remote.ErrMachineOffline) {
			return ErrJoinGone
		}
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Error == "" {
			e.Error = fmt.Sprintf("it answered %d", res.StatusCode)
		}
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusGone {
			return fmt.Errorf("%w: %s", ErrJoinRefused, e.Error)
		}
		return errors.New(e.Error)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return errors.New("that computer's answer is not one this Caprock reads: update Caprock on both")
	}
	return nil
}
