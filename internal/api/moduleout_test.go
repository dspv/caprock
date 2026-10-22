package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/dspv/caprock/internal/telegram"
)

// fakeModuleTelegram is the bridge as the module route sees it.
type fakeModuleTelegram struct {
	TelegramController
	got []telegram.ModuleMessage
	err error
}

func (f *fakeModuleTelegram) SendModule(_ context.Context, m telegram.ModuleMessage) (int64, error) {
	if err := m.Check(); err != nil {
		return 0, err
	}
	if f.err != nil {
		return 0, f.err
	}
	f.got = append(f.got, m)
	return 4242, nil
}

type fakeModuleNotifier struct{ got [][4]string }

func (f *fakeModuleNotifier) NotifyModule(id, name, title, body string) bool {
	f.got = append(f.got, [4]string{id, name, title, body})
	return true
}

// A keyed module sends to the owner's chat through the bridge, named by its
// manifest; anything the key does not name is refused before the bridge.
func TestAModuleSendsToTelegram(t *testing.T) {
	tg := &fakeModuleTelegram{}
	e := newModuleEnv(t, func(d *Deps) { d.Telegram = tg })
	e.install(t, "alpha", "Alpha desk")
	e.install(t, "beta", "Beta")
	e.admin.key = e.key(`"alpha"`)

	var out map[string]int64
	body := `{"text":"Deploy?","buttons":[{"id":"yes","label":"Deploy"},{"id":"no","label":"Not now"}],"reply":false}`
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", body, &out); code != 200 || out["message_id"] != 4242 {
		t.Fatalf("send: %d %v", code, out)
	}
	if len(tg.got) != 1 || tg.got[0].Module != "alpha" || tg.got[0].Name != "Alpha desk" || len(tg.got[0].Buttons) != 2 {
		t.Fatalf("bridge got %+v", tg.got)
	}
	if code := e.send(t, http.MethodPost, "/v1/x/beta/telegram", `{"text":"hi"}`, nil); code != 403 {
		t.Errorf("a module the key does not name: %d", code)
	}
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", `{"text":""}`, nil); code != 400 {
		t.Errorf("no text: %d", code)
	}
	tg.err = telegram.ErrNotPaired
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", `{"text":"hi"}`, nil); code != 409 {
		t.Errorf("no paired chat: %d", code)
	}
	tg.err = telegram.ErrMuted
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/telegram", `{"text":"hi"}`, nil); code != 409 {
		t.Errorf("muted: %d", code)
	}
	if len(tg.got) != 1 {
		t.Fatalf("refused sends reached the bridge: %d", len(tg.got))
	}
}

// A module's notification is 204 either way; the notifier hears the
// module's name, and a request with no title is refused.
func TestAModuleNotifies(t *testing.T) {
	n := &fakeModuleNotifier{}
	e := newModuleEnv(t, func(d *Deps) { d.ModuleNotify = n })
	e.install(t, "alpha", "Alpha desk")
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/notify", `{"title":"Done"}`, nil); code != 403 {
		t.Fatalf("without a key: %d", code)
	}
	e.admin.key = e.key(`"alpha"`)
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/notify", `{"title":"Review ready","body":"3 items"}`, nil); code != 204 {
		t.Fatalf("notify: %d", code)
	}
	if len(n.got) != 1 || n.got[0] != [4]string{"alpha", "Alpha desk", "Review ready", "3 items"} {
		t.Fatalf("notifier got %v", n.got)
	}
	if code := e.send(t, http.MethodPost, "/v1/x/alpha/notify", `{"title":"  "}`, nil); code != 400 {
		t.Errorf("no title: %d", code)
	}
}

// Both are a controller's, like the module's store; never a viewer's.
func TestModuleOutIsAControllersRoute(t *testing.T) {
	for _, r := range []string{"POST /v1/x/{id}/telegram", "PATCH /v1/x/{id}/telegram/{message_id}", "POST /v1/x/{id}/notify"} {
		if !controllerRoutes[r] {
			t.Errorf("%s is not a controller route", r)
		}
	}
}
