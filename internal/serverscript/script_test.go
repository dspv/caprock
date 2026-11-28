package serverscript

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the golden scripts in testdata")

// A join key shaped like remote.JoinKey.String(): never a live one.
const testKey = "cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1A"

func testInput() Input {
	return Input{
		Version: "0.201.0",
		SHA256: map[string]string{
			"amd64": strings.Repeat("a1", 32),
			"arm64": strings.Repeat("b2", 32),
		},
		Signed:  true,
		JoinKey: testKey,
		SSHKey:  true,
	}
}

// The golden scripts: one per shape of input. `go test ./internal/serverscript
// -update` rewrites them; a diff in review is the script's change.
func TestGoldenScripts(t *testing.T) {
	unsigned := testInput()
	unsigned.Signed, unsigned.SSHKey = false, false
	for name, in := range map[string]Input{
		"signed-ssh-key.sh":  testInput(),
		"unsigned-no-ssh.sh": unsigned,
	} {
		got, err := Render(in)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		again, _ := Render(in)
		if again != got {
			t.Fatalf("%s: two renders of one input differ", name)
		}
		path := filepath.Join("testdata", name)
		if *update {
			if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (run with -update to write it)", err)
		}
		if strings.ReplaceAll(string(want), "\r\n", "\n") != got {
			t.Errorf("%s differs from the golden copy: run `go test ./internal/serverscript -update` and review the diff", name)
		}
	}
}

func TestTheScriptSaysWhatItChecks(t *testing.T) {
	s, err := Render(testInput())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"#!/bin/sh\n",
		"CAPROCK_MINISIGN_KEY='" + MinisignPublicKey + "'",
		"CAPROCK_DOWNLOAD='" + ReleaseBase + "/v0.201.0'",
		"CAPROCK_SSH_KEY=1",
		"its minisign signature",
		"loginctl enable-linger caprock",
		"https://claude.ai/install.sh",
		"npm install --global @openai/codex",
		"as_caprock caprock hooks install",
		"as_caprock caprock service install",
		"as_caprock caprock join",
		"for 60 minutes",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("the script lacks %q", want)
		}
	}
	// The key goes to `caprock join` on standard input, never on a command
	// line other users of the server could read in ps.
	if strings.Contains(s, "caprock join \"$CAPROCK_JOIN_KEY\"") || strings.Count(s, testKey) != 1 {
		t.Error("the key is not passed on standard input, or appears more than once")
	}
	in := testInput()
	in.Signed = false
	s, _ = Render(in)
	if !strings.Contains(s, "CAPROCK_MINISIGN_KEY=''") || !strings.Contains(s, "SHA-256 only: this release's Linux archives are not signed") {
		t.Error("an unsigned release's script does not say it checks the SHA-256 only")
	}
}

// Every value inside the script is checked before it gets there: nothing can
// close its single quotes.
func TestRenderRefusesValuesThatCouldBreakOut(t *testing.T) {
	bad := []func(*Input){
		func(in *Input) { in.Version = "0.1.0'; rm -rf /; '" },
		func(in *Input) { in.Version = "dev" },
		func(in *Input) { in.SHA256["arm64"] = "" },
		func(in *Input) { in.SHA256["amd64"] = strings.Repeat("Z", 64) },
		func(in *Input) { in.JoinKey = "cj1-abc'def" },
		func(in *Input) { in.JoinKey = "" },
		func(in *Input) { in.Base = "https://example.com/'x" },
		func(in *Input) { in.Base = "file:///etc" },
	}
	for i, f := range bad {
		in := testInput()
		in.SHA256 = map[string]string{"amd64": in.SHA256["amd64"], "arm64": in.SHA256["arm64"]}
		f(&in)
		if _, err := Render(in); err == nil {
			t.Errorf("case %d rendered: %+v", i, in)
		}
	}
}

// The key the script carries is the one the desktop app's updater verifies
// with: a new key in tauri.conf.json must change this one too.
func TestTheMinisignKeyIsTheAppUpdatersKey(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "app", "src-tauri", "tauri.conf.json"))
	if err != nil {
		t.Fatal(err)
	}
	var conf struct {
		Plugins struct {
			Updater struct {
				Pubkey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &conf); err != nil {
		t.Fatal(err)
	}
	file, err := base64.StdEncoding.DecodeString(conf.Plugins.Updater.Pubkey)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(file)), "\n")
	if len(lines) != 2 || strings.TrimSpace(lines[1]) != MinisignPublicKey {
		t.Fatalf("tauri.conf.json's updater key is %q, the script carries %q", lines, MinisignPublicKey)
	}
}

