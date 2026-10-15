// Package templates starts a project from a template (ADR-065): a GitHub
// template repository the person names, or a folder on this machine, copied
// into a new repository with the person's brief written into it, ready for
// an agent. The templates are the person's own list, empty until they add
// one; nothing is built in.
//
// GitHub is reached only through the person's own `gh`, on a click: Caprock
// never reads or keeps the gh token, and never deletes a repository it made.
// Without a ready gh the local path copies the template folder instead; the
// daemon never picks the other path on its own.
package templates

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/agents"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/projects"
)

// StateFile is the templates list's name in the data directory.
const StateFile = "project-templates.json"

// Limits on the list and on one template.
const (
	MaxTemplates  = 50
	MaxNameRunes  = 80
	MaxPrompt     = 8 << 10
	MaxBriefPath  = 256
	MaxFolderPath = 4096
)

// Template is one way to start a project.
type Template struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	GitHub    string `json:"github,omitempty"` // owner/name of a template repository
	Folder    string `json:"folder,omitempty"` // a folder on this machine
	BriefPath string `json:"brief_path"`       // where the brief is written, relative, forward slashes
	Prompt    string `json:"prompt"`           // the first prompt; {brief} is the brief's path
	Agent     string `json:"agent,omitempty"`
	CreatedAt int64  `json:"created_at"`
	UsedAt    int64  `json:"used_at,omitempty"`
}

// Input is a template as a client sends it: every field optional, so a PATCH
// changes only what it names. "" clears github, folder and agent.
type Input struct {
	Name      *string `json:"name,omitempty"`
	GitHub    *string `json:"github,omitempty"`
	Folder    *string `json:"folder,omitempty"`
	BriefPath *string `json:"brief_path,omitempty"`
	Prompt    *string `json:"prompt,omitempty"`
	Agent     *string `json:"agent,omitempty"`
}

// ErrNotFound is an id that names no template.
var ErrNotFound = errors.New("no such template")

// ErrFull is a list already holding MaxTemplates.
var ErrFull = fmt.Errorf("you have %d templates; remove one first", MaxTemplates)

// githubRepo is owner/name as GitHub allows them.
var githubRepo = regexp.MustCompile(`^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`)

// CheckGitHub accepts owner/name.
func CheckGitHub(s string) error {
	if !githubRepo.MatchString(s) {
		return fmt.Errorf("%q is not a GitHub repository; write it as owner/name", s)
	}
	if _, name, _ := strings.Cut(s, "/"); name == "." || name == ".." {
		return fmt.Errorf("%q is not a GitHub repository; write it as owner/name", s)
	}
	return nil
}

// variable is a {word} in a prompt; {brief} is the only one there is.
var variable = regexp.MustCompile(`\{[A-Za-z_][A-Za-z0-9_]*\}`)

// CheckPrompt accepts a first prompt: some text, at most MaxPrompt bytes, no
// NUL, and no variable but {brief}.
func CheckPrompt(p string) error {
	if strings.TrimSpace(p) == "" {
		return errors.New("write the first prompt")
	}
	if len(p) > MaxPrompt {
		return fmt.Errorf("the prompt is longer than %d bytes", MaxPrompt)
	}
	if !utf8.ValidString(p) || strings.ContainsRune(p, 0) {
		return errors.New("the prompt is not plain text")
	}
	for _, v := range variable.FindAllString(p, -1) {
		if v != "{brief}" {
			return fmt.Errorf("%s is not a variable; {brief} is the only one", v)
		}
	}
	return nil
}

// reservedName is a name Windows keeps for a device, with or without an
// extension: a file called CON cannot be made there.
var reservedName = regexp.MustCompile(`(?i)^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$`)

// driveLetter is a Windows drive at the start of a path.
var driveLetter = regexp.MustCompile(`^[A-Za-z]:`)

