// Package engine talks to mail servers: it keeps the local copy in step with
// IMAP, applies the user's actions there, and sends over SMTP.
package engine

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2/imapclient"

	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/secrets"
)

// Intervals; tests shorten them.
var (
	FullSyncEvery = 5 * time.Minute
	PollEvery     = 2 * time.Minute // when the server has no IDLE
	IdleRestart   = 20 * time.Minute
)

// Engine runs one worker per account.
type Engine struct {
	st      *store.Store
	sec     secrets.Store
	notify  func(kind string, accountID int64)
	mu      sync.Mutex
	workers map[int64]*worker
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// New creates an engine. notify is called after anything changes locally.
func New(st *store.Store, sec secrets.Store, notify func(kind string, accountID int64)) *Engine {
	if notify == nil {
		notify = func(string, int64) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Engine{st: st, sec: sec, notify: notify, workers: map[int64]*worker{}, ctx: ctx, cancel: cancel}
}

// Start launches a worker for every stored account.
func (e *Engine) Start() error {
	accts, err := e.st.Accounts(e.ctx)
	if err != nil {
		return err
	}
	for _, a := range accts {
		e.StartAccount(a.ID)
	}
	return nil
}

// Stop ends every worker and waits for them.
func (e *Engine) Stop() {
	e.cancel()
	e.mu.Lock()
	for _, w := range e.workers {
		w.closeConn()
	}
	e.mu.Unlock()
	e.wg.Wait()
}

// StartAccount launches (or restarts) the worker of an account.
func (e *Engine) StartAccount(id int64) {
	e.StopAccount(id)
	ctx, cancel := context.WithCancel(e.ctx)
	w := &worker{e: e, id: id, ctx: ctx, cancel: cancel, kick: make(chan string, 8), done: make(chan struct{})}
	e.mu.Lock()
	e.workers[id] = w
	e.mu.Unlock()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		defer close(w.done)
		w.run()
	}()
}

// StopAccount ends an account's worker.
func (e *Engine) StopAccount(id int64) {
	e.mu.Lock()
	w := e.workers[id]
	delete(e.workers, id)
	e.mu.Unlock()
	if w != nil {
		w.cancel()
		w.closeConn()
		<-w.done
	}
}

// SyncNow asks every worker (or one) to sync at once.
func (e *Engine) SyncNow(accountID int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for id, w := range e.workers {
		if accountID == 0 || id == accountID {
			w.kickSync("")
		}
	}
}

func (e *Engine) worker(id int64) (*worker, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	w := e.workers[id]
	if w == nil {
		return nil, errors.New("account is not running")
	}
	return w, nil
}

// worker owns an account's command connection; a second connection idles on INBOX.
type worker struct {
	e      *Engine
	id     int64
	ctx    context.Context
	cancel context.CancelFunc
	kick   chan string // "" = full sync, otherwise a folder name
	done   chan struct{}

	mu   sync.Mutex // guards c and every command sent on it
	c    *imapclient.Client
	idle *imapclient.Client
}

func (w *worker) kickSync(folder string) {
	select {
	case w.kick <- folder:
	default:
	}
}

func (w *worker) closeConn() {
	w.mu.Lock()
	if w.c != nil {
		w.c.Close()
		w.c = nil
	}
	idle := w.idle
	w.mu.Unlock()
	if idle != nil {
		idle.Close()
	}
}

// conn returns the logged-in command connection, dialling if needed. Caller holds w.mu.
func (w *worker) conn() (*imapclient.Client, store.Account, error) {
	a, err := w.e.st.Account(w.ctx, w.id)
	if err != nil {
		return nil, a, err
	}
	if w.c != nil {
		select {
		case <-w.c.Closed():
			w.c = nil
		default:
			return w.c, a, nil
		}
	}
	pw, err := w.e.sec.Get(w.id)
	if err != nil {
		return nil, a, err
	}
	c, err := dialIMAP(a, pw, nil)
	if err != nil {
		return nil, a, err
	}
	w.c = c
	return c, a, nil
}

// do runs f on the command connection; on a broken connection it redials once.
func (w *worker) do(f func(c *imapclient.Client, a store.Account) error) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	for attempt := 0; ; attempt++ {
		c, a, err := w.conn()
		if err != nil {
			return err
		}
		err = f(c, a)
		if err == nil {
			return nil
		}
		select {
		case <-c.Closed():
			w.c = nil
			if attempt == 0 && w.ctx.Err() == nil {
				continue
			}
		default:
		}
		return err
	}
}

func (w *worker) run() {
	log := slog.With("account", w.id)
	idleKick := make(chan struct{}, 1)
	go w.idleLoop(idleKick)
	backoff := 5 * time.Second
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		folder := ""
		select {
		case <-w.ctx.Done():
			return
		case <-timer.C:
		case folder = <-w.kick:
		case <-idleKick:
			folder = "INBOX"
		}
		err := w.sync(folder)
		msg := ""
		if err != nil && w.ctx.Err() == nil {
			msg = err.Error()
			log.Warn("sync failed", "err", err)
		}
		_ = w.e.st.SetSyncState(context.Background(), w.id, msg)
		w.e.notify("sync", w.id)
		if err != nil && w.ctx.Err() == nil {
			timer.Reset(backoff)
			if backoff < 5*time.Minute {
				backoff *= 2
			}
			continue
		}
		backoff = 5 * time.Second
		if folder == "" {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(FullSyncEvery)
		}
	}
}

// idleLoop keeps a second connection in IDLE on INBOX and kicks a sync on news.
// Without IDLE it polls.
func (w *worker) idleLoop(kick chan<- struct{}) {
	signal := func() {
		select {
		case kick <- struct{}{}:
		default:
		}
	}
	for w.ctx.Err() == nil {
		err := w.idleOnce(signal)
		if w.ctx.Err() != nil {
			return
		}
		wait := 30 * time.Second
		if errors.Is(err, errNoIdle) {
			wait = PollEvery
			signal()
		}
		select {
		case <-w.ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

var errNoIdle = errors.New("server has no IDLE")

func (w *worker) idleOnce(signal func()) error {
	a, err := w.e.st.Account(w.ctx, w.id)
	if err != nil {
		return err
	}
	pw, err := w.e.sec.Get(w.id)
	if err != nil {
		return err
	}
	h := &imapclient.UnilateralDataHandler{
		Expunge: func(uint32) { signal() },
		Mailbox: func(d *imapclient.UnilateralDataMailbox) {
			if d.NumMessages != nil {
				signal()
			}
		},
		Fetch: func(*imapclient.FetchMessageData) { signal() },
	}
	c, err := dialIMAP(a, pw, h)
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.idle = c
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.idle = nil
		w.mu.Unlock()
		c.Close()
	}()
	if !c.Caps().Has("IDLE") && !c.Caps().Has("IMAP4rev2") {
		return errNoIdle
	}
	if _, err := c.Select("INBOX", nil).Wait(); err != nil {
		return err
	}
	for w.ctx.Err() == nil {
		cmd, err := c.Idle()
		if err != nil {
			return err
		}
		select {
		case <-w.ctx.Done():
		case <-c.Closed():
		case <-time.After(IdleRestart):
		}
		if err := cmd.Close(); err != nil {
			return err
		}
		if err := cmd.Wait(); err != nil {
			return err
		}
	}
	return nil
}