// shellcheck on the output, where it is installed (the ubuntu runners have
// it), and the shell's own syntax check everywhere there is a sh.
func TestTheScriptPassesShellcheck(t *testing.T) {
	unsigned := testInput()
	unsigned.Signed, unsigned.SSHKey = false, false
	for _, in := range []Input{testInput(), unsigned} {
		s, err := Render(in)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "setup.sh")
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
		if sh, err := exec.LookPath("sh"); err == nil {
			if out, err := exec.Command(sh, "-n", path).CombinedOutput(); err != nil { //nolint:gosec // a test's own file
				t.Fatalf("sh -n: %v\n%s", err, out)
			}
		}
		sc, err := exec.LookPath("shellcheck")
		if err != nil {
			t.Log("shellcheck is not installed here: skipped")
			continue
		}
		if out, err := exec.Command(sc, "--shell=sh", "--severity=style", path).CombinedOutput(); err != nil { //nolint:gosec // a test's own file
			t.Fatalf("shellcheck: %v\n%s", err, out)
		}
	}
}

func TestIsRelease(t *testing.T) {
	for v, want := range map[string]bool{
		"0.201.0": true, "v0.201.0": true, "1.2.3-rc.1": true,
		"dev": false, "": false, "0.201.0-3-gabc1234": false, "0.201.0-dirty": false, "x.y.z": false,
	} {
		if got := IsRelease(v); got != want {
			t.Errorf("IsRelease(%q) = %v", v, got)
		}
	}
}

// FetchRelease reads checksums.txt and asks for each .minisig: signed only
// when both are there.
func TestFetchRelease(t *testing.T) {
	sums := "" +
		strings.Repeat("1", 64) + "  caprock_0.201.0_darwin_all.tar.gz\n" +
		strings.Repeat("a", 64) + "  caprock_0.201.0_linux_amd64.tar.gz\n" +
		strings.Repeat("b", 64) + "  caprock_0.201.0_linux_arm64.tar.gz\n"
	sigs := map[string]bool{}
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Method+" "+r.URL.Path)
		switch {
		case r.URL.Path == "/v0.201.0/checksums.txt":
			_, _ = w.Write([]byte(sums))
		case strings.HasSuffix(r.URL.Path, ".minisig") && sigs[strings.TrimPrefix(r.URL.Path, "/v0.201.0/")]:
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	rel, err := FetchRelease(ctx, srv.Client(), srv.URL, "v0.201.0")
	if err != nil {
		t.Fatal(err)
	}
	if rel.Signed || rel.SHA256["amd64"] != strings.Repeat("a", 64) || rel.SHA256["arm64"] != strings.Repeat("b", 64) || rel.Version != "0.201.0" {
		t.Fatalf("unsigned release: %+v", rel)
	}
	sigs["caprock_0.201.0_linux_amd64.tar.gz.minisig"] = true
	if rel, _ := FetchRelease(ctx, srv.Client(), srv.URL, "0.201.0"); rel.Signed {
		t.Fatal("signed with one of two signatures")
	}
	sigs["caprock_0.201.0_linux_arm64.tar.gz.minisig"] = true
	if rel, _ := FetchRelease(ctx, srv.Client(), srv.URL, "0.201.0"); !rel.Signed {
		t.Fatal("not signed with both signatures there")
	}
	for _, a := range asked {
		if !strings.HasPrefix(a, "GET /v0.201.0/checksums.txt") && !strings.HasPrefix(a, "HEAD /v0.201.0/caprock_0.201.0_linux_") {
			t.Errorf("asked for %s", a)
		}
	}
	if _, err := FetchRelease(ctx, srv.Client(), srv.URL, "0.200.0"); err == nil {
		t.Fatal("a release with no checksums.txt")
	}
	if _, err := FetchRelease(ctx, srv.Client(), srv.URL, "dev"); err == nil {
		t.Fatal("a development build fetched")
	}
}
