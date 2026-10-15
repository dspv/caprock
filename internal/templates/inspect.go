package templates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/gitremote"
)

// Inspection is what a template says about itself, read when the person
// adds one, so the form opens filled in.
type Inspection struct {
	GitHub     string `json:"github,omitempty"` // canonical owner/name (GitHub follows a renamed one)
	Folder     string `json:"folder,omitempty"`
	IsTemplate *bool  `json:"is_template,omitempty"`
	Visibility string `json:"visibility,omitempty"` // public | private | internal
	TemplateMD string `json:"template_md"`          // its TEMPLATE.md, at most 64 KiB; "" when it has none
	BriefPath  string `json:"brief_path"`
	BriefFrom  string `json:"brief_from"` // marker | mention | default
	Prompt     string `json:"prompt"`
	PromptFrom string `json:"prompt_from"` // marker | default
	// LocalFolder is a clone of the template already on this machine, in
	// the default folder: what the local path would copy.
	LocalFolder   string `json:"local_folder,omitempty"`
	SuggestedName string `json:"suggested_name"`
	Error         string `json:"error,omitempty"`
}

// maxDoc is how much of TEMPLATE.md or README.md is read; templateMDShown is
// how much of TEMPLATE.md is returned.
const (
	maxDoc          = 256 << 10
	templateMDShown = 64 << 10
	maxScan         = 2000 // folders looked at in the default folder for a local clone
)

// Inspect reads a template — exactly one of github (owner/name) or folder —
// and works out its defaults. defaultFolder is where a local clone is looked
// for and the suggested name is free ("" is the home folder). A GitHub
// template is read through the person's own gh on this click: `gh repo view`
// and the raw TEMPLATE.md and README; when gh cannot, Error says why and a
// local clone, if there is one, is read instead.
func (s *Service) Inspect(ctx context.Context, github, folder, defaultFolder string) (Inspection, error) {
	github, folder = strings.TrimSpace(github), strings.TrimSpace(folder)
	if (github == "") == (folder == "") {
		return Inspection{}, errors.New(`send {github: "owner/name"} or {folder: "/path"}`)
	}
	defaultFolder = defaultParent(defaultFolder)
	var res Inspection
	var templateMD, readme string
	if github != "" {
		if err := CheckGitHub(github); err != nil {
			return Inspection{}, err
		}
		res.GitHub = github
		res.LocalFolder = findLocalClone(defaultFolder, github)
		read := false
		if st := s.GH(ctx); !st.Installed || !st.LoggedIn {
			res.Error = st.Error
		} else if err := s.viewRepo(ctx, &res); err != nil {
			res.Error = err.Error()
		} else {
			if res.LocalFolder == "" && !strings.EqualFold(res.GitHub, github) {
				res.LocalFolder = findLocalClone(defaultFolder, res.GitHub)
			}
			templateMD, _ = s.rawFile(ctx, res.GitHub, "contents/TEMPLATE.md")
			readme, _ = s.rawFile(ctx, res.GitHub, "readme")
			read = true
		}
		if !read && res.LocalFolder != "" {
			templateMD, readme = readDoc(res.LocalFolder, "TEMPLATE.md"), readDoc(res.LocalFolder, "README.md")
		}
		_, name, _ := strings.Cut(res.GitHub, "/")
		res.SuggestedName = suggestName(defaultFolder, name)
	} else {
		f, err := checkFolder(folder, true)
		if err != nil {
			return Inspection{}, err
		}
		res.Folder = f
		templateMD, readme = readDoc(f, "TEMPLATE.md"), readDoc(f, "README.md")
		if gh := githubOf(f); gh != "" {
			res.GitHub = gh
		}
		res.SuggestedName = suggestName(defaultFolder, filepath.Base(f))
	}
	res.BriefPath, res.BriefFrom, res.Prompt, res.PromptFrom = Defaults(templateMD, readme)
	res.TemplateMD = cutUTF8(templateMD, templateMDShown)
	return res, nil
}

