package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// One Telegram bot for all the owner's computers (ADR-047, amended
// 2026-11-27): the daemon's half on a computer that sends through another
// computer's bot (the holder), and on the holder after it handed its bot on.
//
// What this machine hands the holder waits in telegram_outbox (migration
// 0096) until the holder takes it, so a holder that is asleep delays a
// message and never loses it silently; Settings → Telegram says how many
// wait and why. Presses and replies under those messages come back because
// this machine asks for them — a long poll on the holder, only while
// something it sent can still be answered — so the link's direction stays
// the one the owner paired (ADR-067) and a channel is up only while needed.

const (
	// viaPostTimeout bounds one post to the holder.
	viaPostTimeout = 30 * time.Second
	// viaBackoffMax is the longest wait between tries to reach the holder.
	viaBackoffMax = time.Minute
	// viaInfoTimeout bounds asking one computer whether it holds a bot.
	viaInfoTimeout = 8 * time.Second
)

// viaState is the sender's link to its holder, in memory: how the last try
// went (the queue itself is in the database) and who waits for an outcome.
type viaState struct {
	mu        sync.Mutex
	waiting   bool
	lastErr   string
	lastSent  int64
	dropped   int
	dones     map[string]func(error)
	wake      chan struct{}
	pressWake chan struct{}
	// link overrides the channel to a computer (tests); nil uses the
	// machines manager's.
	link func(id string) telegram.HubClient
}

func newViaState() *viaState {
	return &viaState{dones: map[string]func(error){}, wake: make(chan struct{}, 1), pressWake: make(chan struct{}, 1)}
}

func poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

// hubClient is the channel to computer id: requests carried as this
// machine's paired device there (peers.Manager.Do).
func (d *Daemon) hubClient(id string) telegram.HubClient {
	if d.via.link != nil {
		return d.via.link(id)
	}
	return telegram.HubClient{Do: func(r *http.Request) (*http.Response, error) {
		if d.machines == nil || d.machines.mgr() == nil {
			return nil, errors.New("this computer reaches no other")
		}
		return d.machines.Do(id, r)
	}}
}

// machineLabel is what this machine calls computer id, or id itself.
func (d *Daemon) machineLabel(id string) string {
	if d.machines != nil && d.machines.mgr() != nil {
		if st, err := d.machines.Get(id); err == nil && st.Name != "" {
			return st.Name
		}
	}
	return id
}

// viaRoute is the bridge's Route: the message waits in the database until
// the holder takes it.
func (d *Daemon) viaRoute(m telegram.HubMessage, done func(error)) {
	ctx := context.Background()
	body, err := json.Marshal(m)
	if err == nil {
		var dropped int
		dropped, err = store.PutTelegramOutbox(ctx, d.store.DB(), m.ID, time.Now().UnixMilli(), body)
		if dropped > 0 {
			d.via.mu.Lock()
			d.via.dropped += dropped
			d.via.mu.Unlock()
			d.log.Warn("telegram: messages waited too long for the holder and were dropped", "component", "telegram", "dropped", dropped)
		}
	}
	if err != nil {
		if done != nil {
			done(err)
		}
		return
	}
	if done != nil {
		d.via.mu.Lock()
		d.via.dones[m.ID] = done
		d.via.mu.Unlock()
	}
	if len(m.Buttons) > 0 || m.Reply {
		poke(d.via.pressWake)
	}
	poke(d.via.wake)
}

// viaFinish tells whoever waits on message id how it went, once.
func (d *Daemon) viaFinish(id string, err error) {
	d.via.mu.Lock()
	done := d.via.dones[id]
	delete(d.via.dones, id)
	d.via.mu.Unlock()
	if done != nil {
		done(err)
	}
}

func (d *Daemon) viaRecord(err error, waiting bool) {
	d.via.mu.Lock()
	defer d.via.mu.Unlock()
	d.via.waiting = waiting
	if err == nil {
		d.via.lastErr, d.via.lastSent = "", time.Now().UnixMilli()
		return
	}
	d.via.lastErr = err.Error()
}

// viaWords is a failure to reach the holder as Settings says it.
func (d *Daemon) viaWords(id string, err error) error {
	name := d.machineLabel(id)
	if telegram.NotHolder(err) {
		return fmt.Errorf("%s no longer has a Telegram bot connected", name)
	}
	var he *telegram.HubError
	if errors.As(err, &he) {
		return fmt.Errorf("%s: %s", name, he.Error())
	}
	return fmt.Errorf("%s cannot be reached: %w", name, err)
}

// runTelegramVia sends what waits to the holder, and takes back the presses
// under it, until ctx ends.
func (d *Daemon) runTelegramVia(ctx context.Context) {
	go d.viaPressLoop(ctx)
	backoff := time.Duration(0)
	for ctx.Err() == nil {
		if backoff > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			case <-d.via.wake:
			}
		}
		if !d.viaSendOne(ctx, &backoff) {
			select {
			case <-ctx.Done():
				return
			case <-d.via.wake:
			case <-time.After(30 * time.Second):
			}
		}
	}
}

