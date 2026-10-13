package importer

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// appleMail reads Mail.app's account settings on macOS. Passwords are never
// available: Mail.app keeps them in the login keychain under opaque items that
// cannot be matched to an account, so every imported account has
// HasPassword=false and the user types the password once.
//
// The settings live in ~/Library/Accounts/Accounts4.sqlite (a TCC-protected
// path). Without Full Disk Access the file cannot be opened; appleMail then
// returns a Source carrying NeedsPermission so the dashboard can explain how to
// grant it.
func appleMail(home string) *Source {
	mailDir := filepath.Join(home, "Library", "Mail")
	accounts4 := filepath.Join(home, "Library", "Accounts", "Accounts4.sqlite")

	// Mail.app creates ~/Library/Mail; without it the user does not use Mail.
	if _, err := os.Stat(mailDir); errors.Is(err, fs.ErrNotExist) {
		return nil
	}

	src := &Source{Kind: "apple_mail", Label: "Apple Mail", creds: map[string]string{}}

	f, err := os.Open(accounts4) //nolint:gosec // a fixed, user-owned settings path
	switch {
	case err == nil:
		f.Close()
	case errors.Is(err, fs.ErrPermission):
		src.NeedsPermission = "full_disk_access"
		src.Error = "grant Caprock Full Disk Access in System Settings › Privacy & Security, then reopen Mail"
		return src
	case errors.Is(err, fs.ErrNotExist):
		// Fall through to the legacy plist store below.
	default:
		src.Error = err.Error()
		return src
	}

	accts, err := readAccounts4(accounts4)
	if errors.Is(err, fs.ErrNotExist) {
		// No account database (pre-Ventura macOS). Nothing we can read.
		return nil
	}
	if err != nil {
		src.Error = err.Error()
		return src
	}
	src.Accounts = accts
	return src
}

// readAccounts4 reads IMAP accounts (and their paired SMTP settings) from
// Accounts4.sqlite. The schema (ZACCOUNT / ZACCOUNTTYPE / ZACCOUNTPROPERTY,
// keyed-archiver ZVALUE blobs) is the one accountd has used since macOS
// Ventura.
func readAccounts4(path string) ([]Account, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	// Copy to a temp file so a WAL/locked live database still reads cleanly.
	tmp, err := copyTemp(path)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)

	db, err := sql.Open("sqlite", "file:"+tmp+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	type acctRow struct {
		pk         int64
		identifier string
		username   string
		descr      string
		typ        string
	}
	rows, err := db.Query(`
		SELECT a.Z_PK, a.ZIDENTIFIER, COALESCE(a.ZUSERNAME,''), COALESCE(a.ZACCOUNTDESCRIPTION,''),
		       t.ZIDENTIFIER
		  FROM ZACCOUNT a
		  JOIN ZACCOUNTTYPE t ON t.Z_PK = a.ZACCOUNTTYPE
		 WHERE t.ZIDENTIFIER IN ('com.apple.account.IMAP','com.apple.account.SMTP')`)
	if err != nil {
		return nil, fmt.Errorf("accounts4: %w", err)
	}
	var list []acctRow
	for rows.Next() {
		var r acctRow
		if err := rows.Scan(&r.pk, &r.identifier, &r.username, &r.descr, &r.typ); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	props, err := readProps(db)
	if err != nil {
		return nil, err
	}

	smtpByID := map[string]acctRow{}
	for _, r := range list {
		if r.typ == "com.apple.account.SMTP" {
			smtpByID[r.identifier] = r
		}
	}

	var out []Account
	for _, r := range list {
		if r.typ != "com.apple.account.IMAP" {
			continue
		}
		in := props[r.pk]
		a := Account{
			Username: firstNonEmpty(r.username),
			IMAPHost: str(in["Hostname"]),
			IMAPPort: num(in["PortNumber"], 993),
			IMAPTLS:  tlsFrom(boolean(in["SSLEnabled"]), boolean(in["SSLIsDirect"])),
			Email:    firstNonEmpty(str(in["IdentityEmailAddress"]), r.username),
			Name:     firstNonEmpty(str(in["IdentityDisplayName"]), r.descr),
		}
		if a.IMAPHost == "" {
			continue
		}
		if a.Username == "" {
			a.Username = a.Email
		}
		if out2 := smtpByID[str(in["SendingAccountIdentifier"])]; out2.pk != 0 {
			sp := props[out2.pk]
			a.SMTPHost = str(sp["Hostname"])
			a.SMTPPort = num(sp["PortNumber"], 587)
			a.SMTPTLS = tlsFrom(boolean(sp["SSLEnabled"]), boolean(sp["SSLIsDirect"]))
		}
		out = append(out, a)
	}
	return out, nil
}

// readProps reads ZACCOUNTPROPERTY into owner → key → resolved value.
func readProps(db *sql.DB) (map[int64]map[string]any, error) {
	rows, err := db.Query(`SELECT ZOWNER, ZKEY, ZVALUE FROM ZACCOUNTPROPERTY WHERE ZOWNER IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("accountproperty: %w", err)
	}
	defer rows.Close()
	out := map[int64]map[string]any{}
	for rows.Next() {
		var owner int64
		var key string
		var val []byte
		if err := rows.Scan(&owner, &key, &val); err != nil {
			return nil, err
		}
		if out[owner] == nil {
			out[owner] = map[string]any{}
		}
		out[owner][key] = decodeProp(val)
	}
	return out, rows.Err()
}

// decodeProp turns a ZVALUE blob into a Go scalar, unwrapping a keyed archive
// when it is one.
func decodeProp(blob []byte) any {
	v, err := parseBplist(blob)
	if err != nil {
		return nil
	}
	if m, ok := v.(map[string]any); ok {
		if _, keyed := m["$objects"]; keyed {
			if u, err := unarchive(m); err == nil {
				return u
			}
		}
	}
	return v
}

func copyTemp(path string) (string, error) {
	in, err := os.Open(path) //nolint:gosec // a fixed, user-owned settings path
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.CreateTemp("", "caprock-accounts4-*.sqlite")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(out.Name())
		return "", err
	}
	// Copy the WAL alongside so committed-but-uncheckpointed rows are seen.
	if wal, werr := os.ReadFile(path + "-wal"); werr == nil {
		_ = os.WriteFile(out.Name()+"-wal", wal, 0o600)
	}
	return out.Name(), out.Close()
}

// tlsFrom maps Mail.app's SSLEnabled/SSLIsDirect pair to Caprock's tls string.
func tlsFrom(sslEnabled, direct bool) string {
	switch {
	case sslEnabled && direct:
		return "tls"
	case sslEnabled:
		return "starttls"
	default:
		return "none"
	}
}

func str(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func num(v any, def int) int {
	switch n := v.(type) {
	case int64:
		if n > 0 {
			return int(n)
		}
	case float64:
		if n > 0 {
			return int(n)
		}
	case string:
		if x := atoi(n); x > 0 {
			return x
		}
	}
	return def
}

func boolean(v any) bool {
	switch b := v.(type) {
	case bool:
		return b
	case int64:
		return b != 0
	case float64:
		return b != 0
	}
	return false
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
