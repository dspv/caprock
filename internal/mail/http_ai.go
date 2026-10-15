package mail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/mail/ai"
	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/secret"
)

// AIDeps is what Mail's assistant needs from the daemon to run the user's
// own coding CLIs: where each one is, and the environment it runs in.
type AIDeps struct {
	// Binary finds a CLI by command name ("claude", "codex", "gemini") and
	// returns its absolute path, "" when this computer does not have it.
	// Called on every status request: it must not wait on a shell.
	Binary func(command string) string
	// Env is the user's login-shell environment, for the CLI's PATH and
	// whatever its login reads.
	Env func() []string
	// Dir is an empty working folder of Caprock's for the calls.
	Dir string
}

// aiState is the assistant's part of Service.
type aiState struct {
	mu   sync.Mutex
	deps AIDeps
	keys map[string]secret.Store // the real key stores, built on first use
	home *string
	// sampleKeys holds keys typed while sample mode is on: sample mode never
	// touches the keychain.
	sampleKeys map[string]string
}

// SetAI hands Mail the daemon's CLI finder and environment. Without it no
// CLI provider is offered (a test's Service, for one).
func (s *Service) SetAI(d AIDeps) {
	s.ai.mu.Lock()
	defer s.ai.mu.Unlock()
	if d.Dir == "" {
		d.Dir = filepath.Join(s.dir, "mail-ai")
	}
	s.ai.deps = d
}

func (s *Service) aiDeps() AIDeps {
	s.ai.mu.Lock()
	defer s.ai.mu.Unlock()
	return s.ai.deps
}

// keyItem is where a provider's API key lives: the login keychain on macOS,
// a 0600 file in the data directory elsewhere (internal/secret, as the
// DeepSeek key for sessions). Never mail.db, config.json or a log.
func keyItem(p ai.Info) secret.Item {
	return secret.Item{Service: "dev.caprock.mail.ai." + p.ID, Label: "Caprock Mail " + p.Label + " key",
		File: "mail-ai-" + p.ID + "-key", Noun: "key"}
}

// keyStore is a provider's real key store; nil for a provider without keys.
func (s *Service) keyStore(id string) secret.Store {
	p, ok := ai.Lookup(id)
	if !ok || p.Kind != ai.KindAPI {
		return nil
	}
	s.ai.mu.Lock()
	defer s.ai.mu.Unlock()
	if st, ok := s.ai.keys[id]; ok {
		return st
	}
	if s.ai.home == nil {
		h := secret.UserHome(context.Background())
		s.ai.home = &h
	}
	if s.ai.keys == nil {
		s.ai.keys = map[string]secret.Store{}
	}
	st := secret.Default(s.dir, keyItem(p), *s.ai.home)
	s.ai.keys[id] = st
	return st
}

func (s *Service) getKey(ctx context.Context, id string) (string, error) {
	if s.inSample() {
		s.ai.mu.Lock()
		defer s.ai.mu.Unlock()
		return s.ai.sampleKeys[id], nil
	}
	st := s.keyStore(id)
	if st == nil {
		return "", nil
	}
	v, err := st.Get(ctx)
	return strings.TrimSpace(v), err
}

func (s *Service) putKey(ctx context.Context, id, v string) error {
	if s.inSample() {
		s.ai.mu.Lock()
		defer s.ai.mu.Unlock()
		if s.ai.sampleKeys == nil {
			s.ai.sampleKeys = map[string]string{}
		}
		if v == "" {
			delete(s.ai.sampleKeys, id)
		} else {
			s.ai.sampleKeys[id] = v
		}
		return nil
	}
	st := s.keyStore(id)
	if st == nil {
		return errors.New("this provider takes no key")
	}
	if v == "" {
		return st.Delete(ctx)
	}
	return st.Set(ctx, v)
}

// providerState is one row of the picker.
type providerState struct {
	ai.Info
	Available bool          `json:"available"`
	Why       string        `json:"why,omitempty"` // why not, when not
	Model     string        `json:"model"`         // the saved model; "" is the default
	KeySet    bool          `json:"key_set,omitempty"`
	KeyWhere  *secret.Where `json:"key_where,omitempty"`
}

