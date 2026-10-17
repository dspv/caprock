package browser

import (
	"bufio"
	"fmt"
	"io/fs"
	posix "path"
	"strings"
)

// The Linux side: desktop entries (the freedesktop.org Desktop Entry
// Specification) and mimeapps.list (its MIME Applications Associations).
// Kept free of build tags so its tests run on every OS.

// webTypes are the MIME types a desktop entry lists to handle web links.
var webTypes = []string{"x-scheme-handler/https", "x-scheme-handler/http"}

// XDGDirs are the folders the Linux side reads, from the user's environment.
type XDGDirs struct {
	// Data are the data dirs, the user's first ($XDG_DATA_HOME, then
	// $XDG_DATA_DIRS), plus Flatpak's and Snap's exports; each holds an
	// applications/ folder.
	Data []string
	// Config are the config dirs, the user's first ($XDG_CONFIG_HOME, then
	// $XDG_CONFIG_DIRS), for mimeapps.list.
	Config []string
	// Desktops are $XDG_CURRENT_DESKTOP's names, lowercased, for the
	// desktop-specific `<desktop>-mimeapps.list`.
	Desktops []string
}

// XDGFrom reads the folders from env, with the specification's defaults.
func XDGFrom(env []string) XDGDirs {
	home := getenv(env, "HOME")
	list := func(key, def string) []string {
		v := getenv(env, key)
		if v == "" {
			v = def
		}
		var out []string
		for _, d := range strings.Split(v, ":") {
			if strings.HasPrefix(d, "/") {
				out = append(out, d)
			}
		}
		return out
	}
	one := func(key, def string) []string {
		v := getenv(env, key)
		if v == "" && home != "" {
			v = posix.Join(home, def)
		}
		if !strings.HasPrefix(v, "/") {
			return nil
		}
		return []string{v}
	}
	var d XDGDirs
	d.Data = append(one("XDG_DATA_HOME", ".local/share"), list("XDG_DATA_DIRS", "/usr/local/share:/usr/share")...)
	if home != "" {
		d.Data = append(d.Data, posix.Join(home, ".local/share/flatpak/exports/share"))
	}
	d.Data = append(d.Data, "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop")
	d.Config = append(one("XDG_CONFIG_HOME", ".config"), list("XDG_CONFIG_DIRS", "/etc/xdg")...)
	for _, n := range strings.Split(getenv(env, "XDG_CURRENT_DESKTOP"), ":") {
		if n = strings.ToLower(strings.TrimSpace(n)); n != "" {
			d.Desktops = append(d.Desktops, n)
		}
	}
	return d
}

// DetectDesktop lists the desktop entries that handle http or https links,
// the default one marked. An entry in an earlier data dir hides one with the
// same id in a later dir, as the specification says.
func DetectDesktop(fsys fs.FS, d XDGDirs, path func(string) string) []Browser {
	seen := map[string]bool{}
	var out []Browser
	for _, dir := range d.Data {
		apps := posix.Join(dir, "applications")
		root := strings.TrimPrefix(apps, "/")
		_ = fs.WalkDir(fsys, root, func(p string, e fs.DirEntry, err error) error {
			if err != nil || e.IsDir() || !strings.HasSuffix(p, ".desktop") {
				return nil
			}
			rel := strings.TrimPrefix(p, root+"/")
			id := strings.ReplaceAll(rel, "/", "-")
			if seen[id] {
				return nil
			}
			seen[id] = true
			f, err := fsys.Open(p)
			if err != nil {
				return nil
			}
			defer f.Close()
			ent, err := parseDesktop(bufio.NewReader(f))
			if err != nil || !ent.usable(path) {
				return nil
			}
			out = append(out, Browser{ID: id, Name: ent.name, exec: ent.exec})
			return nil
		})
	}
	def := defaultDesktop(fsys, d, seen)
	for i := range out {
		out[i].Default = out[i].ID == def
	}
	return out
}

// entry is what a desktop file says that matters here.
type entry struct {
	name, typ, tryExec string
	exec               []string
	web, hidden        bool
}

// usable is an application entry, shown, handling web links, whose TryExec
// (when given) is installed. path resolves a TryExec name; nil skips the
// check.
func (e entry) usable(path func(string) string) bool {
	if e.typ != "Application" || e.hidden || !e.web || e.name == "" || len(e.exec) == 0 {
		return false
	}
	if e.tryExec != "" && path != nil && path(e.tryExec) == "" {
		return false
	}
	return true
}

