package userenv

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

func TestWithUTF8LocaleAddsOneOnlyWhenNoneIsSet(t *testing.T) {
	got := WithUTF8Locale([]string{"PATH=/bin", "LANG="}, "darwin")
	if strings.Join(got, " ") != "PATH=/bin LANG=en_US.UTF-8" {
		t.Fatalf("darwin, empty LANG: %q", got)
	}
	if got := WithUTF8Locale([]string{"LC_CTYPE=UTF-8"}, "darwin"); len(got) != 1 {
		t.Fatalf("a locale the user set is kept alone: %q", got)
	}
	if got := WithUTF8Locale([]string{"PATH=/bin"}, "linux"); got[len(got)-1] != "LANG=C.UTF-8" {
		t.Fatalf("linux: %q", got)
	}
	if got := WithUTF8Locale([]string{"PATH=x"}, "windows"); len(got) != 1 {
		t.Fatalf("windows gets nothing: %q", got)
	}
}

// The user report of 2026-10-15: an agent's pbcopy, started with no locale,
// took UTF-8 for Mac Roman. Run through the environment Caprock builds, a
// program reading the locale sees UTF-8. `locale` is used rather than
// pbcopy, which would overwrite the clipboard of whoever runs the tests.
func TestAChildStartedWithNoLocaleGetsUTF8(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ConPTY speaks UTF-8 whatever the environment says")
	}
	if _, err := exec.LookPath("locale"); err != nil {
		t.Skip("no locale command")
	}
	cmd := exec.Command("locale")
	cmd.Env = WithUTF8Locale([]string{"PATH=" + os.Getenv("PATH")}, runtime.GOOS)
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "UTF-8") {
		t.Fatalf("locale reports no UTF-8:\n%s", out)
	}
}
