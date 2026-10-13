package mail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/mail/ai"
	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
	"github.com/dspv/caprock/internal/mail/providers"
)

// Handler serves /v1/mail/*. Caprock's router puts it behind the same CSRF
// guard and device pairing as every other /v1 route.
func (s *Service) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /v1/mail/state", s.state)
	m.HandleFunc("GET /v1/mail/providers", s.guess)
	m.HandleFunc("POST /v1/mail/accounts", s.addAccount)
	m.HandleFunc("PUT /v1/mail/accounts/{id}", s.updateAccount)
	m.HandleFunc("DELETE /v1/mail/accounts/{id}", s.deleteAccount)
	m.HandleFunc("GET /v1/mail/messages", s.list)
	m.HandleFunc("GET /v1/mail/messages/{id}", s.message)
	m.HandleFunc("GET /v1/mail/messages/{id}/thread", s.thread)
	m.HandleFunc("GET /v1/mail/messages/{id}/part/{path}", s.part)
	m.HandleFunc("POST /v1/mail/actions", s.action)
	m.HandleFunc("POST /v1/mail/send", s.send)
	m.HandleFunc("POST /v1/mail/sync", s.sync)
	m.HandleFunc("GET /v1/mail/contacts", s.contacts)
	m.HandleFunc("GET /v1/mail/settings", s.getSettings)
	m.HandleFunc("PUT /v1/mail/settings", s.putSettings)
	m.HandleFunc("GET /v1/mail/ai/status", s.aiStatus)
	m.HandleFunc("POST /v1/mail/ai/summarize", s.aiSummarize)
	m.HandleFunc("POST /v1/mail/ai/draft", s.aiDraft)
	s.oauthRoutes(m) // http_oauth.go
	return m
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func idParam(r *http.Request) int64 {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id
}

// with opens Mail (first use) and hands the handler its parts.
func (s *Service) with(w http.ResponseWriter, r *http.Request, f func(st *store.Store, eng *engine.Engine)) {
	st, eng, err := s.parts(r.Context())
	if err != nil {
		fail(w, 500, err)
		return
	}
	f(st, eng)
}

// state is the sidebar and the change counter the screen polls. Before Mail
// was ever used it answers from nothing, so the offer on Now can ask "is Mail
// set up" without creating a database.
func (s *Service) state(w http.ResponseWriter, r *http.Request) {
	if !s.opened() && !s.demo {
		writeJSON(w, map[string]any{"accounts": []any{}, "folders": []any{}, "counts": store.Counts{}, "version": 0})
		return
	}
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		ctx := r.Context()
		accts, err := st.Accounts(ctx)
		if err != nil {
			fail(w, 500, err)
			return
		}
		folders, err := st.Folders(ctx, 0)
		if err != nil {
			fail(w, 500, err)
			return
		}
		counts, err := st.UnifiedCounts(ctx)
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, map[string]any{"accounts": accts, "folders": folders, "counts": counts, "version": s.version.Load()})
	})
}

func (s *Service) guess(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	writeJSON(w, providers.Guess(ctx, r.URL.Query().Get("email")))
}

type accountReq struct {
	store.Account
	Password string `json:"password"`
}

func (s *Service) addAccount(w http.ResponseWriter, r *http.Request) {
	var req accountReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	a := req.Account
	a.Email = strings.TrimSpace(a.Email)
	if a.Username == "" {
		a.Username = a.Email
	}
	if a.Email == "" || req.Password == "" || a.IMAPHost == "" || a.SMTPHost == "" {
		fail(w, 400, errors.New("address, password and servers are required"))
		return
	}
	// Checked before anything is stored: a wrong password leaves no trace.
	a, err := engine.TestAccount(a, req.Password)
	if err != nil {
		fail(w, 422, err)
		return
	}
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		id, err := st.AddAccount(r.Context(), a)
		if err != nil {
			fail(w, 500, err)
			return
		}
		if err := s.sec.Set(id, req.Password); err != nil {
			_ = st.DeleteAccount(r.Context(), id)
			fail(w, 500, fmt.Errorf("keychain: %w", err))
			return
		}
		eng.StartAccount(id)
		s.version.Add(1)
		a.ID = id
		writeJSON(w, a)
	})
}