// viewRepo asks GitHub, through gh, whether the repository is a template and
// what it is called now.
func (s *Service) viewRepo(ctx context.Context, res *Inspection) error {
	out, err := s.gh(ctx, 20*time.Second, "repo", "view", res.GitHub, "--json", "isTemplate,visibility,nameWithOwner")
	if err != nil {
		return fmt.Errorf("gh could not read %s: %w", res.GitHub, err)
	}
	var v struct {
		IsTemplate    bool   `json:"isTemplate"`
		Visibility    string `json:"visibility"`
		NameWithOwner string `json:"nameWithOwner"`
	}
	if err := json.Unmarshal(out, &v); err != nil {
		return fmt.Errorf("gh answered something unexpected for %s", res.GitHub)
	}
	if CheckGitHub(v.NameWithOwner) == nil {
		res.GitHub = v.NameWithOwner
	}
	res.IsTemplate = &v.IsTemplate
	res.Visibility = strings.ToLower(v.Visibility)
	return nil
}

// rawFile reads a file of the repository through `gh api`, raw; "" when
// there is none.
func (s *Service) rawFile(ctx context.Context, repo, path string) (string, error) {
	out, err := s.gh(ctx, 20*time.Second, "api", "-H", "Accept: application/vnd.github.raw+json", "repos/"+repo+"/"+path)
	if err != nil {
		return "", err
	}
	if len(out) > maxDoc {
		out = out[:maxDoc]
	}
	return textOf(out), nil
}

// readDoc reads dir/name when it is a regular file; "" otherwise.
func readDoc(dir, name string) string {
	p := filepath.Join(dir, name)
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return ""
	}
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, maxDoc))
	return textOf(b)
}

// textOf is b as text, or "" when it is not UTF-8 or holds a NUL. A file
// read up to the cap may end inside a rune; that rune is dropped.
func textOf(b []byte) string {
	if len(b) >= maxDoc {
		b = []byte(cutUTF8(string(b), maxDoc-utf8.UTFMax))
	}
	if !utf8.Valid(b) || strings.ContainsRune(string(b), 0) {
		return ""
	}
	return string(b)
}

// cutUTF8 is s cut to at most n bytes on a rune boundary.
func cutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// githubOf is owner/name of the repository at dir when its origin is on
// github.com, read from .git/config (nothing is run).
func githubOf(dir string) string {
	web, ok := gitremote.WebURL(readOrigin(dir))
	if !ok {
		return ""
	}
	rest, ok := strings.CutPrefix(strings.ToLower(web), "https://github.com/")
	if !ok {
		return ""
	}
	repo := web[len(web)-len(rest):]
	if CheckGitHub(repo) != nil {
		return ""
	}
	return repo
}

// readOrigin is origin's url (else the first remote's) in dir/.git/config.
func readOrigin(dir string) string {
	f, err := os.Open(filepath.Join(dir, ".git", "config"))
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, 64<<10))
	section, first, origin := "", "", ""
	for _, raw := range strings.Split(string(b), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(line, "[] ")
			continue
		}
		if !strings.HasPrefix(section, "remote ") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != "url" {
			continue
		}
		v = strings.TrimSpace(v)
		if first == "" {
			first = v
		}
		if section == `remote "origin"` && origin == "" {
			origin = v
		}
	}
	if origin != "" {
		return origin
	}
	return first
}

// findLocalClone is a repository directly in parent whose origin is
// github.com/<repo>, by reading each one's .git/config; "" when none is.
func findLocalClone(parent, repo string) string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return ""
	}
	if len(entries) > maxScan {
		entries = entries[:maxScan]
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(parent, e.Name())
		if strings.EqualFold(githubOf(dir), repo) {
			return dir
		}
	}
	return ""
}

// defaultParent is the default folder, ~ expanded; the home folder when
// unset.
func defaultParent(f string) string {
	f = strings.TrimSpace(f)
	if f == "" {
		f = "~"
	}
	if f == "~" || strings.HasPrefix(f, "~/") || strings.HasPrefix(f, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		f = filepath.Join(home, f[1:])
	}
	return f
}

// suggestName is new-<base>, with a number when that is taken in parent.
func suggestName(parent, base string) string {
	base = strings.Trim(strings.Map(func(r rune) rune {
		if r < 0x80 && validName.MatchString(string(r)) {
			return r
		}
		return '-'
	}, base), ".-")
	if base == "" {
		base = "project"
	}
	if len(base) > 80 {
		base = base[:80]
	}
	name := "new-" + base
	for i := 2; i < 100; i++ {
		if _, err := os.Lstat(filepath.Join(parent, name)); errors.Is(err, os.ErrNotExist) || parent == "" {
			return name
		}
		name = "new-" + base + "-" + strconv.Itoa(i)
	}
	return name
}
