//go:build smoke

package smoke

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ADR-109 P1 end to end, short of a server: the computer the user works on
// makes a server's setup script (`caprock machines server-script`, its
// release's checksums read from a local stand-in for GitHub), the key inside
// is open for an hour, and the new computer joins with it the way the script
// does, the key on standard input. Afterwards the key is in no log or file
// on either side. Running the whole script on a Debian server is the
// container test (internal/serverscript, build tag servercontainer).
func TestTwoDaemonsJoinWithAServerScript(t *testing.T) {
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	bin := filepath.Join(root, "bin")
	nHome, nData := filepath.Join(root, "new-home"), filepath.Join(root, "new-data")
	mHome, mData := filepath.Join(root, "main-home"), filepath.Join(root, "main-data")
	for _, d := range []string{bin, nHome, nData, mHome, mData} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	// A release version, so the script names it rather than asking GitHub
	// for the latest.
	const version = "0.0.0-smoke"
	caprock := filepath.Join(bin, "caprock"+exe)
	build := exec.Command("go", "build", "-ldflags", "-X github.com/dspv/caprock/internal/version.Version="+version, "-o", caprock, "./cmd/caprock")
	build.Dir = "../.."
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	t.Cleanup(func() {
		killHolders(t, nData)
		killHolders(t, mData)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	// GitHub's release downloads, as far as the script maker reads them.
	var asked []string
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/v"+version+"/checksums.txt" {
			_, _ = w.Write([]byte(strings.Repeat("a", 64) + "  caprock_" + version + "_linux_amd64.tar.gz\n" +
				strings.Repeat("b", 64) + "  caprock_" + version + "_linux_arm64.tar.gz\n"))
			return
		}
		http.NotFound(w, r)
	}))
	defer gh.Close()

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr
	nPort, mPort := freePort(t), freePort(t)
	mBase := "http://127.0.0.1:" + strconv.Itoa(mPort)
	nEnv := daemonEnv(bin, nHome, nData)
	mEnv := append(daemonEnv(bin, mHome, mData), "CAPROCK_TEST_RELEASE_BASE="+gh.URL)
	newer := startBinary(t, caprock, nEnv, nPort, nData, "new")
	main := startBinary(t, caprock, mEnv, mPort, mData, "main")
	post(t, mBase+"/v1/pair/remote", `{"on":false,"relay":"`+relayURL+`"}`)

	// I already have a server: the script saved to a 0600 file under the
	// data directory, the command reading it, and the file gone once a new
	// key replaces its own.
	var viaSSH struct {
		Command string `json:"command"`
		OS      string `json:"os"`
		Server  bool   `json:"server"`
	}
	if code := callJSON(t, "POST", mBase+"/v1/machines/server-ssh", `{"address":"203.0.113.7","user":"root","port":2222}`, &viaSSH); code != 200 || !viaSSH.Server || viaSSH.OS != runtime.GOOS {
		t.Fatalf("server-ssh: %d %+v\nmain log:\n%s", code, viaSSH, main.log())
	}
	quote := "'"
	if runtime.GOOS == "windows" {
		quote = `"`
	}
	parts := strings.Split(viaSSH.Command, quote)
	saved := parts[len(parts)-2]
	if !strings.HasPrefix(viaSSH.Command, "ssh -p 2222 root@203.0.113.7") && !strings.HasPrefix(viaSSH.Command, "cmd --% /c ssh -p 2222 root@203.0.113.7") {
		t.Fatalf("the command: %s", viaSSH.Command)
	}
	if filepath.Dir(saved) != filepath.Join(mData, "server-scripts") {
		t.Fatalf("the script is at %s, not under the data directory", saved)
	}
	fi, err := os.Stat(saved)
	if err != nil {
		t.Fatalf("the saved script: %v", err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Fatalf("the saved script is %v", fi.Mode().Perm())
	}
	if raw, _ := os.ReadFile(saved); !strings.Contains(string(raw), "CAPROCK_SSH_KEY=1") || !strings.Contains(string(raw), "CAPROCK_JOIN_KEY='cj1-") {
		t.Fatalf("the saved script keeps SSH on and holds a key:\n%s", raw)
	}

	made := time.Now()
	out := runCLI(t, caprock, mEnv, "machines", "server-script", "--ssh-key")
	m := regexp.MustCompile(`CAPROCK_JOIN_KEY='(cj1-[A-Za-z0-9_-]+)'`).FindStringSubmatch(out)
	if m == nil || !strings.HasPrefix(out, "#!/bin/sh\n") {
		t.Fatalf("`caprock machines server-script` printed:\n%s\nmain log:\n%s", out, main.log())
	}
	key := m[1]
	for _, want := range []string{
		"CAPROCK_VERSION='" + version + "'",
		"CAPROCK_DOWNLOAD='" + gh.URL + "/v" + version + "'",
		"CAPROCK_SHA256_AMD64='" + strings.Repeat("a", 64) + "'",
		"CAPROCK_MINISIGN_KEY=''", // the stand-in has no .minisig
		"CAPROCK_SSH_KEY=1",
		"checked by SHA-256 only",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the script or its note lacks %q", want)
		}
	}
	var desk struct {
		State       string `json:"state"`
		Server      bool   `json:"server"`
		ExpiresAt   int64  `json:"expires_at"`
		RelayStatus string `json:"relay_status"`
	}
	deadline := time.Now().Add(30 * time.Second)
	for desk.RelayStatus != "online" {
		if time.Now().After(deadline) {
			t.Fatalf("the key's rendezvous never reached the relay: %+v\nmain log:\n%s", desk, main.log())
		}
		getJSONAt(t, mBase+"/v1/machines/join-key", &desk)
		time.Sleep(100 * time.Millisecond)
	}
	if left := time.UnixMilli(desk.ExpiresAt).Sub(made); !desk.Server || left < 59*time.Minute || left > 61*time.Minute {
		t.Fatalf("the server key: %+v, open for %s", desk, left)
	}
	// The new script's key replaced the ssh one: its file goes.
	for gone := time.Now().Add(30 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if _, err := os.Stat(saved); os.IsNotExist(err) {
			break
		}
		if time.Now().After(gone) {
			t.Fatalf("the ssh script outlived its key: %s", saved)
		}
	}

	// On the new computer, as the script's last step: the key on stdin.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	join := exec.CommandContext(ctx, caprock, "join")
	join.Env = nEnv
	join.Stdin = strings.NewReader(key + "\n")
	b, err := join.CombinedOutput()
	cancel()
	if err != nil || !strings.Contains(string(b), "Joined.") {
		t.Fatalf("`caprock join` with the key on stdin: %v\n%s\nnew log:\n%s\nmain log:\n%s", err, b, newer.log(), main.log())
	}
	var after struct {
		State string `json:"state"`
	}
	getJSONAt(t, mBase+"/v1/machines/join-key", &after)
	if after.State != "joined" {
		t.Fatalf("the key after the join: %+v", after)
	}
	for _, a := range asked {
		if a != "GET /v"+version+"/checksums.txt" && !strings.HasPrefix(a, "HEAD /v"+version+"/caprock_"+version+"_linux_") {
			t.Errorf("the script maker asked the release host for %s", a)
		}
	}

	jk := strings.TrimPrefix(key, "cj1-")
	if strings.Contains(main.log(), jk) || strings.Contains(newer.log(), jk) {
		t.Fatal("a daemon logged the key")
	}
	for _, dir := range []string{mData, nData} {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil //nolint:nilerr // a file that vanished mid-walk holds nothing
			}
			if raw, err := os.ReadFile(p); err == nil && strings.Contains(string(raw), jk) {
				t.Errorf("%s holds the key", p)
			}
			return nil
		})
	}
	relay.stop()
	main.stop(t, true)
	newer.stop(t, true)
}
