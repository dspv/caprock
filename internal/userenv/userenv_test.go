package userenv

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/config"
)

func TestParseSkipsBannerAndShellState(t *testing.T) {
	out := "Welcome back!\n" + mark +
		"PATH=/opt/homebrew/bin:/usr/bin\x00GOOGLE_CLOUD_PROJECT=acme\x00MULTI=a\nb\x00" +
		"PWD=/x\x00SHLVL=3\x00_=/usr/bin/env\x00" + ResolvingVar + "=1\x00junk\x00" +
		mark + "bye\n"
	env, err := parse([]byte(out))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"PATH=/opt/homebrew/bin:/usr/bin", "GOOGLE_CLOUD_PROJECT=acme", "MULTI=a\nb"}
	if !slices.Equal(env, want) {
		t.Fatalf("env = %q, want %q", env, want)
	}
}

func TestParseRejectsMissingDumpOrPath(t *testing.T) {
	if _, err := parse([]byte("no marks here")); err == nil {
		t.Fatal("want error without marks")
	}
	if _, err := parse([]byte(mark + "HOME=/h\x00" + mark)); err == nil {
		t.Fatal("want error without PATH")
	}
}

// A real shell, driven the way the daemon drives it: a fake login shell that
// prints a banner and adds a profile export proves the whole round trip.
func TestResolveRunsTheLoginShell(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no login shell on Windows")
	}
	dir := t.TempDir()
	shell := filepath.Join(dir, "fakesh")
	// Stands in for zsh -l -i: "sources a profile" by exporting, then runs -c.
	script := "#!/bin/sh\necho 'profile banner'\nexport FROM_PROFILE=yes\nexport PATH=/opt/fake/bin:$PATH\nshift 3\nexec /bin/sh -c \"$1\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	env, err := resolve(context.Background(), shell, []string{"PATH=/usr/bin:/bin", "INHERITED=1"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"FROM_PROFILE=yes", "INHERITED=1", "PATH=/opt/fake/bin:/usr/bin:/bin"} {
		if !slices.Contains(env, want) {
			t.Errorf("missing %q in %q", want, env)
		}
	}
	for _, kv := range env {
		if strings.HasPrefix(kv, ResolvingVar+"=") {
			t.Errorf("resolver marker leaked: %q", kv)
		}
	}
}

func TestResolveGivesUpOnAHangingProfile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no login shell on Windows")
	}
	dir := t.TempDir()
	shell := filepath.Join(dir, "slowsh")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := resolve(ctx, shell, os.Environ()); err == nil {
		t.Fatal("want an error from a shell that never answers")
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v to give up", d)
	}
}

func TestEnvironFallsBackCachesAndPinsDataDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows returns the daemon's environment unchanged")
	}
	t.Cleanup(func() { resolveFn, now = resolve, time.Now; reset() })
	t.Setenv(config.EnvDataDir, "/daemon/data")

	// A failing resolution falls back to the daemon's environment and is not
	// cached.
	calls := 0
	resolveFn = func(context.Context, string, []string) ([]string, error) {
		calls++
		return nil, errors.New("boom")
	}
	reset()
	if env := Environ(nil); !slices.Contains(env, config.EnvDataDir+"=/daemon/data") {
		t.Fatalf("fallback lost the daemon's environment: %q", env)
	}
	Environ(nil)
	if calls != 2 {
		t.Fatalf("failure was cached: %d calls", calls)
	}

	// A good one is served from cache, refreshed in the background once stale,
	// and the profile cannot move the data dir.
	clock := time.Unix(1000, 0)
	now = func() time.Time { return clock }
	done := make(chan struct{}, 4)
	calls = 0
	resolveFn = func(context.Context, string, []string) ([]string, error) {
		calls++
		done <- struct{}{}
		return []string{"PATH=/p" + strings.Repeat("x", calls), config.EnvDataDir + "=/profile/data"}, nil
	}
	env := Environ(nil)
	<-done
	if slices.Contains(env, config.EnvDataDir+"=/profile/data") || !slices.Contains(env, config.EnvDataDir+"=/daemon/data") {
		t.Fatalf("data dir not pinned to the daemon's: %q", env)
	}
	if env := Environ(nil); !slices.Contains(env, "PATH=/px") || calls != 1 {
		t.Fatalf("fresh cache not reused: calls=%d env=%q", calls, env)
	}
	clock = clock.Add(TTL + time.Second)
	// Stale: answered at once from the old copy, refreshed behind it.
	if env := Environ(nil); !slices.Contains(env, "PATH=/px") {
		t.Fatalf("stale read did not return the cached copy: %q", env)
	}
	<-done
	deadline := time.Now().Add(2 * time.Second)
	for !slices.Contains(Environ(nil), "PATH=/pxx") {
		if time.Now().After(deadline) {
			t.Fatal("background refresh never landed")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
