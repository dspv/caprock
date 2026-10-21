package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dspv/caprock/internal/alerts"
	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/modules"
	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/telegram"
)

// What a private module says to the owner and hears back (ADR-076, amended
// 2026-10-22): the answers to its Telegram messages land in its own store,
// and its desktop notifications go out as notify frames.

// errModuleNotNamed is an answer for a module the admin key no longer names.
var errModuleNotNamed = errors.New("this module is no longer open on this computer")

// moduleAnswer keeps an answer to a module's Telegram message in that
// module's store, as telegram/<doc>, when the stored admin key still names
// the module.
func (d *Daemon) moduleAnswer(ctx context.Context, module, doc string, data map[string]any) error {
	g, err := modules.ParseKey(d.config().AdminKey)
	if err != nil || !g.Allows(module) {
		return errModuleNotNamed
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = store.SetModuleDoc(ctx, d.store.DB(), module, telegram.ModuleCollection, doc, b, time.Now().UnixMilli())
	return err
}

// moduleNotifier is the daemon as POST /v1/x/{id}/notify sees it.
type moduleNotifier struct{ d *Daemon }

// NotifyModule puts a module's notification on /v1/live as a notify frame,
// which only the desktop app turns into an OS notification: a browser tab,
// or no app open, shows nothing. Sent only while desktop notifications are
// on — either of Settings → Desktop notifications' switches.
func (m moduleNotifier) NotifyModule(id, name, title, body string) bool {
	cfg := m.d.config()
	if !cfg.NotifyApprovalOn() && !cfg.NotifyFinishedOn() {
		return false
	}
	n := alerts.Notification{
		ID:    fmt.Sprintf("module-%s-%d", id, time.Now().UnixNano()),
		Kind:  "module",
		Title: name + " · " + title,
		Body:  body,
		Route: "#/x/" + id,
	}
	m.d.bus.Publish(bus.Frame{Type: bus.FrameNotify, Data: n})
	m.d.log.Info("notify frame published", "component", "modules", "kind", n.Kind, "module", id)
	return true
}