func (s *Service) updateAccount(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		id := idParam(r)
		cur, err := st.Account(r.Context(), id)
		if err != nil {
			fail(w, 404, err)
			return
		}
		var req accountReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		a := req.Account
		a.ID = id
		a.Auth = cur.Auth // changed only by signing in again (http_oauth.go)
		if oauth.ProviderOf(a.Auth) != "" && req.Password != "" {
			fail(w, 400, errors.New("this account signs in with its provider, not a password"))
			return
		}
		serversChanged := a.IMAPHost != cur.IMAPHost || a.IMAPPort != cur.IMAPPort || a.IMAPTLS != cur.IMAPTLS ||
			a.SMTPHost != cur.SMTPHost || a.SMTPPort != cur.SMTPPort || a.SMTPTLS != cur.SMTPTLS || a.Username != cur.Username
		if serversChanged || req.Password != "" {
			pw := req.Password
			if pw == "" {
				if pw, err = eng.Credential(r.Context(), a); err != nil {
					fail(w, 500, err)
					return
				}
			}
			if a, err = engine.TestAccount(a, pw); err != nil {
				fail(w, 422, err)
				return
			}
			if req.Password != "" {
				if err := s.sec.Set(id, req.Password); err != nil {
					fail(w, 500, err)
					return
				}
			}
		}
		if err := st.UpdateAccount(r.Context(), a); err != nil {
			fail(w, 500, err)
			return
		}
		if serversChanged || req.Password != "" {
			eng.StartAccount(id)
		}
		s.version.Add(1)
		writeJSON(w, a)
	})
}

func (s *Service) deleteAccount(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		id := idParam(r)
		eng.StopAccount(id)
		if err := st.DeleteAccount(r.Context(), id); err != nil {
			fail(w, 500, err)
			return
		}
		_ = s.sec.Delete(id)
		s.version.Add(1)
		writeJSON(w, map[string]bool{"ok": true})
	})
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		q := r.URL.Query()
		query := store.Query{View: q.Get("view"), Search: q.Get("q")}
		query.AccountID, _ = strconv.ParseInt(q.Get("account"), 10, 64)
		query.FolderID, _ = strconv.ParseInt(q.Get("folder"), 10, 64)
		query.Before, _ = strconv.ParseInt(q.Get("before"), 10, 64)
		query.BeforeID, _ = strconv.ParseInt(q.Get("before_id"), 10, 64)
		query.Limit, _ = strconv.Atoi(q.Get("limit"))
		ms, err := st.List(r.Context(), query)
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, ms)
	})
}

func (s *Service) message(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(_ *store.Store, eng *engine.Engine) {
		m, err := eng.EnsureBody(r.Context(), idParam(r))
		if errors.Is(err, store.ErrNotFound) {
			fail(w, 404, err)
			return
		}
		if err != nil && m.ID == 0 {
			fail(w, 502, err)
			return
		}
		writeJSON(w, m)
	})
}

func (s *Service) thread(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		ctx := r.Context()
		m, err := st.Message(ctx, idParam(r))
		if err != nil {
			fail(w, 404, err)
			return
		}
		th, err := st.Thread(ctx, m.AccountID, m.ThreadKey)
		if err != nil {
			fail(w, 500, err)
			return
		}
		out := make([]store.Message, 0, len(th))
		for _, t := range th {
			full, err := eng.EnsureBody(ctx, t.ID)
			if err != nil && full.ID == 0 {
				full = t
			}
			out = append(out, full)
		}
		writeJSON(w, out)
	})
}

func (s *Service) part(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(_ *store.Store, eng *engine.Engine) {
		p, data, err := eng.FetchPart(r.Context(), idParam(r), r.PathValue("path"))
		if err != nil {
			code := 502
			if errors.Is(err, engine.ErrNoPart) || errors.Is(err, store.ErrNotFound) {
				code = 404
			}
			fail(w, code, err)
			return
		}
		typ := p.Type
		if typ == "" || typ == "application/octet-stream" {
			if t := mime.TypeByExtension(filepath.Ext(p.Filename)); t != "" {
				typ = t
			}
		}
		// An attachment never runs as a page on the dashboard's origin.
		safeInline := strings.HasPrefix(typ, "image/") && typ != "image/svg+xml" || typ == "application/pdf"
		w.Header().Set("Content-Type", typ)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
		disp := "attachment"
		if safeInline && r.URL.Query().Get("download") == "" {
			disp = "inline"
		}
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disp, map[string]string{"filename": p.Filename}))
		_, _ = w.Write(data)
	})
}

