package userenv

import (
	"os"
	"runtime"
	"strings"
)

// WithUTF8Locale gives env a UTF-8 locale when it has none, as a terminal
// application does before it starts a shell.
//
// Nothing else on the way sets one. launchd does not, and a login profile
// seldom does, because Terminal.app, iTerm2 and VS Code export LANG
// themselves; only a recent macOS's /etc/zprofile has a default, so bash,
// fish, an older macOS and a profile that failed to resolve start in the C
// locale. There the bytes of a pasted "καλημέρα" arrive intact and the
// program still takes each byte for a character: bash shows
// `\316\272\316\261…`, zsh `<00ad>` (user report, 2026-10-11: a paste of
// Russian text). And pbcopy, which an agent runs to copy an answer, reads
// its input as Mac Roman: a Russian line lands on the clipboard as
// "DNS-–∑–∞–ø‚Ä¶" (user report, 2026-10-15). Caprock is the terminal
// here, so it sets LANG, and leaves a locale the user did set alone.
// en_US.UTF-8 exists on every macOS; C.UTF-8 is the one a minimal Linux
// has. ConPTY speaks UTF-8 whatever the environment says, so Windows gets
// nothing.
func WithUTF8Locale(env []string, goos string) []string {
	if goos == "windows" {
		return env
	}
	for _, kv := range env {
		if k, v, _ := strings.Cut(kv, "="); v != "" && isLocaleVar(k) {
			return env
		}
	}
	// Empty ones go: a C library reads the first LANG= it finds, and an
	// empty one ahead of ours would win.
	out := env[:0:0]
	for _, kv := range env {
		if k, _, _ := strings.Cut(kv, "="); !isLocaleVar(k) {
			out = append(out, kv)
		}
	}
	return append(out, "LANG="+utf8Lang(goos))
}

// EnsureProcessLocale gives the daemon's own environment a UTF-8 locale when
// it has none, so every child started from os.Environ() — the terminal
// host's fallback, a helper that never asks for the login shell's — inherits
// one too, not only the ones built through Environ.
func EnsureProcessLocale() {
	if runtime.GOOS == "windows" {
		return
	}
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if os.Getenv(k) != "" {
			return
		}
	}
	_ = os.Setenv("LANG", utf8Lang(runtime.GOOS))
}

func utf8Lang(goos string) string {
	if goos == "darwin" {
		return "en_US.UTF-8"
	}
	return "C.UTF-8"
}

// isLocaleVar names the variables that decide how text is decoded, in the
// order a C library reads them.
func isLocaleVar(k string) bool { return k == "LC_ALL" || k == "LC_CTYPE" || k == "LANG" }
