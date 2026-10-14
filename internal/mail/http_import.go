package mail

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/dspv/caprock/internal/mail/engine"
	"github.com/dspv/caprock/internal/mail/importer"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/oauth"
)

// importRoutes registers the account-import endpoints. The Handler calls this
// so http.go keeps a single added line.
func (s *Service) importRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /v1/mail/import", s.importSources)
	m.HandleFunc("POST /v1/mail/import", s.importAccounts)
}

// foundAccount is one row of the "Import everything" screen.
type foundAccount struct {
	importer.Found
	// Signin is the one step left before the account works: ready (its
	// password came with it), oauth (Sign in with Google or Microsoft),
	// app_password (iCloud, Yahoo, Fastmail, and Google or Microsoft when
	// this build has no client ID for them), or password.
	Signin string `json:"signin"`
}

// signinFor is what an imported account still needs, given which OAuth
// providers this build can sign in with.
func signinFor(f importer.Found, oauthOK map[string]bool) string {
	if f.HasPassword {
		return "ready"
	}
	switch f.Provider {
	case "google", "microsoft":
		if oauthOK[f.Provider] {
			return "oauth"
		}
		return "app_password"
	case "icloud", "yahoo", "fastmail":
		return "app_password"
	}
	return "password"
}

// importSources lists the accounts found in other mail clients: per source,
// and merged into one list with the step each still needs. It reads local
// files only; it never opens mail.db or starts the engine, so offering the
// import on a never-used Mail touches nothing (TestUnusedMailTouchesNothing).
// Passwords are not included: they stay server-side (rule 4).
func (s *Service) importSources(w http.ResponseWriter, _ *http.Request) {
	sources := importer.Sources(s.homeDir())
	avail := oauth.Available()
	accounts := []foundAccount{}
	for _, f := range importer.Merge(sources) {
		accounts = append(accounts, foundAccount{Found: f, Signin: signinFor(f, avail)})
	}
	writeJSON(w, map[string]any{"sources": sources, "accounts": accounts, "oauth": avail})
}

type importReq struct {
	Source    string            `json:"source"` // Source.Kind
	Emails    []string          `json:"emails"`
	Passwords map[string]string `json:"passwords"` // email → password, for accounts without a recovered one
}

type importResult struct {
	Email string `json:"email"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// Already is set when Mail had the address: nothing was added twice.
	Already bool `json:"already,omitempty"`
}

// importAccounts adds the chosen accounts, one at a time. Each password comes
// from the source (decrypted locally) or from the request's passwords map; it
// is verified against the real servers before anything is stored, exactly like
// POST /v1/mail/accounts. One account failing never stops the rest.
func (s *Service) importAccounts(w http.ResponseWriter, r *http.Request) {
	var req importReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	// Re-read the sources so passwords are recovered fresh and never had to
	// travel over HTTP from the earlier GET.
	var src *importer.Source
	for _, cand := range importer.Sources(s.homeDir()) {
		if cand.Kind == req.Source {
			c := cand
			src = &c
			break
		}
	}
	if src == nil {
		fail(w, 404, errors.New("no such import source"))
		return
	}
	byEmail := map[string]importer.Account{}
	for _, a := range src.Accounts {
		byEmail[strings.ToLower(a.Email)] = a
	}

	s.leaveSample()
	s.with(w, r, func(st *store.Store, eng *engine.Engine) {
		results := make([]importResult, 0, len(req.Emails))
		for _, email := range req.Emails {
			email = strings.TrimSpace(email)
			results = append(results, s.importOne(r, st, eng, src, byEmail, email, req.Passwords))
		}
		writeJSON(w, map[string]any{"results": results})
	})
}

func (s *Service) importOne(r *http.Request, st *store.Store, eng *engine.Engine, src *importer.Source, byEmail map[string]importer.Account, email string, reqPasswords map[string]string) importResult {
	res := importResult{Email: email}
	a, ok := byEmail[strings.ToLower(email)]
	if !ok {
		res.Error = "account not found in source"
		return res
	}
	if have, err := st.Accounts(r.Context()); err == nil {
		for _, h := range have {
			if strings.EqualFold(h.Email, a.Email) {
				res.OK, res.Already = true, true
				return res
			}
		}
	}
	// A password typed on the screen wins: it is the retry after a saved one
	// was refused.
	pw := reqPasswords[email]
	if pw == "" {
		pw, _ = src.Password(a.Email)
	}
	if pw == "" {
		res.Error = "no password; supply one to import this account"
		return res
	}
	acct := store.Account{
		Name: a.Name, Email: a.Email, Username: a.Username,
		IMAPHost: a.IMAPHost, IMAPPort: a.IMAPPort, IMAPTLS: a.IMAPTLS,
		SMTPHost: a.SMTPHost, SMTPPort: a.SMTPPort, SMTPTLS: a.SMTPTLS,
	}
	if acct.Username == "" {
		acct.Username = acct.Email
	}
	if acct.Email == "" || acct.IMAPHost == "" || acct.SMTPHost == "" {
		res.Error = "incomplete account settings"
		return res
	}
	// Verify against the real servers before storing anything, like addAccount.
	acct, err := engine.TestAccount(acct, pw)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	id, err := st.AddAccount(r.Context(), acct)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	if err := s.sec.Set(id, pw); err != nil {
		_ = st.DeleteAccount(r.Context(), id)
		res.Error = "keychain: " + err.Error()
		return res
	}
	eng.StartAccount(id)
	s.version.Add(1)
	res.OK = true
	return res
}
