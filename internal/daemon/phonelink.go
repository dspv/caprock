package daemon

import (
	"context"
	"fmt"
	"strings"

	"github.com/dspv/caprock/internal/telegram"
)

// PhoneLinkReady implements api.PhoneLinkSender: a Telegram bot and chat are
// set up, so "Send the link to my phone" has somewhere to go.
func (d *Daemon) PhoneLinkReady() bool {
	return d.botConfigured()
}

// PhoneLinkMessage is the one message "Send the link to my phone" sends: the
// phone's page, plain. No code, no key, no token — a phone that is already
// paired keeps its own token, and one that is not is told so by the page.
func PhoneLinkMessage(app string) string {
	app = strings.TrimRight(strings.TrimSpace(app), "/")
	return "Caprock on your phone: " + app + "/\n\n" +
		"Already paired: open it on the phone you paired and it connects by itself. " +
		"Tip: Share → Add to Home Screen (iPhone), or ⋮ → Install app (Android), to keep it as an app."
}

// SendPhoneLink sends PhoneLinkMessage(app) to the owner's Telegram chat,
// through the bridge when it runs, else straight to the bot as the alerts
// do. The destination is the one the owner set up (ADR-047); nothing new
// leaves the machine.
func (d *Daemon) SendPhoneLink(ctx context.Context, app string) error {
	if !d.botConfigured() {
		return fmt.Errorf("no Telegram bot is set up")
	}
	text := PhoneLinkMessage(app)
	var err error
	if d.tg != nil {
		_, err = d.tg.Out.Send(ctx, telegram.Out{Text: text})
	} else {
		cfg := d.config()
		err = d.sender().SendFormatted(ctx, cfg.ReportBotToken, cfg.ReportChatID, text, "")
	}
	return err
}
