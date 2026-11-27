package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// fakeSecretShare is one daemon's store: values it holds, and what arrived.
type fakeSecretShare struct {
	mu       sync.Mutex
	vals     map[string]string
	arrivals []SecretArrival
}

var fakeSecretLabels = map[string]string{"github": "GitHub token", "deepseek": "DeepSeek key", "kimi": "Kimi key"}

func (f *fakeSecretShare) SecretsHere(context.Context) []SecretItem {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []SecretItem
	for _, n := range []string{"github", "deepseek", "kimi"} {
		out = append(out, SecretItem{Name: n, Label: fakeSecretLabels[n], Set: f.vals[n] != ""})
	}
	return out
}

func (f *fakeSecretShare) SecretValues(_ context.Context, names []string) ([]SecretValue, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []SecretValue
	for _, n := range names {
		if f.vals[n] == "" {
			return nil, fmt.Errorf("the %s is not set on this computer", n)
		}
		out = append(out, SecretValue{Name: n, Value: f.vals[n]})
	}
	return out, nil
}

func (f *fakeSecretShare) ReceiveSecrets(_ context.Context, from SecretSender, in []SecretValue) SecretReceipt {
	f.mu.Lock()
	defer f.mu.Unlock()
	var got SecretReceipt
	for _, v := range in {
		if fakeSecretLabels[v.Name] == "" {
			got.Failed = append(got.Failed, SecretFailure{Name: v.Name, Error: "unknown"})
			continue
		}
		if f.vals == nil {
			f.vals = map[string]string{}
		}
		f.vals[v.Name] = v.Value
		got.Stored = append(got.Stored, v.Name)
	}
	f.arrivals = append([]SecretArrival{{FromID: from.ID, From: from.Name, Names: got.Stored, At: 1}}, f.arrivals...)
	return got
}

func (f *fakeSecretShare) SecretsReceived() []SecretArrival {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SecretArrival(nil), f.arrivals...)
}

// A value made at run time, so nothing here looks like a real key.
var fakeDeepSeekValue = strings.Join([]string{"fake", "deepseek", "value", "for", "tests"}, "-")

// The whole send, through two API servers: the laptop's, and the computer's
// behind a fake channel that delivers the request as the computer's paired
// device there (what peers.Manager.Do sets). The value reaches the far store
// and appears in no answer on either side.
func TestSendSecretsToAComputer(t *testing.T) {
	far := &fakeSecretShare{}
	rs, ps, viewer, controller := pairedPhones(t, Deps{Secrets: far})
	laptop := pairedComputer(t, ps, "MacBook", true)
	fm := &fakeMachines{status: "online", far: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.Clone(r.Context())
		r.RemoteAddr = testPhone
		r.Header.Set(deviceTokenHeader, laptop.Token)
		rs.ServeHTTP(w, r)
	})}
	here := &fakeSecretShare{vals: map[string]string{"deepseek": fakeDeepSeekValue}}
	s := New(Deps{Machines: fm, Secrets: here})

	// What this machine can send: names, never a value.
	w := serve(s, local("GET", "/v1/machines/secrets", ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"name":"deepseek"`) || strings.Contains(w.Body.String(), fakeDeepSeekValue) {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}

	w = serve(s, local("POST", "/v1/machines/mini/secrets", `{"names":["deepseek","deepseek"]}`))
	if w.Code != 200 {
		t.Fatalf("send: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), fakeDeepSeekValue) {
		t.Fatalf("the send's answer carries the value: %s", w.Body)
	}
	var got SecretReceipt
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got.Stored) != 1 || got.Stored[0] != "deepseek" || len(got.Failed) != 0 {
		t.Fatalf("send answered %s", w.Body)
	}
	if far.vals["deepseek"] != fakeDeepSeekValue {
		t.Fatalf("the far store holds %q", far.vals["deepseek"])
	}

	// The computer says which names arrived, from whom — to its own clients.
	w = serve(rs, local("GET", "/v1/secrets/received", ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"from":"MacBook"`) || !strings.Contains(w.Body.String(), `"deepseek"`) || strings.Contains(w.Body.String(), fakeDeepSeekValue) {
		t.Fatalf("received: %d %s", w.Code, w.Body)
	}
	if w := serve(rs, fromDevice("GET", "/v1/secrets/received", "", laptop.Token)); w.Code != http.StatusForbidden {
		t.Fatalf("a computer read what arrived on another: %d", w.Code)
	}

	// Only a computer allowed there may hand it secrets: not its own
	// clients, not a phone, whatever its role.
	body := `{"secrets":[{"name":"kimi","value":"x"}]}`
	for name, r := range map[string]*http.Request{
		"loopback":         local("POST", "/v1/secrets/receive", body),
		"viewer phone":     fromDevice("POST", "/v1/secrets/receive", body, viewer.Token),
		"controller phone": fromDevice("POST", "/v1/secrets/receive", body, controller.Token),
	} {
		if w := serve(rs, r); w.Code != http.StatusForbidden {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if far.vals["kimi"] != "" {
		t.Fatal("a refused caller's secret was kept")
	}

	// The sending routes are this machine's own.
	if w := serve(s, fromDevice("POST", "/v1/machines/mini/secrets", `{"names":["deepseek"]}`, "x")); w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
		t.Fatalf("send from the network: %d", w.Code)
	}
	// Nothing picked, something not set here, an unknown computer.
	if w := serve(s, local("POST", "/v1/machines/mini/secrets", `{"names":[]}`)); w.Code != 400 {
		t.Fatalf("empty: %d", w.Code)
	}
	if w := serve(s, local("POST", "/v1/machines/mini/secrets", `{"names":["kimi"]}`)); w.Code != 400 || !strings.Contains(w.Body.String(), "not set") {
		t.Fatalf("not set: %d %s", w.Code, w.Body)
	}
	if w := serve(s, local("POST", "/v1/machines/nope/secrets", `{"names":["deepseek"]}`)); w.Code != 404 {
		t.Fatalf("unknown computer: %d", w.Code)
	}
}

// A computer whose Caprock has no receiving end says so: update it there.
func TestSendSecretsToAnOlderComputer(t *testing.T) {
	fm := &fakeMachines{status: "online", far: http.NotFoundHandler()}
	s := New(Deps{Machines: fm, Secrets: &fakeSecretShare{vals: map[string]string{"deepseek": fakeDeepSeekValue}}})
	w := serve(s, local("POST", "/v1/machines/mini/secrets", `{"names":["deepseek"]}`))
	if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), "update Caprock there") {
		t.Fatalf("older computer: %d %s", w.Code, w.Body)
	}
}
