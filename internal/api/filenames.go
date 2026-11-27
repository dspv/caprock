package api

import (
	"regexp"
	"strings"
)

// A prompt that opened with a dropped file starts with the file's quoted
// path: `"/Users/me/Library/Application Support/caprock/paste/drop-…/CV.pdf"
// how is my CV?`. Clipped to 120 runes, a description of it kept the folders
// and lost the file's name and the words — the sidebar named the session
// "Application Support/caprock/paste/drop-179" (owner, 2026-11-27). So each
// absolute file path in a prompt is cut to its file name before the clip.
//
// The rules are the dashboard's (ui/src/lib/filepaths.ts `pathParts`, where
// its tests are): an absolute path (`/…`, `~/…`, `C:\…`, `C:/…`) ending in a
// file name with an extension, double-quoted with `\"` escaped,
// single-quoted, or bare after a space with its spaces backslash-escaped —
// a bare one only with a folder in it and none of `{}*?=&#%<>`, so a route
// stays text. Never a URL, a relative name, `//server/share` or a folder.

const absPath = `(?:/|~/|[A-Za-z]:[\\/])`

var filePathRe = regexp.MustCompile(
	`"(` + absPath + `(?:\\.|[^"\\\n])*)"` +
		`|'(` + absPath + `[^'\n]*)'` +
		"|(^|[\\s(\\[])(" + absPath + "(?:\\\\ |[^\\s\"'`<>()\\[\\]{}*?=&#%])+)",
)

var (
	fileExtRe      = regexp.MustCompile(`^.+\.([A-Za-z0-9]{1,8})$`)
	trailingPunct  = regexp.MustCompile(`[.,;:!?…]+$`)
	hasLetterRe    = regexp.MustCompile(`[A-Za-z]`)
	pathSeparators = regexp.MustCompile(`[\\/]`)
)

// fileBase is the last part of a path, either separator.
func fileBase(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// isFilePath says whether an unquoted path names a file a name may stand for.
func isFilePath(p string, bare bool) bool {
	if strings.HasPrefix(p, "//") || strings.HasSuffix(p, "/") || strings.HasSuffix(p, `\`) {
		return false
	}
	m := fileExtRe.FindStringSubmatch(fileBase(p))
	if m == nil || !hasLetterRe.MatchString(m[1]) {
		return false
	}
	if bare {
		rest := p
		if len(rest) >= 2 && (rest[1] == ':' || rest[0] == '~') {
			rest = rest[2:]
		}
		n := 0
		for _, part := range pathSeparators.Split(rest, -1) {
			if part != "" {
				n++
			}
		}
		if n < 2 {
			return false
		}
	}
	return true
}

// pathsAsNames is s with each absolute file path in it cut to the file's
// name: `"/…/paste/drop-…/CV.pdf" how is my CV?` → `CV.pdf how is my CV?`.
func pathsAsNames(s string) string { return replaceFilePaths(s, fileBase) }

// onlyFilePaths says whether s is file paths and nothing else: a drop with
// no words, which does not say what a session is about.
func onlyFilePaths(s string) bool {
	return strings.TrimSpace(replaceFilePaths(s, func(string) string { return "" })) == "" && strings.TrimSpace(s) != ""
}

// replaceFilePaths is s with each absolute file path in it replaced by with(path).
func replaceFilePaths(s string, with func(path string) string) string {
	if !strings.ContainsAny(s, `/\`) {
		return s
	}
	var b strings.Builder
	at := 0
	for _, m := range filePathRe.FindAllStringSubmatchIndex(s, -1) {
		start, end := m[0], m[1]
		var p string
		switch {
		case m[2] >= 0:
			p = strings.ReplaceAll(s[m[2]:m[3]], `\"`, `"`)
			if !isFilePath(p, false) {
				continue
			}
		case m[4] >= 0:
			p = s[m[4]:m[5]]
			if !isFilePath(p, false) {
				continue
			}
		default:
			start = m[8]
			raw := trailingPunct.ReplaceAllString(s[m[8]:m[9]], "")
			end = start + len(raw)
			p = strings.ReplaceAll(raw, `\ `, " ")
			if !isFilePath(p, true) {
				continue
			}
		}
		b.WriteString(s[at:start])
		b.WriteString(with(p))
		at = end
	}
	if at == 0 {
		return s
	}
	b.WriteString(s[at:])
	return b.String()
}