// providerStatus works out whether one provider can answer now. The local
// server is asked for its models (3 s at most); nothing else makes a call.
func (s *Service) providerStatus(ctx context.Context, p ai.Info, set map[string]string) (providerState, []string) {
	ps := providerState{Info: p, Model: set[modelKey(p.ID)]}
	var models []string
	switch p.Kind {
	case ai.KindCLI:
		bin := ""
		if f := s.aiDeps().Binary; f != nil {
			bin = f(p.Command)
		}
		ps.Available = bin != ""
		if !ps.Available {
			ps.Why = "`" + p.Command + "` is not installed on this computer"
		}
	case ai.KindAPI:
		key, err := s.getKey(ctx, p.ID)
		ps.KeySet = key != ""
		if ps.KeySet && !s.inSample() {
			w := secret.Locate(s.keyStore(p.ID))
			ps.KeyWhere = &w
		}
		switch {
		case err != nil:
			ps.Why = "the key could not be read: " + err.Error()
		case !ps.KeySet:
			ps.Why = "no API key yet"
		case p.NeedsModel && ps.Model == "":
			ps.Why = "type a model"
		default:
			ps.Available = true
		}
	case ai.KindLocal:
		ps.SendsTo = ai.LocalSendsTo(set["ai_url"])
		ms, err := (&ai.Client{URL: set["ai_url"]}).Models(ctx)
		if err != nil {
			ps.Why = err.Error()
		} else if len(ms) == 0 {
			ps.Why = "the model server has no models; pull one, e.g. `ollama pull qwen3:8b`"
		} else {
			ps.Available = true
		}
		models = ms
	}
	return ps, models
}

// chosen resolves the provider to use: the saved one, or the first of
// ai.AutoOrder that is available. ok is false when none is.
func (s *Service) chosen(ctx context.Context, set map[string]string) (providerState, []string, bool) {
	if id := set["ai_provider"]; id != "" {
		if p, ok := ai.Lookup(id); ok {
			ps, models := s.providerStatus(ctx, p, set)
			return ps, models, ps.Available
		}
	}
	var first providerState
	var firstModels []string
	for i, id := range ai.AutoOrder {
		p, _ := ai.Lookup(id)
		ps, models := s.providerStatus(ctx, p, set)
		if i == 0 {
			first, firstModels = ps, models
		}
		if ps.Available {
			return ps, models, true
		}
	}
	return first, firstModels, false
}

// chatter builds the client for a provider that is available.
func (s *Service) chatter(ctx context.Context, ps providerState, set map[string]string) (ai.Chatter, error) {
	switch ps.Kind {
	case ai.KindCLI:
		d := s.aiDeps()
		bin := ""
		if d.Binary != nil {
			bin = d.Binary(ps.Command)
		}
		var env []string
		if d.Env != nil {
			env = d.Env()
		}
		return &ai.CLI{Provider: ps.ID, Binary: bin, Env: env, Dir: d.Dir, Model: ps.Model}, nil
	case ai.KindAPI:
		key, err := s.getKey(ctx, ps.ID)
		if err != nil {
			return nil, err
		}
		model := ps.Model
		if model == "" {
			model = ps.Info.Model
		}
		if ps.ID == ai.ProviderAnthropic {
			return &ai.Anthropic{Key: key, Model: model}, nil
		}
		return &ai.Client{URL: ps.URL, Key: key, Model: model, Remote: true}, nil
	default:
		return &ai.Client{URL: set["ai_url"], Model: set["ai_model"]}, nil
	}
}

// aiStatus answers which provider the assistant uses and why it can or
// cannot, with every provider for the picker. Before Mail is used it
// answers from the defaults, without creating mail.db.
func (s *Service) aiStatus(w http.ResponseWriter, r *http.Request) {
	answer := func(set map[string]string) {
		ctx := r.Context()
		cur, models, ok := s.chosen(ctx, set)
		rows := make([]providerState, 0, len(ai.Providers))
		for _, p := range ai.Providers {
			if p.ID == cur.ID {
				rows = append(rows, cur)
				continue
			}
			ps, _ := s.providerStatus(ctx, p, set)
			rows = append(rows, ps)
		}
		if models == nil {
			models = []string{}
		}
		out := map[string]any{
			"chosen": set["ai_provider"], "provider": cur.ID, "label": cur.Label, "sends_to": cur.SendsTo,
			"available": ok, "models": models, "providers": rows,
		}
		if !ok {
			if set["ai_provider"] == "" {
				out["provider"], out["label"], out["sends_to"] = "", "", ""
				out["error"] = "no provider is set up: install Claude Code, Codex or Gemini CLI and sign in, add an API key, or run a local model server"
			} else {
				out["error"] = cur.Why
			}
		}
		writeJSON(w, out)
	}
	if !s.opened() && !s.inSample() {
		set := map[string]string{}
		for k, def := range settingKeys {
			set[k] = def
		}
		answer(set)
		return
	}
	s.with(w, r, func(st *store.Store, _ *engine.Engine) { answer(readSettings(r.Context(), st)) })
}

