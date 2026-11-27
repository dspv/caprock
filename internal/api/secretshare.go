package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/pairing"
)

// Send secrets (ADR-107, issue #1095): the owner copies chosen credentials
// from this machine's secret store into a linked computer's, on a click, so
// setting that computer up never needs SSH.
//
// The values travel only inside the end-to-end encrypted channel to that
// computer (ADR-058, ADR-067): this daemon reads them from its store, posts
// them as one request through peers.Manager.Do, and the computer writes them
// straight into its own store. No value is ever in an API answer, a log, an
// event, the database or a live frame — on either side, only names.

// SecretShare is the daemon's side: which credentials it can send, their
// values for one send, and where an arriving one is written.
type SecretShare interface {
	// SecretsHere lists what Send secrets offers: every credential it knows,
	// set here or not. Names only.
	SecretsHere(ctx context.Context) []SecretItem
	// SecretValues reads the named credentials for one send. An unknown
	// name, or one not set here, is an error that names it.
	SecretValues(ctx context.Context, names []string) ([]SecretValue, error)
	// ReceiveSecrets writes what arrived into this machine's store, each on
	// its own, and records the names that arrived and when.
	ReceiveSecrets(ctx context.Context, from SecretSender, in []SecretValue) SecretReceipt
	// SecretsReceived is that record, newest first.
	SecretsReceived() []SecretArrival
}

// SecretItem is one credential Send secrets offers. Never a value.
type SecretItem struct {
	// Name is how the wire names it: github, deepseek, kimi.
	Name string `json:"name"`
	// Label is how a person calls it: "GitHub token".
	Label string `json:"label"`
	// Set is whether this machine holds it now.
	Set bool `json:"set"`
	// Note says why it cannot be sent when it is not set here in a way a
	// person would not guess (GitHub through the GitHub CLI's login).
	Note string `json:"note,omitempty"`
}

// SecretValue is one credential in flight. Only ever inside the channel.
type SecretValue struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// SecretSender is the computer a send came from, as this one lists it.
type SecretSender struct {
	ID   string
	Name string
}

// SecretReceipt is what the receiving computer answers: names only.
type SecretReceipt struct {
	Stored []string        `json:"stored"`
	Failed []SecretFailure `json:"failed"`
}

// SecretFailure is a credential that arrived and could not be kept, and why.
type SecretFailure struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// SecretArrival is one send that reached this computer: from whom, which
// names were kept, and when (unix ms). Never a value.
type SecretArrival struct {
	FromID string   `json:"from_id"`
	From   string   `json:"from"`
	Names  []string `json:"names"`
	At     int64    `json:"at"`
}

// maxSecretsPerSend bounds one send; there are three credentials today.
const maxSecretsPerSend = 16

// secretSendWait bounds one send: the channel, and on the computer the GitHub
// check a token goes through before it is kept.
const secretSendWait = 60 * time.Second

// errSecretsTooOld is a computer whose Caprock has no receiving end.
var errSecretsTooOld = errors.New("that computer runs a Caprock from before Send secrets: update Caprock there first")

func (s *Server) requireSecrets(w http.ResponseWriter) bool {
	if s.d.Secrets == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "this build cannot send or receive secrets"})
		return false
	}
	return true
}

// handleSecretsHere is GET /v1/machines/secrets: what this machine can send.
// Loopback only, like every /v1/machines route.
func (s *Server) handleSecretsHere(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) || !s.requireSecrets(w) {
		return
	}
	items := s.d.Secrets.SecretsHere(r.Context())
	if items == nil {
		items = []SecretItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"secrets": items})
}

