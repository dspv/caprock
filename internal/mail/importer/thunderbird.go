package importer

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// thunderbirdRoots returns the directories that may hold a profiles.ini, newest
// convention first, for the current OS.
func thunderbirdRoots(home string) []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{filepath.Join(home, "Library", "Thunderbird")}
	case "windows":
		return []string{filepath.Join(home, "AppData", "Roaming", "Thunderbird")}
	default:
		return []string{filepath.Join(home, ".thunderbird"), filepath.Join(home, ".mozilla-thunderbird")}
	}
}

// thunderbird reads every Thunderbird profile under home and returns one Source
// with every IMAP account found, or nil when Thunderbird is not installed.
func thunderbird(home string) *Source {
	var root string
	for _, r := range thunderbirdRoots(home) {
		if _, err := os.Stat(filepath.Join(r, "profiles.ini")); err == nil {
			root = r
			break
		}
	}
	if root == "" {
		return nil
	}
	src := &Source{Kind: "thunderbird", Label: "Thunderbird", creds: map[string]string{}}
	for _, prof := range profilePaths(root) {
		readTBProfile(prof, src)
	}
	return src
}

// profilePaths lists absolute profile directories named in profiles.ini.
func profilePaths(root string) []string {
	f, err := os.Open(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var paths []string
	var path string
	var relative = true
	flush := func() {
		if path == "" {
			return
		}
		if relative {
			paths = append(paths, filepath.Join(root, filepath.FromSlash(path)))
		} else {
			paths = append(paths, filepath.FromSlash(path))
		}
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			flush()
			path, relative = "", true
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "Path":
			path = strings.TrimSpace(v)
		case "IsRelative":
			relative = strings.TrimSpace(v) != "0"
		}
	}
	flush()
	return paths
}

var prefRe = regexp.MustCompile(`^user_pref\("([^"]+)",\s*(.*)\);\s*$`)

// readPrefs parses prefs.js into a flat key→value map (strings unquoted).
func readPrefs(path string) map[string]string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		m := prefRe.FindStringSubmatch(strings.TrimSpace(sc.Text()))
		if m == nil {
			continue
		}
		v := strings.TrimSpace(m[2])
		if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
			uq, err := strconv.Unquote(v)
			if err != nil {
				uq = v[1 : len(v)-1]
			}
			v = uq
		}
		out[m[1]] = v
	}
	return out
}

// socketTLS maps Thunderbird's socketType / try_ssl to Caprock's tls string.
func socketTLS(v string) string {
	switch v {
	case "3":
		return "tls"
	case "2", "1":
		return "starttls"
	case "0":
		return "none"
	default:
		return "tls"
	}
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// readTBProfile adds every IMAP account in one profile to src, decrypting
// passwords from logins.json when key4.db has no primary password.
func readTBProfile(prof string, src *Source) {
	p := readPrefs(filepath.Join(prof, "prefs.js"))
	if p == nil {
		return
	}

	var used int64
	if st, err := os.Stat(filepath.Join(prof, "prefs.js")); err == nil {
		used = st.ModTime().UnixMilli() // Thunderbird rewrites prefs.js as it runs and on quit
	}
	key, keyErr := loadNSSKey(filepath.Join(prof, "key4.db"), "")
	logins := readLogins(filepath.Join(prof, "logins.json"))

	// Each mail.account.accountN pairs an incoming server with identities.
	for _, acctN := range listIndices(p, "mail.account.", ".server") {
		serverN := p["mail.account."+acctN+".server"]
		if p["mail.server."+serverN+".type"] != "imap" {
			continue // Caprock Mail is IMAP; skip POP and Local Folders.
		}
		ip := "mail.server." + serverN + "."
		a := Account{
			IMAPHost: p[ip+"hostname"],
			IMAPPort: atoi(p[ip+"port"]),
			IMAPTLS:  socketTLS(p[ip+"socketType"]),
			Username: p[ip+"userName"],
		}
		if a.IMAPHost == "" {
			continue
		}

		idN := firstField(p["mail.account."+acctN+".identities"])
		if idN != "" {
			a.Email = p["mail.identity."+idN+".useremail"]
			a.Name = p["mail.identity."+idN+".fullName"]
		}
		if a.Email == "" {
			a.Email = a.Username
		}
		if a.Username == "" {
			a.Username = a.Email
		}

		smtpN := ""
		if idN != "" {
			smtpN = p["mail.identity."+idN+".smtpServer"]
		}
		if smtpN == "" {
			smtpN = p["mail.smtp.defaultserver"]
		}
		if smtpN != "" {
			sp := "mail.smtpserver." + smtpN + "."
			a.SMTPHost = p[sp+"hostname"]
			a.SMTPPort = atoi(p[sp+"port"])
			a.SMTPTLS = socketTLS(p[sp+"try_ssl"])
		}

		if key != nil && keyErr == nil {
			if pw := logins.password(key, "imap://"+a.IMAPHost, a.Username); pw != "" {
				a.HasPassword = true
				src.creds[a.Email] = pw
			}
		}
		a.LastUsed = used
		src.Accounts = append(src.Accounts, a)
	}

	if errors.Is(keyErr, errPrimaryPassword) && src.Error == "" {
		src.Error = "a primary password is set; sign-in names imported, passwords must be typed"
	}
}

// listIndices returns the N in every key of the form prefix+N+suffix.
func listIndices(p map[string]string, prefix, suffix string) []string {
	seen := map[string]bool{}
	var out []string
	for k := range p {
		if strings.HasPrefix(k, prefix) && strings.HasSuffix(k, suffix) {
			n := strings.TrimSuffix(strings.TrimPrefix(k, prefix), suffix)
			if n != "" && !strings.Contains(n, ".") && !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	return out
}

// firstField returns the first comma-separated token, trimmed.
func firstField(s string) string {
	if s == "" {
		return ""
	}
	return strings.TrimSpace(strings.SplitN(s, ",", 2)[0])
}

// --- logins.json ------------------------------------------------------------

type loginsFile struct {
	Logins []struct {
		Hostname          string `json:"hostname"`
		EncryptedUsername string `json:"encryptedUsername"`
		EncryptedPassword string `json:"encryptedPassword"`
	} `json:"logins"`
}

func readLogins(path string) *loginsFile {
	b, err := os.ReadFile(path)
	if err != nil {
		return &loginsFile{}
	}
	var lf loginsFile
	if err := json.Unmarshal(b, &lf); err != nil {
		return &loginsFile{}
	}
	return &lf
}

// password finds the entry for host whose decrypted username matches username
// and returns its decrypted password. An empty username matches the first
// entry for the host.
func (lf *loginsFile) password(key *nssKey, host, username string) string {
	for _, l := range lf.Logins {
		if l.Hostname != host {
			continue
		}
		u, err := decodeAndDecrypt(key, l.EncryptedUsername)
		if err != nil {
			continue
		}
		if username != "" && !strings.EqualFold(u, username) {
			continue
		}
		pw, err := decodeAndDecrypt(key, l.EncryptedPassword)
		if err != nil {
			continue
		}
		return pw
	}
	return ""
}

func decodeAndDecrypt(key *nssKey, b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	return key.decrypt(raw)
}
