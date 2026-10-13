// Package secrets keeps account passwords out of the database: in the OS
// keychain (macOS login keychain, Windows Credential Manager, Secret
// Service), else a file only this user can read.
package secrets

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/zalando/go-keyring"

	"github.com/dspv/caprock/internal/secret"
)

const service = "dev.caprock.mail"

// ErrNotFound is returned when no secret is stored for an account.
var ErrNotFound = errors.New("secret not found")

// Store keeps one secret per account.
type Store interface {
	Get(accountID int64) (string, error)
	Set(accountID int64, secret string) error
	Delete(accountID int64) error
}

// Keychain is the OS keychain through go-keyring: Windows Credential Manager
// and Secret Service. Not used on macOS, where go-keyring runs `security`
// without naming the keychain file (ADR-039's dialog risk); MacKeychain is.
type Keychain struct{}

func key(id int64) string { return "account-" + strconv.FormatInt(id, 10) }

// Get reads a secret.
func (Keychain) Get(id int64) (string, error) {
	s, err := keyring.Get(service, key(id))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return s, err
}

// Set writes a secret.
func (Keychain) Set(id int64, secret string) error { return keyring.Set(service, key(id), secret) }

// Delete removes a secret; a missing one is not an error.
func (Keychain) Delete(id int64) error {
	err := keyring.Delete(service, key(id))
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}

// MacKeychain keeps each password as a generic password in the user's login
// keychain through internal/secret, which names the keychain file on every
// call, so no call can open a dialog. Items keep go-keyring's service and
// account, so a password saved by an earlier build is found.
type MacKeychain struct {
	Path string        // the login keychain file
	Run  secret.Runner // nil runs /usr/bin/security; tests replace it
}

// goKeyringPrefix marks a value go-keyring stored base64-encoded.
const goKeyringPrefix = "go-keyring-base64:"

func (k MacKeychain) item(id int64) secret.Keychain {
	return secret.Keychain{Service: service, Account: key(id), Label: "Caprock Mail password", Path: k.Path, Run: k.Run}
}

// Get reads a secret, decoding one go-keyring wrote.
func (k MacKeychain) Get(id int64) (string, error) {
	s, err := k.item(id).Get(context.Background())
	if err != nil {
		return "", err
	}
	if s == "" {
		return "", ErrNotFound
	}
	if b64, ok := strings.CutPrefix(s, goKeyringPrefix); ok {
		b, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	return s, nil
}

// Set writes a secret.
func (k MacKeychain) Set(id int64, v string) error { return k.item(id).Set(context.Background(), v) }

// Delete removes a secret; a missing one is not an error.
func (k MacKeychain) Delete(id int64) error { return k.item(id).Delete(context.Background()) }

// Default is where Mail keeps passwords: on macOS the login keychain when its
// file exists, elsewhere the OS keychain, with the 0600 file behind either;
// only the file when CAPROCK_SECRET_STORE=file or there is no login keychain.
// Nothing runs until the first password is read or written: an unused Mail
// starts no process.
func Default(dataDir string) Store {
	return &lazy{make: func() Store {
		file := &File{Path: filepath.Join(dataDir, "mail-secrets.json")}
		if os.Getenv(secret.EnvStore) == "file" {
			return file
		}
		if runtime.GOOS != "darwin" {
			return Fallback{Primary: Keychain{}, File: file}
		}
		home := secret.UserHome(context.Background())
		if home == "" {
			return file
		}
		kc := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
		if st, err := os.Stat(kc); err != nil || st.IsDir() {
			return file
		}
		return Fallback{Primary: MacKeychain{Path: kc}, File: file}
	}}
}

// lazy builds its store on first use.
type lazy struct {
	once sync.Once
	make func() Store
	s    Store
}

func (l *lazy) get() Store {
	l.once.Do(func() { l.s = l.make() })
	return l.s
}

func (l *lazy) Get(id int64) (string, error) { return l.get().Get(id) }
func (l *lazy) Set(id int64, v string) error { return l.get().Set(id, v) }
func (l *lazy) Delete(id int64) error        { return l.get().Delete(id) }

// Memory is an in-process store for tests and previews; it never touches the OS.
type Memory struct {
	mu sync.Mutex
	m  map[int64]string
}

// Get reads a secret.
func (m *Memory) Get(id int64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.m[id]
	if !ok {
		return "", ErrNotFound
	}
	return s, nil
}

// Set writes a secret.
func (m *Memory) Set(id int64, secret string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.m == nil {
		m.m = map[int64]string{}
	}
	m.m[id] = secret
	return nil
}

// Delete removes a secret.
func (m *Memory) Delete(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, id)
	return nil
}

// Fallback keeps secrets in the OS keychain and, where there is none (a Linux
// box without a Secret Service), in a file only this user can read.
type Fallback struct {
	Primary Store
	File    *File
}

// Get reads from the keychain, then the file.
func (f Fallback) Get(id int64) (string, error) {
	s, err := f.Primary.Get(id)
	if err == nil {
		return s, nil
	}
	if fs, ferr := f.File.Get(id); ferr == nil {
		return fs, nil
	}
	if errors.Is(err, ErrNotFound) {
		return "", ErrNotFound
	}
	return "", err
}

// Set writes to the keychain, or to the file when the keychain refuses.
func (f Fallback) Set(id int64, secret string) error {
	if err := f.Primary.Set(id, secret); err == nil {
		_ = f.File.Delete(id)
		return nil
	}
	return f.File.Set(id, secret)
}

// Delete removes from both.
func (f Fallback) Delete(id int64) error {
	_ = f.File.Delete(id)
	return f.Primary.Delete(id)
}

// File is a JSON map of secrets in a 0600 file.
type File struct {
	Path string
	mu   sync.Mutex
}

func (f *File) load() (map[string]string, error) {
	m := map[string]string{}
	b, err := os.ReadFile(f.Path)
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return nil, err
	}
	return m, json.Unmarshal(b, &m)
}

func (f *File) save(m map[string]string) error {
	b, _ := json.Marshal(m)
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}

// Get reads a secret.
func (f *File) Get(id int64) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return "", err
	}
	s, ok := m[key(id)]
	if !ok {
		return "", ErrNotFound
	}
	return s, nil
}

// Set writes a secret.
func (f *File) Set(id int64, secret string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	m[key(id)] = secret
	return f.save(m)
}

// Delete removes a secret.
func (f *File) Delete(id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, err := f.load()
	if err != nil {
		return err
	}
	if _, ok := m[key(id)]; !ok {
		return nil
	}
	delete(m, key(id))
	return f.save(m)
}
