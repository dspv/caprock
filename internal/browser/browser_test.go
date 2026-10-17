package browser

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dspv/caprock/internal/nativeterm"
)

func TestCheckURL(t *testing.T) {
	for _, ok := range []string{"https://example.com", "http://localhost:5173/x?y=1#z", "https://例え.jp/パス"} {
		if _, err := CheckURL(ok); err != nil {
			t.Errorf("CheckURL(%q) = %v, want ok", ok, err)
		}
	}
	for _, bad := range []string{
		"", "file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.c", "-a Calculator", "https://", "https://a b.com",
		"https://x.com/\n--flag", "ftp://x.com", strings.Repeat("a", MaxURL+1),
	} {
		if _, err := CheckURL(bad); !errors.Is(err, ErrBadURL) {
			t.Errorf("CheckURL(%q) = %v, want ErrBadURL", bad, err)
		}
	}
}

func TestSortedPutsTheDefaultFirstThenByName(t *testing.T) {
	got := Sorted([]Browser{{ID: "z", Name: "zen"}, {ID: "f", Name: "Firefox"}, {ID: "c", Name: "Chrome", Default: true}, {ID: "f", Name: "dup"}, {ID: "a", Name: "Arc"}})
	var names []string
	for _, b := range got {
		names = append(names, b.Name)
	}
	if want := []string{"Chrome", "Arc", "Firefox", "zen"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("order %v, want %v", names, want)
	}
}