// viaSendOne hands the oldest waiting message on: to the holder, or through
// this machine's own bot when it became the holder while the message
// waited. false when there was nothing to do.
func (d *Daemon) viaSendOne(ctx context.Context, backoff *time.Duration) bool {
	db := d.store.DB()
	row, ok, err := store.NextTelegramOutbox(ctx, db)
	if err != nil || !ok {
		return false
	}
	var hm telegram.HubMessage
	if json.Unmarshal(row.Body, &hm) != nil || hm.ID == "" {
		_ = store.DeleteTelegramOutbox(ctx, db, row.ID)
		return true
	}
	via := d.config().TelegramVia
	if d.tg == nil {
		return false
	}
	if !d.tg.Routing() {
		token, chat := (&tgHost{d: d}).Bot()
		if token == "" || chat == "" {
			// Neither a holder nor a bot: they wait, bounded, for one.
			return false
		}
		d.tg.FromHub(hm)
		_ = store.DeleteTelegramOutbox(ctx, db, row.ID)
		d.viaFinish(row.ID, nil)
		return true
	}
	hm.LateS = max(0, (time.Now().UnixMilli()-row.CreatedAt)/1000)
	pctx, cancel := context.WithTimeout(ctx, viaPostTimeout)
	_, err = d.hubClient(via).Post(pctx, hm)
	cancel()
	switch {
	case err == nil:
		_ = store.DeleteTelegramOutbox(ctx, db, row.ID)
		d.viaRecord(nil, false)
		d.viaFinish(row.ID, nil)
		*backoff = 0
	case telegram.Refused(err):
		// The holder will never take this one: drop it rather than block
		// the queue behind it.
		_ = store.DeleteTelegramOutbox(ctx, db, row.ID)
		words := d.viaWords(via, err)
		d.viaRecord(words, false)
		d.viaFinish(row.ID, words)
		d.log.Warn("telegram: the holder refused a message", "component", "telegram", "err", err)
	default:
		words := d.viaWords(via, err)
		_ = store.FailTelegramOutbox(ctx, db, row.ID, words.Error())
		d.viaRecord(words, true)
		d.viaFinish(row.ID, fmt.Errorf("queued: %w; it is sent when it is back", words))
		*backoff = min(max(2*(*backoff), 2*time.Second), viaBackoffMax)
	}
	return true
}

// viaPressLoop asks the holder for presses and replies under this machine's
// messages while one could still be answered, acts on each here and tells
// the holder how it went.
func (d *Daemon) viaPressLoop(ctx context.Context) {
	backoff := time.Duration(0)
	for ctx.Err() == nil {
		via := d.config().TelegramVia
		if via == "" || d.tg == nil || !d.tg.Routing() || !d.tg.Answerable() {
			select {
			case <-ctx.Done():
				return
			case <-d.via.pressWake:
			case <-time.After(time.Minute):
			}
			continue
		}
		c := d.hubClient(via)
		pctx, cancel := context.WithTimeout(ctx, telegram.HubPressWait+15*time.Second)
		ps, err := c.Presses(pctx, telegram.HubPressWait)
		cancel()
		if err != nil {
			backoff = min(max(2*backoff, 2*time.Second), viaBackoffMax)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			continue
		}
		backoff = 0
		for _, p := range ps {
			res := d.tg.Act(ctx, p)
			rctx, cancel := context.WithTimeout(ctx, viaPostTimeout)
			if err := c.Result(rctx, res); err != nil {
				d.log.Info("telegram: could not tell the holder how a press went", "component", "telegram", "err", err)
			}
			cancel()
		}
	}
}

// viaStatus is the bridge's ViaStatus: the holder, what waits for it and how
// the last try went. nil when this machine sends through none.
func (d *Daemon) viaStatus() *telegram.ViaStatus {
	via := d.config().TelegramVia
	if via == "" {
		return nil
	}
	n, _ := store.CountTelegramOutbox(context.Background(), d.store.DB())
	d.via.mu.Lock()
	defer d.via.mu.Unlock()
	return &telegram.ViaStatus{Machine: via, Name: d.machineLabel(via), Queued: n, Waiting: d.via.waiting && n > 0,
		LastError: d.via.lastErr, LastSentMs: d.via.lastSent, Dropped: d.via.dropped}
}

// telegramMoved is the old holder hearing that its bot went to computer to:
// when this machine reaches that computer too, it sends through it from now
// on, so its own alerts keep coming without a step.
func (d *Daemon) telegramMoved(to telegram.Sender) {
	if to.Key == "" || d.machines == nil || d.machines.mgr() == nil {
		return
	}
	for _, m := range d.machines.List() {
		if m.ID == to.Key && m.Status != peers.StatusRevoked {
			if err := (&tgHost{d: d}).saveConfig(func(c *config.Config) { c.TelegramVia = m.ID }); err != nil {
				d.log.Warn("telegram: could not send through the new holder", "component", "telegram", "err", err)
				return
			}
			d.log.Info("telegram: the bot moved; sending through its new holder", "component", "telegram", "to", m.Name)
			poke(d.via.wake)
			return
		}
	}
}

