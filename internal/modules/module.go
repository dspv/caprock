package modules

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ManifestFile names a module and sits at the top of its folder, beside the
// Entry page the screen hosts.
const (
	ManifestFile = "module.json"
	Entry        = "index.html"
)

// Install limits: a module is a screen's static files, not a data set.
const (
	maxFiles = 5000
	maxBytes = 256 << 20
)

// Manifest is module.json.
type Manifest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

var idRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// ValidID reports whether id can name a module: lower-case letters, digits
// and dashes, a letter first, at most 32. It is a path segment in a URL and a
// folder name, so nothing that could mean anything else is allowed.
func ValidID(id string) bool { return idRe.MatchString(id) }

// Root is where installed modules live inside Caprock's data directory.
func Root(dataDir string) string { return filepath.Join(dataDir, "modules") }

// ReadManifest reads and checks the module in dir.
func ReadManifest(dir string) (Manifest, error) {
	b, err := os.ReadFile(filepath.Join(dir, ManifestFile))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Manifest{}, fmt.Errorf("%s has no %s", dir, ManifestFile)
		}
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, fmt.Errorf("%s is not readable: %w", ManifestFile, err)
	}
	m.Name = strings.TrimSpace(m.Name)
	if !ValidID(m.ID) {
		return Manifest{}, fmt.Errorf("%s: id %q is not valid (lower-case letters, digits and dashes, a letter first, at most 32)", ManifestFile, m.ID)
	}
	if m.Name == "" || len(m.Name) > 40 {
		return Manifest{}, fmt.Errorf("%s: name must be 1 to 40 characters", ManifestFile)
	}
	if st, err := os.Stat(filepath.Join(dir, Entry)); err != nil || !st.Mode().IsRegular() {
		return Manifest{}, fmt.Errorf("%s has no %s", dir, Entry)
	}
	return m, nil
}

// Installed returns the modules installed under root, by id. A folder whose
// manifest is missing, unreadable or names another id is not a module.
func Installed(root string) []Manifest {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Manifest
	for _, e := range entries {
		if !e.IsDir() || !ValidID(e.Name()) {
			continue
		}
		m, err := ReadManifest(filepath.Join(root, e.Name()))
		if err != nil || m.ID != e.Name() {
			continue
		}
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Find returns the installed module id, if it is installed.
func Find(root, id string) (Manifest, string, bool) {
	if !ValidID(id) {
		return Manifest{}, "", false
	}
	dir := filepath.Join(root, id)
	m, err := ReadManifest(dir)
	if err != nil || m.ID != id {
		return Manifest{}, "", false
	}
	return m, dir, true
}

// Install copies the built module in src into root/<id>, replacing an older
// copy whole. The key must name the module: it decides who may install one.
// Only regular files and folders are copied; a link is refused, so nothing
// outside the module's folder is ever served as part of it.
func Install(src, root string, g Grant) (Manifest, error) {
	m, err := ReadManifest(src)
	if err != nil {
		return Manifest{}, err
	}
	if !g.Allows(m.ID) {
		return Manifest{}, fmt.Errorf("the admin key does not name module %q", m.ID)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Manifest{}, err
	}
	tmp := filepath.Join(root, "."+m.ID+".new-"+suffix())
	if err := copyTree(src, tmp); err != nil {
		_ = os.RemoveAll(tmp)
		return Manifest{}, err
	}
	dst := filepath.Join(root, m.ID)
	old := filepath.Join(root, "."+m.ID+".old-"+suffix())
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			_ = os.RemoveAll(tmp)
			return Manifest{}, err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Rename(old, dst)
		_ = os.RemoveAll(tmp)
		return Manifest{}, err
	}
	_ = os.RemoveAll(old)
	return m, nil
}

// Remove deletes an installed module's files. Its documents stay in the
// database, so installing it again finds them.
func Remove(root, id string) error {
	if !ValidID(id) {
		return fmt.Errorf("%q is not a module id", id)
	}
	dir := filepath.Join(root, id)
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("module %q is not installed", id)
	}
	return os.RemoveAll(dir)
}

func copyTree(src, dst string) error {
	files, total := 0, int64(0)
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o700)
		case d.Type().IsRegular():
		default:
			return fmt.Errorf("%s is not a regular file; a module is copied without links", rel)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files++
		total += info.Size()
		if files > maxFiles || total > maxBytes {
			return fmt.Errorf("the module is larger than %d files or %d MB", maxFiles, maxBytes>>20)
		}
		return copyFile(p, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func suffix() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
