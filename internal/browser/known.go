package browser

import (
	posix "path"
	"strings"
)

// The OS's own list of apps that handle https links is wider than the web
// browsers: macOS lists a chat app, a terminal and a bank's "secure browser"
// wrapper beside Chrome and Safari, because each registers for https (owner,
// 2026-10-17, translated: "I just want to choose either the default browser
// or the built-in one"). So the chooser's *Other browser…* list keeps only
// the browsers known here — by bundle id or app name on macOS, by executable
// or StartMenuInternet key on Windows, by desktop file id on Linux — and the
// system's default always, known or not: it is what ⌘-click opens anyway.
//
// A browser missing here is simply not offered; as the default it still
// opens every link. Add one by its ids on each OS it ships for.

// knownBundles are macOS bundle identifiers, lower case.
var knownBundles = set(
	"com.apple.safari", "com.apple.safaritechnologypreview",
	"com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary",
	"org.chromium.chromium", "org.chromium.thorium",
	"org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
	"com.microsoft.edgemac", "com.microsoft.edgemac.beta", "com.microsoft.edgemac.dev", "com.microsoft.edgemac.canary",
	"com.brave.browser", "com.brave.browser.beta", "com.brave.browser.nightly",
	"company.thebrowser.browser", "company.thebrowser.dia",
	"com.operasoftware.opera", "com.operasoftware.operagx", "com.operasoftware.operanext", "com.operasoftware.operadeveloper",
	"com.vivaldi.vivaldi", "com.vivaldi.vivaldi.snapshot",
	"ai.perplexity.comet",
	"app.zen-browser.zen",
	"com.kagi.kagimacos", "com.kagi.kagimacos.rc",
	"com.duckduckgo.macos.browser",
	"ru.yandex.desktop.yandex-browser",
	"org.torproject.torbrowser",
	"io.gitlab.librewolf-community", "org.librewolf.librewolf",
	"net.waterfox.waterfox",
	"one.ablaze.floorp",
	"com.pushplaylabs.sidekick",
	"com.sigmaos.sigmaos.macos",
	"net.mullvad.mullvadbrowser",
)

// knownNames are app or display names, lower case: the bundle's name on
// macOS ("Google Chrome.app"), a client's display name on Windows, a desktop
// entry's Name on Linux.
var knownNames = set(
	"safari", "safari technology preview",
	"google chrome", "google chrome beta", "google chrome dev", "google chrome canary",
	"chromium", "ungoogled chromium", "thorium",
	"firefox", "mozilla firefox", "firefox developer edition", "firefox nightly", "firefox esr", "firefox web browser",
	"microsoft edge", "microsoft edge beta", "microsoft edge dev", "microsoft edge canary",
	"brave", "brave browser", "brave browser beta", "brave browser nightly", "brave web browser",
	"arc", "dia",
	"opera", "opera gx", "opera beta", "opera developer", "opera stable", "opera gx stable",
	"vivaldi", "vivaldi snapshot",
	"comet",
	"zen", "zen browser",
	"orion", "orion rc",
	"duckduckgo",
	"yandex", "yandex browser",
	"tor browser",
	"librewolf",
	"waterfox",
	"floorp",
	"sidekick",
	"sigmaos",
	"mullvad browser",
	"epiphany", "gnome web", "konqueror", "falkon", "midori", "qutebrowser", "internet explorer",
)

// knownExes are Windows executables, lower case. Opera's is launcher.exe,
// too common a name to trust, so Opera is known by its key or name there.
var knownExes = set(
	"chrome.exe", "firefox.exe", "msedge.exe", "brave.exe", "opera.exe", "vivaldi.exe",
	"comet.exe", "zen.exe", "duckduckgo.exe", "librewolf.exe", "waterfox.exe", "floorp.exe",
	"thorium.exe", "iexplore.exe", "arc.exe", "sidekick.exe", "mullvadbrowser.exe",
)

