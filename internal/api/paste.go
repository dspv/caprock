package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/config"
)

// pasteLimit caps a pasted file. Ten megabytes is far past any screenshot and
// well short of anything that would fill a disk by accident.
const pasteLimit = 10 << 20

// pasteNameMax caps the stem of a stored file name, in bytes. The name is
// pure ASCII by then, so bytes are characters. Long enough for any name a
// person gives a document; short enough that the full path stays well inside
// Windows' 260-character limit under a deep data directory.
const pasteNameMax = 80

// pasteKinds is what may be written, keyed by lowercase file extension and
// grouped only so the refusal can say what is accepted.
//
// An allow-list rather than a sanitiser: this endpoint writes a file to disk on
// the say-so of a web page, so the safe design names what is permitted rather
// than guessing what is dangerous. The extension a file is stored under always
// comes from this table, never from the request, so a name cannot smuggle in
// an executable suffix.
//
// It is keyed by extension and not only by MIME type because a browser leaves
// `File.type` empty for most of what people actually drop: Markdown, CSV,
// JSON, YAML, logs and every source file arrive typeless, and a MIME-only
// table refused all of them (the owner's report, 2026-10-04).
//
// Every file is written 0600 and nothing is ever executed or opened by
// Caprock; Claude Code reads it by path. Shell scripts (`.sh`) are accepted
// on that basis: they are text, and a 0600 file is not executable on macOS or
// Linux, while Windows does not run `.sh` by association. What Windows *does*
// run by association whatever the mode bits — `.exe`, `.bat`, `.cmd`, `.ps1`,
// `.vbs`, `.msi`, `.lnk`, `.hta`, `.scr` — is absent and stays absent. `.js`
// is the one entry Windows Script Host also claims; it is here because it is
// the commonest source file there is, and the file is the user's own, dropped
// by them, into a directory Caprock owns.
var pasteKinds = []struct {
	label string
	exts  []string
}{
	{"images", []string{"png", "jpg", "jpeg", "gif", "webp"}},
	{"PDF", []string{"pdf"}},
	{"text and documents", []string{"txt", "md", "markdown", "rst", "rtf", "html", "htm", "xml"}},
	{"office", []string{"docx", "xlsx", "pptx", "odt", "ods"}},
	{"data", []string{"csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "log", "sql"}},
	{"source", []string{"go", "py", "ts", "tsx", "js", "jsx", "rb", "rs", "java", "kt", "swift",
		"c", "h", "cpp", "hpp", "cs", "php", "sh", "css", "diff", "patch"}},
}

// pasteExts is pasteKinds flattened: lowercase extension with its dot → true.
var pasteExts = func() map[string]bool {
	m := map[string]bool{}
	for _, k := range pasteKinds {
		for _, e := range k.exts {
			m["."+e] = true
		}
	}
	return m
}()

// pasteMIME is the fallback when the name carries no allowed extension — a
// screenshot pasted from the clipboard arrives as `image.png` in some
// browsers and with no usable name in others — keyed by MIME type, with the
// extension the file gets. Every value is in pasteExts.
var pasteMIME = map[string]string{
	"image/png":        ".png",
	"image/jpeg":       ".jpg",
	"image/gif":        ".gif",
	"image/webp":       ".webp",
	"application/pdf":  ".pdf",
	"text/plain":       ".txt",
	"text/markdown":    ".md",
	"text/csv":         ".csv",
	"application/json": ".json",
}

// pasteAccepted is the sentence a refusal carries, built from the table so
// the two cannot drift.
func pasteAccepted() string {
	parts := make([]string, 0, len(pasteKinds))
	for _, k := range pasteKinds {
		parts = append(parts, k.label+" ("+strings.Join(k.exts, ", ")+")")
	}
	return "accepted: " + strings.Join(parts, "; ")
}

// pasteName decides the name a pasted file is stored under, or false when
// neither its name nor its type is on the allow-list.
//
// The extension is the name's own when that is allowed, else the one the
// MIME type maps to; a name whose extension is not allowed keeps it as part
// of the stem and gets the allowed one appended (`scan.heic` declared as
// `image/png` is stored as `scan.heic.png`), so the stored extension is always
// one from the table.
//
// The stem is reduced to `[A-Za-z0-9._ -]`: the basename only (either slash
// is a separator, so a Windows path from a Unix browser is cut too), any run
// of other characters — control bytes, path syntax, quotes, non-Latin
// letters — collapsed to one `_`, leading and trailing dots and spaces
// removed (no hidden files, no `..`, nothing Windows would silently strip),
// a Windows device name such as `CON` prefixed, and the length capped. An
// empty result becomes `file`.
func pasteName(name, mimeType string) (string, bool) {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	clean := cleanStem(name)
	ext := strings.ToLower(filepath.Ext(clean))
	stem := strings.TrimSuffix(clean, filepath.Ext(clean))
	if !pasteExts[ext] {
		mt := strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
		e, ok := pasteMIME[mt]
		if !ok {
			return "", false
		}
		ext, stem = e, clean
	}
	stem = strings.Trim(stem, ". ")
	if len(stem) > pasteNameMax {
		stem = strings.TrimRight(stem[:pasteNameMax], ". ")
	}
	if stem == "" {
		stem = "file"
	}
	if isWindowsDevice(stem) {
		stem = "_" + stem
	}
	return stem + ext, true
}

// cleanStem keeps `[A-Za-z0-9._ -]` and collapses every run of anything else
// into a single `_`. Invalid UTF-8 is a rune like any other here.
func cleanStem(s string) string {
	var b strings.Builder
	under := false
	for _, r := range s {
		ok := r < utf8.RuneSelf && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' ||
			r >= '0' && r <= '9' || r == '.' || r == '_' || r == ' ' || r == '-')
		if ok {
			b.WriteRune(r)
			under = r == '_'
			continue
		}
		if !under {
			b.WriteByte('_')
			under = true
		}
	}
	return b.String()
}

// isWindowsDevice reports a stem Windows treats as a device rather than a
// file — `CON`, `nul.txt` and `com1.md` all open the device there.
func isWindowsDevice(stem string) bool {
	base := strings.ToUpper(strings.SplitN(stem, ".", 2)[0])
	base = strings.TrimRight(base, " ")
	switch base {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		return base[3] >= '0' && base[3] <= '9'
	}
	return false
}

// handlePaste writes a pasted or dropped file and returns the path to it.
//
// A browser hands over bytes, never a path — there is no path for something
// copied out of a screenshot tool, and a file dragged from Finder arrives as
// a name and its contents. Claude Code reads files by path, so the bytes
// become a file here and the dashboard types its path into the session.
//
// **The bytes arrive base64 inside JSON, not as a raw body**, and that is the
// security design rather than an inconvenience. The forgery guard turns a
// state-changing request away unless it is `application/json`, because a
// cross-site *simple* request cannot set that header — it would force a
// preflight this server never answers. `image/png` is a simple type, so a raw
// upload would have been an endpoint any web page could use to write files
// into the user's data directory. Base64 costs a third more bytes and keeps
// the endpoint behind the same guard as everything else.
//
// Each file gets a directory of its own, `paste/<timestamp>-<random>/`, so
// the name the user gave it (`contract.pdf`) survives for Claude to read and
// two pastes of the same name never collide. Errors are JSON
// `{error, detail}`, which the terminal prints as is.
func (s *Server) handlePaste(w http.ResponseWriter, r *http.Request) {
	fail := func(code int, msg, detail string) {
		writeJSON(w, code, map[string]string{"error": msg, "detail": detail})
	}
	if s.d.DataDir == "" {
		fail(http.StatusNotImplemented, "paste unavailable", "this daemon has no data directory")
		return
	}
	var body struct {
		// Name is the file's own name, as the browser reports it. Only a
		// sanitised basename of it is used; see pasteName.
		Name string `json:"name"`
		// Type is the MIME type, the fallback when the name has no
		// allowed extension. Often empty for documents.
		Type string `json:"type"`
		// Data is the file, base64-encoded.
		Data string `json:"data"`
	}
	// The limit is on the encoded form, which is about a third larger than
	// the file — so the 10 MB cap on the file is a ~13.4 MB cap here, plus
	// room for the JSON around it.
	if err := json.NewDecoder(io.LimitReader(r.Body, 14<<20)).Decode(&body); err != nil {
		fail(http.StatusBadRequest, "bad request", "the body is not the JSON this endpoint takes, or is larger than 10 MB")
		return
	}
	name, ok := pasteName(body.Name, body.Type)
	if !ok {
		what := strings.ToLower(filepath.Ext(cleanStem(body.Name)))
		if what == "" {
			what = "a file with no extension"
		}
		fail(http.StatusUnsupportedMediaType, "unsupported file type: "+what, pasteAccepted())
		return
	}
	raw, err := base64.StdEncoding.DecodeString(body.Data)
	if err != nil {
		fail(http.StatusBadRequest, "bad request", "data is not valid base64")
		return
	}
	if len(raw) == 0 {
		fail(http.StatusBadRequest, "empty file", "there is nothing in it to save")
		return
	}
	if len(raw) > pasteLimit {
		fail(http.StatusRequestEntityTooLarge, "file is larger than 10 MB", "attach it by path instead: type the path into the session")
		return
	}

	root := config.PasteDir(s.d.DataDir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		fail(http.StatusInternalServerError, "cannot write", err.Error())
		return
	}
	var suffix [4]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		fail(http.StatusInternalServerError, "cannot write", err.Error())
		return
	}
	// Mkdir, not MkdirAll: the directory is new or this paste does not
	// happen, so two requests can never share one.
	dir := filepath.Join(root, fmt.Sprintf("%s-%s", s.d.Now().UTC().Format("20060102-150405"), hex.EncodeToString(suffix[:])))
	if err := os.Mkdir(dir, 0o700); err != nil {
		fail(http.StatusInternalServerError, "cannot write", err.Error())
		return
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		fail(http.StatusInternalServerError, "cannot write", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}