// handleSendSecrets is POST /v1/machines/{id}/secrets {names}: the owner's
// click on Send. The values are read here and carried to the computer in one
// request through its channel; the answer names what it kept.
func (s *Server) handleSendSecrets(w http.ResponseWriter, r *http.Request) {
	if !s.machinesLocal(w, r) || !s.requireSecrets(w) {
		return
	}
	var body struct {
		Names []string `json:"names"`
	}
	if !decodeLimited(w, r, 4<<10, &body, `{"names": ["github", "deepseek", "kimi"]}`) {
		return
	}
	var names []string
	seen := map[string]bool{}
	for _, n := range body.Names {
		n = strings.TrimSpace(n)
		if n != "" && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	if len(names) == 0 || len(names) > maxSecretsPerSend {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pick at least one secret to send"})
		return
	}
	id := r.PathValue("id")
	if _, err := s.d.Machines.Get(id); err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), secretSendWait)
	defer cancel()
	vals, err := s.d.Secrets.SecretValues(ctx, names)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	payload, err := json.Marshal(map[string]any{"secrets": vals})
	if err != nil {
		s.fail(w, err)
		return
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://machine/v1/secrets/receive", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	res, err := s.d.Machines.Do(id, req)
	if err != nil {
		writeJSON(w, machineErrStatus(err), map[string]string{"error": err.Error()})
		return
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	_ = res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound, http.StatusMethodNotAllowed:
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": errSecretsTooOld.Error()})
		return
	default:
		var refused struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(b, &refused)
		if refused.Error == "" {
			refused.Error = http.StatusText(res.StatusCode)
		}
		status := res.StatusCode
		if status < 400 {
			status = http.StatusBadGateway
		}
		writeJSON(w, status, map[string]string{"error": "that computer did not take them: " + refused.Error})
		return
	}
	var got SecretReceipt
	if err := json.Unmarshal(b, &got); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "that computer's answer did not say what it kept"})
		return
	}
	if got.Stored == nil {
		got.Stored = []string{}
	}
	if got.Failed == nil {
		got.Failed = []SecretFailure{}
	}
	if s.d.Log != nil {
		s.d.Log.Info("sent secrets to another computer", "component", "secrets", "machine", id, "stored", got.Stored, "failed", len(got.Failed))
	}
	writeJSON(w, http.StatusOK, got)
}

// handleReceiveSecrets is POST /v1/secrets/receive {secrets: [{name,
// value}]}: credentials sent by a computer this one allowed (kind machine,
// controller, its token held to the key its channel proved — the gate's
// checks), written straight into this machine's secret store. Nothing else
// may call it: not this machine's own clients, not a phone.
func (s *Server) handleReceiveSecrets(w http.ResponseWriter, r *http.Request) {
	dev := deviceFrom(r)
	if dev == nil || dev.Kind != pairing.KindMachine {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "secrets arrive here only from a computer allowed here, through its link"})
		return
	}
	if !s.requireSecrets(w) {
		return
	}
	var body struct {
		Secrets []SecretValue `json:"secrets"`
	}
	if !decodeLimited(w, r, 64<<10, &body, `{"secrets": [{"name", "value"}]}`) {
		return
	}
	if len(body.Secrets) == 0 || len(body.Secrets) > maxSecretsPerSend {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nothing to keep"})
		return
	}
	got := s.d.Secrets.ReceiveSecrets(r.Context(), SecretSender{ID: dev.ID, Name: dev.Name}, body.Secrets)
	if got.Stored == nil {
		got.Stored = []string{}
	}
	if got.Failed == nil {
		got.Failed = []SecretFailure{}
	}
	writeJSON(w, http.StatusOK, got)
}

// handleSecretsReceived is GET /v1/secrets/received: which names arrived
// here, from which computer, and when. This machine's own clients only.
func (s *Server) handleSecretsReceived(w http.ResponseWriter, r *http.Request) {
	if !isLocal(r) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "this is read on the machine Caprock runs on"})
		return
	}
	if !s.requireSecrets(w) {
		return
	}
	list := s.d.Secrets.SecretsReceived()
	if list == nil {
		list = []SecretArrival{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"arrivals": list})
}