// knownKeys are Windows StartMenuInternet keys and Linux desktop file ids,
// lower case, without ".desktop"; a key's "-<hash>" or ".<hash>" install
// suffix (Firefox's, Vivaldi's on Windows) is cut before a second lookup.
var knownKeys = set(
	// Windows
	"google chrome", "google chrome beta", "google chrome dev", "google chrome canary", "chromium",
	"firefox", "firefox.exe", "firefox developer edition", "firefox nightly",
	"microsoft edge", "microsoft edge beta", "microsoft edge dev", "microsoft edge canary",
	"brave", "brave browser", "operastable", "operagxstable", "operabeta", "operadeveloper",
	"vivaldi", "yandex", "yandexbrowser", "librewolf", "waterfox", "floorp", "zen", "comet", "duckduckgo",
	"iexplore.exe",
	// Linux
	"firefox-esr", "org.mozilla.firefox", "firefox_firefox", "firefox-developer-edition", "firefox-nightly",
	"google-chrome", "google-chrome-beta", "google-chrome-unstable", "com.google.chrome",
	"chromium-browser", "chromium_chromium", "org.chromium.chromium", "ungoogled-chromium", "io.github.ungoogled_software.ungoogled_chromium",
	"microsoft-edge", "microsoft-edge-beta", "microsoft-edge-dev", "com.microsoft.edge",
	"brave-browser", "brave-browser-beta", "brave-browser-nightly", "com.brave.browser", "brave_brave",
	"opera", "opera-beta", "opera-developer", "com.opera.opera",
	"vivaldi-stable", "vivaldi-snapshot", "com.vivaldi.vivaldi",
	"yandex-browser", "yandex-browser-stable", "ru.yandex.browser",
	"torbrowser", "tor-browser", "torbrowser-launcher", "org.torproject.torbrowser-launcher",
	"io.gitlab.librewolf-community", "net.waterfox.waterfox", "one.ablaze.floorp",
	"zen-browser", "app.zen_browser.zen",
	"mullvad-browser", "net.mullvad.mullvadbrowser", "thorium-browser",
	"epiphany", "org.gnome.epiphany", "konqueror", "org.kde.konqueror", "kde4-konq", "falkon", "org.kde.falkon",
	"midori", "org.midori_browser.midori", "qutebrowser", "org.qutebrowser.qutebrowser",
)

func set(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// IsWebBrowser says whether b is a browser the chooser knows: its macOS
// bundle id, its app or display name, its Windows executable or key, or its
// Linux desktop file id is on the lists above.
func IsWebBrowser(b Browser) bool {
	if b.bundle != "" && knownBundles[strings.ToLower(b.bundle)] {
		return true
	}
	if knownNames[strings.ToLower(strings.TrimSpace(b.Name))] {
		return true
	}
	if b.app != "" {
		// A macOS bundle's path or a Windows executable's; either separator.
		base := strings.ToLower(posix.Base(strings.ReplaceAll(strings.TrimSuffix(b.app, "/"), `\`, "/")))
		if knownExes[base] || (strings.HasSuffix(base, ".app") && knownNames[strings.TrimSuffix(base, ".app")]) {
			return true
		}
	}
	id := strings.ToLower(strings.TrimSuffix(b.ID, ".desktop"))
	if knownKeys[id] {
		return true
	}
	// Firefox-308046B0AF4A39CB, Vivaldi.ABCDEF: a key with its install hash.
	if i := strings.LastIndexAny(id, "-."); i > 0 && knownKeys[id[:i]] {
		return true
	}
	return false
}

// WebBrowsersOnly keeps the browsers IsWebBrowser knows, and the default
// whatever it is.
func WebBrowsersOnly(bs []Browser) []Browser {
	var out []Browser
	for _, b := range bs {
		if b.Default || IsWebBrowser(b) {
			out = append(out, b)
		}
	}
	return out
}
