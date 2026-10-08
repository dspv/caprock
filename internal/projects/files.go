package projects

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/store"
	"github.com/dspv/caprock/internal/tcc"
)

// Files: read one file of a project, and list the files there are, for the
// app's read-only file tab (.ai/03-contracts.md § Files). Nothing here
// writes, and nothing outside the project's folder (or the worktree's) is
// read: the path is cleaned, symlinks are followed, and what they land on
// must still be inside.

const (
	// MaxFileBytes is how much of a file is returned; past it, truncated.
	MaxFileBytes = 1 << 20
	// MaxListedFiles caps the file list the palette filters.
	MaxListedFiles = 20000
)

// FileContent is one file, as the file tab shows it.
type FileContent struct {
	Path string `json:"path"`
	// Size is the whole file's, even when only the first MaxFileBytes come.
	Size      int64  `json:"size"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
	// Binary: NUL bytes or invalid UTF-8; Text is then empty.
	Binary bool   `json:"binary,omitempty"`
	Lang   string `json:"lang"`
}

// FileList is the files of a worktree, relative and in slash form.
type FileList struct {
	Files     []string `json:"files"`
	Truncated bool     `json:"truncated,omitempty"`
}

// The refusals of a file read, apart from an unknown project or worktree.
var (
	// ErrFileEscape is a path whose real location is outside the folder.
	ErrFileEscape = errors.New("that path leads outside the project")
	// ErrNotRegular is a folder, a device, a socket or a pipe.
	ErrNotRegular = errors.New("not a regular file")
	// ErrNoFile is a path that does not exist.
	ErrNoFile = errors.New("no such file")
)

// folderPath is the folder a file path is read against: the project's root
// for the main checkout (a plain folder project included), else the linked
// worktree's.
func (s *Service) folderPath(ctx context.Context, id int64, worktree string) (string, error) {
	if worktree != "" {
		return s.WorktreePath(ctx, id, worktree)
	}
	p, err := store.GetProject(ctx, s.Store.DB(), id)
	if err != nil {
		return "", err
	}
	return filepath.FromSlash(p.Root), nil
}

// ReadFile reads rel, a clean relative path, inside a project's folder.
func (s *Service) ReadFile(ctx context.Context, id int64, worktree, rel string) (FileContent, error) {
	if err := checkRelPath(rel); err != nil {
		return FileContent{}, err
	}
	dir, err := s.folderPath(ctx, id, worktree)
	if err != nil {
		return FileContent{}, err
	}
	if err := tcc.Check(dir); err != nil {
		return FileContent{}, err
	}
	real, err := resolveInside(dir, rel)
	if err != nil {
		return FileContent{}, err
	}
	return readCapped(real, rel)
}

// resolveInside is rel under dir with every symlink followed, refused when
// the result is not inside dir's own real location.
func resolveInside(dir, rel string) (string, error) {
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", ErrNoFile
	}
	real, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// A dangling link and a missing file read the same; neither says
			// where the link pointed.
			return "", ErrNoFile
		}
		return "", err
	}
	back, err := filepath.Rel(root, real)
	if err != nil || !filepath.IsLocal(back) {
		return "", ErrFileEscape
	}
	return real, nil
}

// readCapped reads the first MaxFileBytes of a regular file. Stat comes
// before open: opening a FIFO for reading would wait for a writer.
func readCapped(real, rel string) (FileContent, error) {
	fi, err := os.Stat(real)
	if err != nil {
		return FileContent{}, ErrNoFile
	}
	if !fi.Mode().IsRegular() {
		return FileContent{}, ErrNotRegular
	}
	f, err := os.Open(real) //nolint:gosec // resolved inside the project above
	if err != nil {
		return FileContent{}, err
	}
	defer func() { _ = f.Close() }()
	buf, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return FileContent{}, err
	}
	out := FileContent{Path: rel, Size: fi.Size(), Lang: LangOf(rel)}
	if len(buf) > MaxFileBytes {
		buf = cutText(buf[:MaxFileBytes])
		out.Truncated = true
	}
	if bytes.IndexByte(buf, 0) >= 0 || !utf8.Valid(buf) {
		out.Binary = true
		return out, nil
	}
	out.Text = string(buf)
	return out, nil
}

// cutText ends a cut on the last line break, or failing one on a whole
// UTF-8 character, so the cut never makes text look like a binary.
func cutText(b []byte) []byte {
	if i := bytes.LastIndexByte(b, '\n'); i >= 0 && len(b)-i <= 4096 {
		return b[:i+1]
	}
	i := len(b) - 1
	for i > 0 && !utf8.RuneStart(b[i]) && len(b)-i < utf8.UTFMax {
		i--
	}
	if i >= 0 && !utf8.FullRune(b[i:]) {
		return b[:i]
	}
	return b
}

// ListFiles is the worktree's files: git's tracked and untracked-but-not-
// ignored files in a repository, a walk that skips dot-folders and
// node_modules in a plain folder. At most MaxListedFiles.
func (s *Service) ListFiles(ctx context.Context, id int64, worktree string) (FileList, error) {
	dir, err := s.folderPath(ctx, id, worktree)
	if err != nil {
		return FileList{}, err
	}
	if err := tcc.Check(dir); err != nil {
		return FileList{}, err
	}
	var files []string
	if _, ok := findGitDirs(dir); ok {
		run, err := s.gitCmd(ctx, readOpts, dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
		if err != nil {
			return FileList{}, err
		}
		seen := map[string]bool{}
		for _, p := range strings.Split(string(run.out), "\x00") {
			if p != "" && !seen[p] {
				seen[p] = true
				files = append(files, p)
			}
		}
	} else {
		files = walkFiles(dir, MaxListedFiles+1)
	}
	sort.Strings(files)
	out := FileList{Files: files}
	if len(files) > MaxListedFiles {
		out.Files = files[:MaxListedFiles]
		out.Truncated = true
	}
	if out.Files == nil {
		out.Files = []string{}
	}
	return out, nil
}

// walkFiles lists up to max regular files under dir, never following a
// symlinked folder.
func walkFiles(dir string, max int) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable entry is left out; the rest of the walk goes on.
			return nil //nolint:nilerr // skipping is the intent
		}
		if d.IsDir() {
			name := d.Name()
			if p != dir && (strings.HasPrefix(name, ".") || name == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if rel, err := filepath.Rel(dir, p); err == nil {
			out = append(out, filepath.ToSlash(rel))
		}
		if len(out) >= max {
			return filepath.SkipAll
		}
		return nil
	})
	return out
}

// langs maps a file extension to the name the file tab goes by. Only
// markdown changes how a file is drawn; the rest name it.
var langs = map[string]string{
	".md": "markdown", ".mdx": "markdown", ".markdown": "markdown",
	".go": "go", ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
	".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust", ".rb": "ruby",
	".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c", ".h": "c", ".cc": "cpp",
	".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".php": "php", ".sh": "shell", ".bash": "shell",
	".zsh": "shell", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
	".xml": "xml", ".html": "html", ".css": "css", ".scss": "css", ".sql": "sql",
	".txt": "text",
}

// LangOf names a file's language by its extension; "text" when unknown.
func LangOf(path string) string {
	base := strings.ToLower(filepath.Base(filepath.FromSlash(path)))
	switch base {
	case "makefile":
		return "makefile"
	case "dockerfile":
		return "dockerfile"
	}
	if l, ok := langs[filepath.Ext(base)]; ok {
		return l
	}
	return "text"
}