type keyReq struct {
	Provider string `json:"provider"`
	Key      string `json:"key"` // "" removes it
}

// aiKey stores or removes a provider's API key. The key is never sent back.
func (s *Service) aiKey(w http.ResponseWriter, r *http.Request) {
	var req keyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	p, ok := ai.Lookup(req.Provider)
	if !ok || p.Kind != ai.KindAPI {
		fail(w, 400, fmt.Errorf("%q takes no API key", req.Provider))
		return
	}
	if err := s.putKey(r.Context(), p.ID, strings.TrimSpace(req.Key)); err != nil {
		fail(w, 500, fmt.Errorf("could not store the key: %w", err))
		return
	}
	s.version.Add(1)
	writeJSON(w, map[string]bool{"ok": true, "key_set": strings.TrimSpace(req.Key) != ""})
}

type aiReq struct {
	MessageID   int64  `json:"message_id"`
	Instruction string `json:"instruction"`
}

func aiThread(ctx context.Context, st *store.Store, eng *engine.Engine, id int64) ([]ai.Mail, store.Account, error) {
	m, err := st.Message(ctx, id)
	if err != nil {
		return nil, store.Account{}, err
	}
	a, err := st.Account(ctx, m.AccountID)
	if err != nil {
		return nil, a, err
	}
	th, err := st.Thread(ctx, m.AccountID, m.ThreadKey)
	if err != nil {
		return nil, a, err
	}
	if len(th) > 8 {
		th = th[len(th)-8:]
	}
	var out []ai.Mail
	for _, t := range th {
		full, err := eng.EnsureBody(ctx, t.ID)
		if err != nil && full.ID == 0 {
			continue
		}
		from := full.FromName
		if from == "" {
			from = full.FromAddr
		}
		out = append(out, ai.Mail{From: from, Date: time.Unix(full.Date, 0).Format("2006-01-02 15:04"), Subject: full.Subject, Body: full.BodyText})
	}
	return out, a, nil
}

// aiRun is the common path of the two actions: AI must be on (ADR-047),
// a provider must answer, and only then is the thread read and sent.
func (s *Service) aiRun(w http.ResponseWriter, r *http.Request, run func(ctx context.Context, c ai.Chatter, th []ai.Mail, a store.Account, req aiReq) (string, error)) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		var req aiReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		ctx := r.Context()
		set := readSettings(ctx, st)
		if set["ai_enabled"] != "1" {
			fail(w, 409, errors.New("AI is off; turn it on in Mail settings"))
			return
		}
		ps, _, ok := s.chosen(ctx, set)
		if !ok {
			why := ps.Why
			if set["ai_provider"] == "" {
				why = "no provider is set up; choose one in Mail settings"
			}
			fail(w, 409, errors.New(why))
			return
		}
		c, err := s.chatter(ctx, ps, set)
		if err != nil {
			fail(w, 500, err)
			return
		}
		th, a, err := aiThread(ctx, st, eng, req.MessageID)
		if err != nil {
			fail(w, 404, err)
			return
		}
		out, err := run(ctx, c, th, a, req)
		if err != nil {
			fail(w, 502, err)
			return
		}
		writeJSON(w, map[string]string{"text": out, "provider": ps.ID, "label": ps.Label})
	})
}

func (s *Service) aiSummarize(w http.ResponseWriter, r *http.Request) {
	s.aiRun(w, r, func(ctx context.Context, c ai.Chatter, th []ai.Mail, _ store.Account, _ aiReq) (string, error) {
		return ai.Summarize(ctx, c, th)
	})
}

func (s *Service) aiDraft(w http.ResponseWriter, r *http.Request) {
	s.aiRun(w, r, func(ctx context.Context, c ai.Chatter, th []ai.Mail, a store.Account, req aiReq) (string, error) {
		me := a.Name
		if me == "" {
			me = a.Email
		}
		return ai.DraftReply(ctx, c, th, me, req.Instruction)
	})
}