// --- Settings → Telegram on the sender (api.TelegramVia) ---

// TelegramHolders lists the computers this machine reaches and whether each
// holds a bot to send through, asked of each at once.
func (d *Daemon) TelegramHolders(ctx context.Context) []telegram.Candidate {
	if d.machines == nil || d.machines.mgr() == nil {
		return []telegram.Candidate{}
	}
	list := d.machines.List()
	out := make([]telegram.Candidate, len(list))
	var wg sync.WaitGroup
	for i, m := range list {
		out[i] = telegram.Candidate{ID: m.ID, Name: m.Name}
		if m.Status == peers.StatusRevoked || m.Status == peers.StatusPending {
			out[i].Error = "not allowed there yet"
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			ictx, cancel := context.WithTimeout(ctx, viaInfoTimeout)
			defer cancel()
			info, err := d.hubClient(id).Info(ictx)
			if err != nil {
				out[i].Error = d.viaWords(id, err).Error()
				return
			}
			out[i].Holder, out[i].BotUsername, out[i].ChatName = info.Holder, info.BotUsername, info.ChatName
		}(i, m.ID)
	}
	wg.Wait()
	return out
}

// errHasBot is choosing a holder on a machine with a bot of its own.
var errHasBot = errors.New("this computer has its own Telegram bot: disconnect it first, or move it to the other computer")

// SetTelegramVia sends this machine's Telegram messages through computer
// id, which must hold a bot now.
func (d *Daemon) SetTelegramVia(ctx context.Context, id string) error {
	if token, chat := (&tgHost{d: d}).Bot(); token != "" && chat != "" {
		return errHasBot
	}
	if d.machines == nil || d.machines.mgr() == nil {
		return errors.New("this computer reaches no other: add one in Settings → Computers")
	}
	if _, err := d.machines.Get(id); err != nil {
		return err
	}
	ictx, cancel := context.WithTimeout(ctx, viaInfoTimeout)
	defer cancel()
	info, err := d.hubClient(id).Info(ictx)
	if err != nil {
		return d.viaWords(id, err)
	}
	if !info.Holder {
		return fmt.Errorf("%s has no Telegram bot connected", d.machineLabel(id))
	}
	if err := (&tgHost{d: d}).saveConfig(func(c *config.Config) { c.TelegramVia = id }); err != nil {
		return err
	}
	d.phone.botChanged()
	d.viaRecord(nil, false)
	poke(d.via.wake)
	poke(d.via.pressWake)
	return nil
}

// ClearTelegramVia stops sending through the holder; what waited for it is
// dropped.
func (d *Daemon) ClearTelegramVia(ctx context.Context) error {
	if err := (&tgHost{d: d}).saveConfig(func(c *config.Config) { c.TelegramVia = "" }); err != nil {
		return err
	}
	d.phone.botChanged()
	d.via.mu.Lock()
	dones := d.via.dones
	d.via.dones = map[string]func(error){}
	d.via.waiting, d.via.lastErr, d.via.dropped = false, "", 0
	d.via.mu.Unlock()
	for _, done := range dones {
		done(errors.New("not sent: this computer stopped sending through the other one"))
	}
	return store.ClearTelegramOutbox(ctx, d.store.DB())
}

// TakeTelegram makes this machine the bot's holder: computer id (the holder
// this machine sends through, when "") hands over its token, chat and
// offset, and stops reading. What waited for it goes through this
// machine's bot instead.
func (d *Daemon) TakeTelegram(ctx context.Context, id string) error {
	if id == "" {
		id = d.config().TelegramVia
	}
	if id == "" {
		return errors.New("choose the computer whose bot to move here")
	}
	if token, chat := (&tgHost{d: d}).Bot(); token != "" && chat != "" {
		return errHasBot
	}
	if d.machines == nil || d.machines.mgr() == nil {
		return errors.New("this computer reaches no other")
	}
	from := d.machineLabel(id)
	h, err := d.hubClient(id).Handover(ctx)
	if err != nil {
		return d.viaWords(id, err)
	}
	if err := d.tg.TakeOver(ctx, h, machineName(), from); err != nil {
		// The old holder has already let the bot go: say how to get it back.
		return fmt.Errorf("%s handed its bot over, but this computer could not keep it (%w): paste the bot token from @BotFather here", from, err)
	}
	if err := (&tgHost{d: d}).saveConfig(func(c *config.Config) { c.TelegramVia = "" }); err != nil {
		return err
	}
	d.viaRecord(nil, false)
	d.log.Info("telegram: this computer now holds the bot", "component", "telegram", "from", from)
	poke(d.via.wake)
	return nil
}
