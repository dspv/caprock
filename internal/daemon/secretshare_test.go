package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/api"
)

// Send secrets on the daemons (ADR-107): the laptop reads a key from its
// store for one send; the computer writes it into its own store, marks it
// stored in config.json without the value, uses it, and records the name —
// never the value — with who sent it.
func TestSecretsTravelStoreToStore(t *testing.T) {
	ctx := context.Background()
	fromFS, toFS := &fakeSecrets{}, &fakeSecrets{}
	from := secretsDaemon(t, t.TempDir(), fromFS)
	toDir := t.TempDir()
	to := secretsDaemon(t, toDir, toFS)
	send, recv := &secretShare{d: from}, &secretShare{d: to}

	if err := send.keep(deepSeekSecret)(ctx, testDSKey); err != nil {
		t.Fatal(err)
	}
	here := map[string]api.SecretItem{}
	for _, it := range send.SecretsHere(ctx) {
		here[it.Name] = it
	}
	if !here["deepseek"].Set || here["kimi"].Set || here["github"].Set {
		t.Fatalf("offered: %+v", here)
	}
	if _, ok := here["telegram"]; ok {
		t.Fatal("the Telegram bot token is offered: two computers polling one bot take each other's messages")
	}
	if _, err := send.SecretValues(ctx, []string{"kimi"}); err == nil || !strings.Contains(err.Error(), "not set") {
		t.Fatalf("a key not set here: %v", err)
	}
	vals, err := send.SecretValues(ctx, []string{"deepseek"})
	if err != nil || len(vals) != 1 || vals[0].Value != testDSKey {
		t.Fatalf("values: %v", err)
	}

	in := append(vals,
		api.SecretValue{Name: "kimi", Value: "two\nlines"},
		api.SecretValue{Name: "telegram", Value: "x"},
		api.SecretValue{Name: "github", Value: "x"},
	)
	got := recv.ReceiveSecrets(ctx, api.SecretSender{ID: "dev1", Name: "MacBook"}, in)
	if len(got.Stored) != 1 || got.Stored[0] != "deepseek" || len(got.Failed) != 3 {
		t.Fatalf("receipt: %+v", got)
	}
	if toFS.get(deepSeekSecret.Service).v != testDSKey {
		t.Fatal("the key did not reach the computer's store")
	}
	if toFS.get(kimiSecret.Service).v != "" {
		t.Fatal("a two-line value was kept")
	}
	if c := to.config(); c.DeepSeekAPIKey != testDSKey || !c.DeepSeekKeyStored {
		t.Fatal("the computer does not use the key it received")
	}
	keys := configKeys(t, toDir) // fails on a credential in config.json
	if !keys["deepseek_key_stored"] {
		t.Fatalf("config.json keys %v", keys)
	}

	list := recv.SecretsReceived()
	if len(list) != 1 || list[0].From != "MacBook" || list[0].FromID != "dev1" || len(list[0].Names) != 1 || list[0].Names[0] != "deepseek" || list[0].At == 0 {
		t.Fatalf("received: %+v", list)
	}
	raw, err := os.ReadFile(filepath.Join(toDir, secretsReceivedFile))
	if err != nil || strings.Contains(string(raw), testDSKey) {
		t.Fatalf("the record holds a value or is missing: %v %s", err, raw)
	}

	// A send that keeps nothing is not recorded; the record keeps the newest.
	recv.ReceiveSecrets(ctx, api.SecretSender{ID: "dev1", Name: "MacBook"}, []api.SecretValue{{Name: "nope", Value: "x"}})
	if n := len(recv.SecretsReceived()); n != 1 {
		t.Fatalf("a send that kept nothing was recorded: %d", n)
	}
	for i := 0; i < secretsReceivedKeep+5; i++ {
		recv.ReceiveSecrets(ctx, api.SecretSender{ID: "dev1", Name: "MacBook"}, vals)
	}
	if n := len(recv.SecretsReceived()); n != secretsReceivedKeep {
		t.Fatalf("the record holds %d sends", n)
	}
}