func parseDesktop(r *bufio.Reader) (entry, error) {
	var e entry
	in := false
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			in = line == "[Desktop Entry]"
			continue
		}
		if !in {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch k {
		case "Name":
			e.name = unescapeValue(v)
		case "Type":
			e.typ = v
		case "TryExec":
			e.tryExec = unescapeValue(v)
		case "Exec":
			words, err := SplitExec(unescapeValue(v))
			if err != nil {
				return entry{}, err
			}
			e.exec = words
		case "MimeType":
			for _, m := range strings.Split(v, ";") {
				for _, w := range webTypes {
					if strings.TrimSpace(m) == w {
						e.web = true
					}
				}
			}
		case "Hidden", "NoDisplay":
			if v == "true" {
				e.hidden = true
			}
		}
	}
	return e, sc.Err()
}

// unescapeValue undoes a desktop file's string escapes (\s \n \t \r \\).
func unescapeValue(v string) string {
	if !strings.Contains(v, `\`) {
		return v
	}
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c != '\\' || i+1 == len(v) {
			b.WriteByte(c)
			continue
		}
		i++
		switch v[i] {
		case 's':
			b.WriteByte(' ')
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case '\\':
			b.WriteByte('\\')
		default:
			b.WriteByte('\\')
			b.WriteByte(v[i])
		}
	}
	return b.String()
}

// SplitExec splits an Exec value into words: spaces separate them, and a
// word in double quotes keeps its spaces, with \" \` \$ \\ inside meaning the
// character itself.
func SplitExec(s string) ([]string, error) {
	var words []string
	var cur strings.Builder
	have, quoted := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quoted && c == '\\' && i+1 < len(s) && strings.IndexByte("\"`$\\", s[i+1]) >= 0:
			i++
			cur.WriteByte(s[i])
		case c == '"':
			quoted = !quoted
			have = true
		case !quoted && (c == ' ' || c == '\t'):
			if have {
				words = append(words, cur.String())
				cur.Reset()
				have = false
			}
		default:
			cur.WriteByte(c)
			have = true
		}
	}
	if quoted {
		return nil, fmt.Errorf("unterminated quote in Exec")
	}
	if have {
		words = append(words, cur.String())
	}
	return words, nil
}

// ExpandExec turns an entry's Exec words into the argv that opens u: %u %U
// %f %F become the URL (once; with none, the URL goes last), %% is a percent
// sign, and the other field codes (%i %c %k and the deprecated ones) drop.
func ExpandExec(words []string, u string) ([]string, error) {
	if len(words) == 0 {
		return nil, fmt.Errorf("%w: the entry has no Exec", ErrNoBrowser)
	}
	var out []string
	placed := false
	for _, w := range words {
		if w == "%u" || w == "%U" || w == "%f" || w == "%F" {
			if !placed {
				out = append(out, u)
				placed = true
			}
			continue
		}
		var b strings.Builder
		for i := 0; i < len(w); i++ {
			if w[i] != '%' || i+1 == len(w) {
				b.WriteByte(w[i])
				continue
			}
			i++
			switch w[i] {
			case '%':
				b.WriteByte('%')
			case 'u', 'U', 'f', 'F':
				if !placed {
					b.WriteString(u)
					placed = true
				}
			}
		}
		if s := b.String(); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: the entry's Exec is empty", ErrNoBrowser)
	}
	if !placed {
		out = append(out, u)
	}
	return out, nil
}

// defaultDesktop is the id the user's mimeapps.list names for https (else
// http), the first one installed; "" when none says.
func defaultDesktop(fsys fs.FS, d XDGDirs, installed map[string]bool) string {
	var files []string
	add := func(dir string) {
		for _, de := range d.Desktops {
			files = append(files, posix.Join(dir, de+"-mimeapps.list"))
		}
		files = append(files, posix.Join(dir, "mimeapps.list"))
	}
	for _, c := range d.Config {
		add(c)
	}
	for _, dd := range d.Data {
		add(posix.Join(dd, "applications"))
		files = append(files, posix.Join(dd, "applications", "defaults.list"))
	}
	for _, mt := range webTypes {
		for _, f := range files {
			for _, id := range defaultsIn(fsys, f, mt) {
				if installed[id] {
					return id
				}
			}
		}
	}
	return ""
}

// defaultsIn reads the [Default Applications] ids for mt from one file.
func defaultsIn(fsys fs.FS, file, mt string) []string {
	f, err := fsys.Open(strings.TrimPrefix(file, "/"))
	if err != nil {
		return nil
	}
	defer f.Close()
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			in = line == "[Default Applications]"
			continue
		}
		if !in {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) != mt {
			continue
		}
		var ids []string
		for _, id := range strings.Split(v, ";") {
			if id = strings.TrimSpace(id); id != "" {
				ids = append(ids, id)
			}
		}
		return ids
	}
	return nil
}