// CheckBriefPath accepts where a brief may be written in a new project: a
// relative path with forward slashes, inside the project, not into .git, each
// segment a name every OS can make.
func CheckBriefPath(p string) error {
	bad := func(why string) error { return fmt.Errorf("brief_path %q: %s", p, why) }
	switch {
	case p == "":
		return errors.New("brief_path is empty")
	case len(p) > MaxBriefPath:
		return bad(fmt.Sprintf("longer than %d bytes", MaxBriefPath))
	case !utf8.ValidString(p):
		return bad("not UTF-8")
	case strings.Contains(p, `\`):
		return bad("use forward slashes")
	case strings.HasPrefix(p, "/"):
		return bad("must be relative to the project")
	case driveLetter.MatchString(p):
		return bad("must be relative to the project")
	}
	for _, seg := range strings.Split(p, "/") {
		switch {
		case seg == "":
			return bad("has an empty segment")
		case seg == "." || seg == "..":
			return bad("must stay inside the project")
		case strings.EqualFold(seg, ".git"):
			return bad("may not be written into .git")
		case strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " "):
			return bad("a name may not end in a dot or a space")
		case reservedName.MatchString(seg):
			return bad(seg + " is a device name on Windows")
		}
		if err := projects.CheckFolderName(seg); err != nil {
			return bad(err.Error())
		}
	}
	return nil
}

// checkName accepts a template's name.
func checkName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if n == "" {
		return "", errors.New("name the template")
	}
	if utf8.RuneCountInString(n) > MaxNameRunes {
		return "", fmt.Errorf("the name is longer than %d characters", MaxNameRunes)
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("the name has a control character")
		}
	}
	return n, nil
}

// checkFolder accepts a template folder: an absolute path, and with stat a
// folder that exists. A leading ~ is the home folder. The cleaned path is
// returned.
func checkFolder(f string, stat bool) (string, error) {
	f = projects.ExpandHome(strings.TrimSpace(f))
	if len(f) > MaxFolderPath || !filepath.IsAbs(f) || strings.ContainsRune(f, 0) {
		return "", fmt.Errorf("%q is not an absolute path", f)
	}
	f = filepath.Clean(f)
	if !stat {
		return f, nil
	}
	if st, err := os.Stat(f); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a folder", f)
	}
	return f, nil
}

// Check validates a whole template and returns it normalised.
func Check(t Template) (Template, error) { return check(t, true) }

// check is Check; without stat a folder need not exist (one read back from
// the file may have been moved since, which is said when it is used).
func check(t Template, stat bool) (Template, error) {
	var err error
	if t.Name, err = checkName(t.Name); err != nil {
		return t, err
	}
	t.GitHub = strings.TrimSpace(t.GitHub)
	t.Folder = strings.TrimSpace(t.Folder)
	if t.GitHub == "" && t.Folder == "" {
		return t, errors.New("a template is a GitHub repository (owner/name), a folder, or both")
	}
	if t.GitHub != "" {
		if err := CheckGitHub(t.GitHub); err != nil {
			return t, err
		}
	}
	if t.Folder != "" {
		if t.Folder, err = checkFolder(t.Folder, stat); err != nil {
			return t, err
		}
	}
	if err := CheckBriefPath(t.BriefPath); err != nil {
		return t, err
	}
	if err := CheckPrompt(t.Prompt); err != nil {
		return t, err
	}
	if t.Agent != "" && !agents.IsSpawnable(t.Agent) {
		return t, fmt.Errorf("caprock cannot start %q sessions", t.Agent)
	}
	return t, nil
}

// Store is the person's templates, kept in one JSON file.
type Store struct {
	// File is where the list is kept; "" keeps it in memory (tests).
	File string
	Log  *slog.Logger
	Now  func() time.Time

	mu     sync.Mutex
	loaded bool
	list   []Template
}

// fileShape is the file's content.
type fileShape struct {
	Templates []Template `json:"templates"`
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Store) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// loadLocked reads the file once. A file that is not the list is set aside
// as <file>.bad-<unix ms> and the list starts empty, so one bad write never
// stops the feature; an entry that no longer passes Check is dropped.
func (s *Store) loadLocked() {
	if s.loaded {
		return
	}
	s.loaded = true
	if s.File == "" {
		return
	}
	b, err := os.ReadFile(s.File)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.log().Warn("could not read the project templates", "component", "templates", "err", err)
		}
		return
	}
	var f fileShape
	if err := json.Unmarshal(b, &f); err != nil {
		bad := fmt.Sprintf("%s.bad-%d", s.File, s.now().UnixMilli())
		if rerr := os.Rename(s.File, bad); rerr != nil {
			s.log().Warn("the project templates file is not readable and could not be set aside", "component", "templates", "file", s.File, "err", err, "rename_err", rerr)
		} else {
			s.log().Warn("the project templates file was not readable; set aside, starting empty", "component", "templates", "file", bad, "err", err)
		}
		return
	}
	for _, t := range f.Templates {
		if !validID.MatchString(t.ID) {
			continue
		}
		checked, err := check(t, false)
		if err != nil {
			s.log().Warn("dropped a project template that is no longer valid", "component", "templates", "id", t.ID, "err", err)
			continue
		}
		s.list = append(s.list, checked)
		if len(s.list) == MaxTemplates {
			break
		}
	}
}

// saveLocked writes the list atomically.
func (s *Store) saveLocked() error {
	if s.File == "" {
		return nil
	}
	b, err := json.MarshalIndent(fileShape{Templates: s.list}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.File), 0o700); err != nil {
		return err
	}
	if err := config.WriteFileAtomic(s.File, b, 0o600); err != nil {
		s.log().Warn("could not save the project templates", "component", "templates", "err", err)
		return errors.New("could not save the templates")
	}
	return nil
}

// List is every template, in the order they were added.
func (s *Store) List() []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	out := make([]Template, len(s.list))
	copy(out, s.list)
	return out
}

// Get is one template.
func (s *Store) Get(id string) (Template, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	for _, t := range s.list {
		if t.ID == id {
			return t, true
		}
	}
	return Template{}, false
}

var validID = regexp.MustCompile(`^[0-9a-f]{8}$`)

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func apply(t *Template, in Input) {
	if in.Name != nil {
		t.Name = *in.Name
	}
	if in.GitHub != nil {
		t.GitHub = *in.GitHub
	}
	if in.Folder != nil {
		t.Folder = *in.Folder
	}
	if in.BriefPath != nil {
		t.BriefPath = *in.BriefPath
	}
	if in.Prompt != nil {
		t.Prompt = *in.Prompt
	}
	if in.Agent != nil {
		t.Agent = *in.Agent
	}
}

// Add adds a template.
func (s *Store) Add(in Input) (Template, error) {
	var t Template
	apply(&t, in)
	t, err := Check(t)
	if err != nil {
		return Template{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	if len(s.list) >= MaxTemplates {
		return Template{}, ErrFull
	}
	t.ID = newID()
	for s.indexLocked(t.ID) >= 0 {
		t.ID = newID()
	}
	t.CreatedAt = s.now().UnixMilli()
	s.list = append(s.list, t)
	if err := s.saveLocked(); err != nil {
		s.list = s.list[:len(s.list)-1]
		return Template{}, err
	}
	return t, nil
}

func (s *Store) indexLocked(id string) int {
	for i, t := range s.list {
		if t.ID == id {
			return i
		}
	}
	return -1
}

// Update changes what in names.
func (s *Store) Update(id string, in Input) (Template, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	i := s.indexLocked(id)
	if i < 0 {
		return Template{}, ErrNotFound
	}
	t := s.list[i]
	apply(&t, in)
	t, err := Check(t)
	if err != nil {
		return Template{}, err
	}
	old := s.list[i]
	s.list[i] = t
	if err := s.saveLocked(); err != nil {
		s.list[i] = old
		return Template{}, err
	}
	return t, nil
}

// Delete removes a template from the list; nothing on disk or on GitHub is
// touched.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	i := s.indexLocked(id)
	if i < 0 {
		return ErrNotFound
	}
	old := append([]Template(nil), s.list...)
	s.list = append(s.list[:i], s.list[i+1:]...)
	if err := s.saveLocked(); err != nil {
		s.list = old
		return err
	}
	return nil
}

// MarkUsed stamps used_at on the template called name, if there is one.
func (s *Store) MarkUsed(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadLocked()
	for i := range s.list {
		if s.list[i].Name == name {
			s.list[i].UsedAt = s.now().UnixMilli()
			_ = s.saveLocked()
			return
		}
	}
}