type actionReq struct {
	IDs    []int64 `json:"ids"`
	Action string  `json:"action"`
	Folder int64   `json:"folder"`
}

func (s *Service) action(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(_ *store.Store, eng *engine.Engine) {
		var req actionReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		if err := eng.Apply(r.Context(), req.IDs, req.Action, req.Folder); err != nil {
			code := 502
			if errors.Is(err, engine.ErrBadAction) {
				code = 400
			}
			fail(w, code, err)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
}

func (s *Service) send(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 40<<20)
	s.with(w, r, func(_ *store.Store, eng *engine.Engine) {
		var d engine.Draft
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			fail(w, 400, err)
			return
		}
		if err := eng.Send(r.Context(), d); err != nil {
			code := 502
			if errors.Is(err, engine.ErrNoRecipients) {
				code = 400
			}
			fail(w, code, err)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})
}

func (s *Service) sync(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(_ *store.Store, eng *engine.Engine) {
		id, _ := strconv.ParseInt(r.URL.Query().Get("account"), 10, 64)
		eng.SyncNow(id)
		writeJSON(w, map[string]bool{"ok": true})
	})
}

func (s *Service) contacts(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		cs, err := st.SuggestContacts(r.Context(), r.URL.Query().Get("q"), 8)
		if err != nil {
			fail(w, 500, err)
			return
		}
		writeJSON(w, cs)
	})
}

// Settings the screen may read and write.
var settingKeys = map[string]string{
	"ai_enabled":    "0",
	"ai_url":        ai.DefaultURL,
	"ai_model":      "",
	"remote_images": "ask", // ask | always
}

func readSettings(ctx context.Context, st *store.Store) map[string]string {
	out := map[string]string{}
	for k, def := range settingKeys {
		out[k] = st.Setting(ctx, k, def)
	}
	return out
}

func (s *Service) getSettings(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) { writeJSON(w, readSettings(r.Context(), st)) })
}

func (s *Service) putSettings(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		var in map[string]string
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			fail(w, 400, err)
			return
		}
		for k, v := range in {
			if _, ok := settingKeys[k]; !ok {
				continue
			}
			if err := st.SetSetting(r.Context(), k, v); err != nil {
				fail(w, 500, err)
				return
			}
		}
		s.version.Add(1)
		writeJSON(w, readSettings(r.Context(), st))
	})
}

func aiClient(ctx context.Context, st *store.Store) *ai.Client {
	set := readSettings(ctx, st)
	return &ai.Client{URL: set["ai_url"], Model: set["ai_model"]}
}

func (s *Service) aiStatus(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		models, err := aiClient(r.Context(), st).Models(r.Context())
		if err != nil {
			writeJSON(w, map[string]any{"available": false, "error": err.Error(), "models": []string{}})
			return
		}
		writeJSON(w, map[string]any{"available": true, "models": models})
	})
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

// AI runs only when the user turned it on in Mail's settings.
func aiAllowed(ctx context.Context, st *store.Store) error {
	if readSettings(ctx, st)["ai_enabled"] != "1" {
		return errors.New("local AI is off; turn it on in Mail settings")
	}
	return nil
}

func (s *Service) aiSummarize(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		var req aiReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		if err := aiAllowed(r.Context(), st); err != nil {
			fail(w, 409, err)
			return
		}
		th, _, err := aiThread(r.Context(), st, eng, req.MessageID)
		if err != nil {
			fail(w, 404, err)
			return
		}
		out, err := aiClient(r.Context(), st).Summarize(r.Context(), th)
		if err != nil {
			fail(w, 502, err)
			return
		}
		writeJSON(w, map[string]string{"text": out})
	})
}

func (s *Service) aiDraft(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		var req aiReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		if err := aiAllowed(r.Context(), st); err != nil {
			fail(w, 409, err)
			return
		}
		th, a, err := aiThread(r.Context(), st, eng, req.MessageID)
		if err != nil {
			fail(w, 404, err)
			return
		}
		me := a.Name
		if me == "" {
			me = a.Email
		}
		out, err := aiClient(r.Context(), st).DraftReply(r.Context(), th, me, req.Instruction)
		if err != nil {
			fail(w, 502, err)
			return
		}
		writeJSON(w, map[string]string{"text": out})
	})
}