func TestFromAppPaths(t *testing.T) {
	paths := []string{
		"/Applications/Google Chrome.app",
		"/Applications/Google Chrome.app/Contents/Frameworks/Helper.app",
		"/Users/me/Library/Caches/ms-playwright/chromium/Chromium.app",
		"/Users/me/.tool/Chromium.app",
		"/Users/me/.Trash/Applications/Old.app",
		"/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app",
		"/Users/me/Applications/Firefox.app/",
		"/Applications/Gone.app",
		"/Volumes/Backup/Applications/Google Chrome.app",
	}
	got := FromAppPaths(paths, "/Applications/Google Chrome.app/", func(p string) bool { return p != "/Applications/Gone.app" })
	want := []Browser{
		{ID: "/Applications/Google Chrome.app", Name: "Google Chrome", Default: true, app: "/Applications/Google Chrome.app"},
		{ID: "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app", Name: "Safari", app: "/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app"},
		{ID: "/Users/me/Applications/Firefox.app", Name: "Firefox", app: "/Users/me/Applications/Firefox.app"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestFromClients(t *testing.T) {
	got := FromClients([]Client{
		{Key: "Google Chrome", Name: "Google Chrome", Command: `"C:\Program Files\Google\Chrome\Application\chrome.exe"`, HTTPSProgID: "ChromeHTML"},
		{Key: "Microsoft Edge", Name: "@C:\\edge.dll,-1", Command: `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument`, HTTPSProgID: "MSEdgeHTM"},
		{Key: "google chrome", Name: "Machine copy", Command: `C:\Other\chrome.exe`},
		{Key: "Broken", Name: "Broken", Command: ""},
		{Key: "FIREFOX.EXE", Name: "Firefox", Command: `C:\Program Files\Mozilla Firefox\firefox.exe -osint`, HTTPSProgID: "FirefoxURL-308046B0AF4A39CB"},
	}, "msedgehtm")
	want := []Browser{
		{ID: "Google Chrome", Name: "Google Chrome", app: `C:\Program Files\Google\Chrome\Application\chrome.exe`},
		{ID: "Microsoft Edge", Name: "Microsoft Edge", Default: true, app: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`},
		{ID: "FIREFOX.EXE", Name: "Firefox", app: `C:\Program Files\Mozilla Firefox\firefox.exe`},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestSplitAndExpandExec(t *testing.T) {
	cases := []struct {
		exec string
		want []string
	}{
		{"/usr/lib/firefox/firefox %u", []string{"/usr/lib/firefox/firefox", "U"}},
		{"google-chrome-stable %U", []string{"google-chrome-stable", "U"}},
		{"/usr/bin/flatpak run --branch=stable --command=brave com.brave.Browser @@u %U @@", []string{"/usr/bin/flatpak", "run", "--branch=stable", "--command=brave", "com.brave.Browser", "@@u", "U", "@@"}},
		{`env "MOZ_ENABLE_WAYLAND=1" "/opt/my browser/run" --name %c %i %k`, []string{"env", "MOZ_ENABLE_WAYLAND=1", "/opt/my browser/run", "--name", "U"}},
		{`app --open=%u --pct=100%%`, []string{"app", "--open=U", "--pct=100%"}},
		{`quoted "a \"b\" \$c"`, []string{"quoted", `a "b" $c`, "U"}},
	}
	for _, c := range cases {
		words, err := SplitExec(c.exec)
		if err != nil {
			t.Fatalf("SplitExec(%q): %v", c.exec, err)
		}
		got, err := ExpandExec(words, "U")
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q → %q, %v; want %q", c.exec, got, err, c.want)
		}
	}
	if _, err := SplitExec(`a "b`); err == nil {
		t.Error("an unterminated quote is an error")
	}
	if _, err := ExpandExec(nil, "U"); !errors.Is(err, ErrNoBrowser) {
		t.Error("no Exec is no browser")
	}
}

func TestDetectDesktop(t *testing.T) {
	fsys := fstest.MapFS{
		"home/me/.local/share/applications/firefox.desktop":                    {Data: []byte("[Desktop Entry]\nType=Application\nName=Firefox (mine)\nExec=/home/me/firefox/firefox %u\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n")},
		"usr/share/applications/firefox.desktop":                               {Data: []byte("[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox %u\nMimeType=x-scheme-handler/https;\n")},
		"usr/share/applications/google-chrome.desktop":                         {Data: []byte("[Desktop Entry]\nName=Google Chrome\nExec=/usr/bin/google-chrome-stable %U\nType=Application\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n[Desktop Action new-window]\nName=New Window\nExec=/usr/bin/google-chrome-stable\n")},
		"usr/share/applications/gedit.desktop":                                 {Data: []byte("[Desktop Entry]\nType=Application\nName=Text Editor\nExec=gedit %U\nMimeType=text/plain;\n")},
		"usr/share/applications/hidden.desktop":                                {Data: []byte("[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\nExec=h %u\nMimeType=x-scheme-handler/https;\n")},
		"usr/share/applications/gone.desktop":                                  {Data: []byte("[Desktop Entry]\nType=Application\nName=Gone\nTryExec=gone-browser\nExec=gone-browser %u\nMimeType=x-scheme-handler/https;\n")},
		"usr/share/applications/kde4/konq.desktop":                             {Data: []byte("[Desktop Entry]\nType=Application\nName=Konqueror\nExec=konqueror %u\nMimeType=x-scheme-handler/http;\n")},
		"var/lib/flatpak/exports/share/applications/com.brave.Browser.desktop": {Data: []byte("[Desktop Entry]\nType=Application\nName=Brave\nExec=/usr/bin/flatpak run com.brave.Browser @@u %U @@\nMimeType=x-scheme-handler/https;\n")},
		"home/me/.config/mimeapps.list":                                        {Data: []byte("[Added Associations]\nx-scheme-handler/https=firefox.desktop;\n[Default Applications]\nx-scheme-handler/https=missing.desktop;google-chrome.desktop;\n")},
		"etc/xdg/gnome-mimeapps.list":                                          {Data: []byte("[Default Applications]\nx-scheme-handler/https=firefox.desktop\n")},
		"usr/share/applications/defaults.list":                                 {Data: []byte("[Default Applications]\nx-scheme-handler/http=firefox.desktop\n")},
	}
	env := []string{"HOME=/home/me", "XDG_CURRENT_DESKTOP=ubuntu:GNOME"}
	d := XDGFrom(env)
	got := Sorted(DetectDesktop(fsys, d, func(n string) string {
		if n == "gone-browser" {
			return ""
		}
		return "/usr/bin/" + n
	}))
	var summary []string
	for _, b := range got {
		s := b.ID + "=" + b.Name
		if b.Default {
			s += " (default)"
		}
		summary = append(summary, s)
	}
	want := []string{"google-chrome.desktop=Google Chrome (default)", "com.brave.Browser.desktop=Brave", "firefox.desktop=Firefox (mine)", "kde4-konq.desktop=Konqueror"}
	if !reflect.DeepEqual(summary, want) {
		t.Fatalf("got %q\nwant %q", summary, want)
	}
	if !reflect.DeepEqual(got[2].exec, []string{"/home/me/firefox/firefox", "%u"}) {
		t.Errorf("the user's own entry wins: %q", got[2].exec)
	}
}

func TestDefaultFallsBackToTheDesktopsOwnList(t *testing.T) {
	fsys := fstest.MapFS{
		"usr/share/applications/firefox.desktop": {Data: []byte("[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox %u\nMimeType=x-scheme-handler/https;\n")},
		"etc/xdg/gnome-mimeapps.list":            {Data: []byte("[Default Applications]\nx-scheme-handler/https=firefox.desktop\n")},
	}
	got := DetectDesktop(fsys, XDGFrom([]string{"HOME=/home/me", "XDG_CURRENT_DESKTOP=GNOME"}), nil)
	if len(got) != 1 || !got[0].Default {
		t.Fatalf("got %+v", got)
	}
}

func TestBuild(t *testing.T) {
	u := "https://example.com/a?b=c"
	p, err := Build("darwin", Browser{ID: "/Applications/Firefox.app", Name: "Firefox", app: "/Applications/Firefox.app"}, u, nil)
	if err != nil || p.Command != "/usr/bin/open" || !reflect.DeepEqual(p.Args, []string{"-a", "/Applications/Firefox.app", u}) || !p.Wait {
		t.Errorf("darwin: %+v %v", p, err)
	}
	p, err = Build("windows", Browser{ID: "Google Chrome", app: `C:\chrome.exe`}, u, nil)
	if err != nil || p.Command != `C:\chrome.exe` || !reflect.DeepEqual(p.Args, []string{u}) || p.Wait {
		t.Errorf("windows: %+v %v", p, err)
	}
	p, err = Build("linux", Browser{ID: "b.desktop", exec: []string{"/usr/bin/flatpak", "run", "com.brave.Browser", "@@u", "%U", "@@"}}, u, nil)
	if err != nil || p.Command != "/usr/bin/flatpak" || !reflect.DeepEqual(p.Args, []string{"run", "com.brave.Browser", "@@u", u, "@@"}) {
		t.Errorf("linux: %+v %v", p, err)
	}
	if _, err := Build("linux", Browser{ID: "x", exec: []string{"no-such-browser-here", "%u"}}, u, []string{"PATH=/nonexistent"}); !errors.Is(err, ErrNoBrowser) {
		t.Errorf("a missing executable: %v", err)
	}
	if _, err := Build("plan9", Browser{}, u, nil); err == nil {
		t.Error("an unknown OS is an error")
	}
}

func TestOpenerNeverRunsAnythingButThePlan(t *testing.T) {
	var ran []nativeterm.Plan
	detected := 0
	o := &Opener{
		Env: func() []string { return []string{"PATH=/usr/bin", "CLAUDECODE=1"} },
		Detect: func([]string) []Browser {
			detected++
			return []Browser{
				{ID: "b", Name: "Firefox", app: "/Applications/Firefox.app", exec: []string{"/usr/bin/firefox", "%u"}},
				{ID: "a", Name: "Alpha", Default: true, app: "/Applications/Alpha.app", exec: []string{"/usr/bin/alpha", "%u"}},
				{ID: "t", Name: "iTerm", app: "/Applications/iTerm.app", exec: []string{"/usr/bin/iterm", "%u"}},
			}
		},
		Run: func(_ context.Context, p nativeterm.Plan, env []string) error {
			for _, kv := range env {
				if strings.HasPrefix(kv, "CLAUDECODE=") {
					t.Errorf("nested-session variable reached the browser: %s", kv)
				}
			}
			ran = append(ran, p)
			return nil
		},
	}
	// The default stays though no list knows it; a terminal that handles https does not.
	if l := o.List(); len(l) != 2 || l[0].ID != "a" || l[1].ID != "b" {
		t.Fatalf("list %+v", l)
	}
	if _, err := o.Open(context.Background(), "t", "https://example.com"); !errors.Is(err, ErrNoBrowser) {
		t.Errorf("a terminal is not offered, so not opened: %v", err)
	}
	if _, err := o.Open(context.Background(), "b", "javascript:alert(1)"); !errors.Is(err, ErrBadURL) {
		t.Errorf("bad url: %v", err)
	}
	if _, err := o.Open(context.Background(), "zzz", "https://example.com"); !errors.Is(err, ErrNoBrowser) {
		t.Errorf("unknown browser: %v", err)
	}
	b, err := o.Open(context.Background(), "b", "https://example.com")
	if err != nil || b.Name != "Firefox" || len(ran) != 1 {
		t.Fatalf("open: %+v %v %d", b, err, len(ran))
	}
	if !strings.Contains(strings.Join(ran[0].Args, " "), "https://example.com") {
		t.Errorf("the URL is a word of its own: %+v", ran[0])
	}
	if detected != 1 {
		t.Errorf("detected %d times, want once", detected)
	}
}

func TestWebBrowsersOnly(t *testing.T) {
	in := []Browser{
		// macOS: by bundle id or bundle name; the rest is what the owner's Mac listed beside them (2026-10-17).
		{ID: "/Applications/Google Chrome.app", Name: "Google Chrome", Default: true, app: "/Applications/Google Chrome.app", bundle: "com.google.Chrome"},
		{ID: "/Applications/ChatGPT.app", Name: "ChatGPT", app: "/Applications/ChatGPT.app", bundle: "com.openai.codex"},
		{ID: "/Applications/Comet.app", Name: "Comet", app: "/Applications/Comet.app", bundle: "ai.perplexity.comet"},
		{ID: "/Applications/Israel Discount Bank Secure Browser.app", Name: "Israel Discount Bank Secure Browser", app: "/Applications/Israel Discount Bank Secure Browser.app", bundle: "com.obs.idbny.msb.MSCB"},
		{ID: "/Applications/iTerm.app", Name: "iTerm", app: "/Applications/iTerm.app", bundle: "com.googlecode.iterm2"},
		{ID: "/Applications/Firefox Developer Edition.app", Name: "Firefox Developer Edition", app: "/Applications/Firefox Developer Edition.app"},
		{ID: "/Applications/Renamed.app", Name: "Renamed", app: "/Applications/Renamed.app", bundle: "company.thebrowser.Browser"},
		{ID: "/Applications/Visual Studio Code.app", Name: "Visual Studio Code", app: "/Applications/Visual Studio Code.app", bundle: "com.microsoft.VSCode"},
		// Windows: by key, by executable, by a key with its install hash.
		{ID: "OperaStable", Name: "Opera Stable", app: `C:\Users\me\AppData\Local\Programs\Opera\launcher.exe`},
		{ID: "Firefox-308046B0AF4A39CB", Name: "Firefox", app: `C:\Program Files\Mozilla Firefox\firefox.exe`},
		{ID: "Vivaldi.ABCDEF", Name: "Vivaldi Browser", app: `C:\Vivaldi\Application\vivaldi.exe`},
		{ID: "Bank", Name: "Bank Secure", app: `C:\Bank\launcher.exe`},
		// Linux: desktop ids, Flatpak's among them, and a terminal and an editor.
		{ID: "com.brave.Browser.desktop", Name: "Brave"},
		{ID: "org.mozilla.firefox.desktop", Name: "Firefox Web Browser"},
		{ID: "org.gnome.Terminal.desktop", Name: "Terminal"},
		{ID: "code.desktop", Name: "Code"},
	}
	var got []string
	for _, b := range WebBrowsersOnly(in) {
		got = append(got, b.Name)
	}
	want := []string{"Google Chrome", "Comet", "Firefox Developer Edition", "Renamed", "Opera Stable", "Firefox", "Vivaldi Browser", "Brave", "Firefox Web Browser"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	// The default is kept whatever it is: it is what a plain click opens.
	if kept := WebBrowsersOnly([]Browser{{ID: "x", Name: "Odd Default", Default: true}, {ID: "y", Name: "ChatGPT"}}); len(kept) != 1 || kept[0].Name != "Odd Default" {
		t.Fatalf("default dropped: %+v", kept)
	}
}
