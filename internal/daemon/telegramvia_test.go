package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/rollup"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// viaDaemon is a daemon with no bot of its own that sends through holder's,
// over a link the test can cut.
func viaDaemon(t *testing.T, holder *Daemon, offline *atomic.Bool) *Daemon {
	t.Helper()
	on := true
	d, _ := reportDaemon(t, "", config.Config{TelegramVia: "mini", AlertApproval: &on, AlertFinished: &on})
	d.opt.DataDir = t.TempDir()
	d.bus = d.rec.Bus
	d.tg = d.newTelegram()
	d.via.link = func(string) telegram.HubClient {
		return telegram.HubClient{Do: func(r *http.Request) (*http.Response, error) {
			if offline.Load() {
				return nil, errors.New("relay: the computer is offline")
			}
			rec := httptest.NewRecorder()
			telegram.ServeHub(holder.tg, telegram.Sender{ID: "dev-laptop", Name: "Laptop"}, rec, r)
			return rec.Result(), nil
		}}
	}
	sub := d.bus.Subscribe(64)
	runJoined(t, d.tg.Run, func(ctx context.Context) { d.alertLoop(ctx, sub) }, d.runTelegramVia)
	return d
}

// A computer whose holder is offline keeps its alert in the database and
// says so; when the holder is back the alert goes out under the computer's
// name, and Mute pressed there mutes the session on the computer that sent
// it.
func TestAnAlertWaitsForTheHolderAndItsMuteComesBack(t *testing.T) {
	holder, bot := bridgeDaemon(t, config.Config{})
	var offline atomic.Bool
	offline.Store(true)
	d := viaDaemon(t, holder, &offline)
	if !d.botConfigured() {
		t.Fatal("a computer sending through a holder counts as set up")
	}
	ctx := context.Background()
	ask := &event.Event{SessionID: "s1", Source: event.SourceHook, Kind: event.KindPermissionPrompt, Tool: "Bash", Ts: reportNow,
		Payload: json.RawMessage(`{"tool_name":"Bash","tool_input":{"command":"go test ./..."}}`)}
	if _, err := d.rec.Record(ctx, ask, rollup.SessionInfo{Cwd: "/home/u/caprock", Title: "Fix the cache test"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the holder said to be out of reach", func() bool {
		v := d.tg.Status().Via
		return v != nil && v.Queued == 1 && v.Waiting && strings.Contains(v.LastError, "cannot be reached")
	})
	if n, _ := store.CountTelegramOutbox(ctx, d.store.DB()); n != 1 {
		t.Fatalf("%d rows wait", n)
	}
	if len(bot.Messages()) != 0 {
		t.Fatal("a message reached Telegram while the holder was offline")
	}

	offline.Store(false)
	poke(d.via.wake)
	waitFor(t, "the alert through the holder", func() bool { return len(bot.Messages()) == 1 })
	m := bot.Messages()[0]
	if !strings.HasPrefix(m.Text, "🖥 <b>Laptop</b>\n🟠 Claude Code · caprock · Fix the cache test") {
		t.Fatalf("text = %q", m.Text)
	}
	waitFor(t, "the queue emptied", func() bool {
		v := d.tg.Status().Via
		return v != nil && v.Queued == 0 && !v.Waiting && v.LastSentMs > 0
	})

	bot.Press(777, m.MessageID, m.Buttons[len(m.Buttons)-1])
	waitFor(t, "the mute on the laptop", func() bool { return d.tg.Muted("s1") })
	if holder.tg.Muted("s1") {
		t.Fatal("the holder muted a session of its own")
	}
}

// Stopping sending through drops what waited; a bound keeps the queue from
// growing while the holder is gone for days.
func TestTheQueueIsBoundedAndClearedWithTheHolder(t *testing.T) {
	holder, _ := bridgeDaemon(t, config.Config{})
	var offline atomic.Bool
	offline.Store(true)
	d := viaDaemon(t, holder, &offline)
	ctx := context.Background()
	db := d.store.DB()
	now := time.Now().UnixMilli()
	if _, err := store.PutTelegramOutbox(ctx, db, "old", now-store.TelegramOutboxMaxAge-1, []byte(`{"id":"old","text":"x"}`)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < store.TelegramOutboxMax+5; i++ {
		if _, err := store.PutTelegramOutbox(ctx, db, "m"+string(rune('a'+i%26))+string(rune('a'+i/26)), now+int64(i), []byte(`{"id":"x","text":"x"}`)); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := store.CountTelegramOutbox(ctx, db); n != store.TelegramOutboxMax {
		t.Fatalf("%d rows, want %d", n, store.TelegramOutboxMax)
	}
	if err := d.ClearTelegramVia(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := store.CountTelegramOutbox(ctx, db); n != 0 {
		t.Fatalf("%d rows left after stopping", n)
	}
	if d.tg.Routing() || d.tg.Status().Via != nil {
		t.Fatal("still sending through the holder")
	}
}

// Moving the bot: the laptop takes the holder's bot, chat and offset; the
// holder stops reading and says where it went; the laptop's own alerts then
// go straight to Telegram.
func TestTheLaptopTakesTheBot(t *testing.T) {
	holder, bot := bridgeDaemon(t, config.Config{})
	var offline atomic.Bool
	d := viaDaemon(t, holder, &offline)
	d.tg.Base = bot.URL()
	d.machines = &machinesAdapter{d: d}
	d.machines.once.Do(func() {}) // no machines.json: the label is the id
	h, err := d.hubClient("mini").Handover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := d.tg.TakeOver(context.Background(), h, "Laptop", "mini"); err != nil {
		t.Fatal(err)
	}
	if err := (&tgHost{d: d}).saveConfig(func(c *config.Config) { c.TelegramVia = "" }); err != nil {
		t.Fatal(err)
	}
	if tok, chat := (&tgHost{d: d}).Bot(); tok != "tok" || chat != "777" {
		t.Fatalf("laptop bot = %q %q", tok, chat)
	}
	if tok, _ := (&tgHost{d: holder}).Bot(); tok != "" {
		t.Fatal("the old holder kept the token")
	}
	if st := holder.tg.Status(); st.MovedTo == nil || st.MovedTo.Name != "Laptop" {
		t.Fatalf("old holder status = %+v", st)
	}
	if d.tg.Routing() {
		t.Fatal("the new holder still routes")
	}
	waitFor(t, "the move in the chat", func() bool {
		for _, m := range bot.Messages() {
			if strings.Contains(m.Text, "now runs on Laptop") {
				return true
			}
		}
		return false
	})
}
