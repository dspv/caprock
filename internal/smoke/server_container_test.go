//go:build smoke && servercontainer && linux

package smoke

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The setup script on a real Debian with systemd, in a container (ADR-109
// P1, .ai/26-server.md): `make server-container-test` on a Linux machine
// with Docker, and ci.yml's server-container job on ubuntu-latest when its
// files change. Not in `make check`: it needs Docker, a privileged
// container running systemd and the distribution's package mirrors, and
// takes minutes. It installs no agent (CAPROCK_SETUP_SKIP_AGENTS=1: no
// Claude Code or Codex download, no sign-in).
//
// The computer the user works on is a daemon here, in a temp home, with a
// relay in this test; the release is this checkout built for Linux, served
// with its checksums.txt by a local file server. The container reaches both
// on its own loopback, through socat, because a ws:// relay must be on
// loopback (remote.CheckRelayURL) and the script turns a firewall on — in
// the container's own network namespace, never the host's.
func TestTheSetupScriptOnADebianServer(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("no docker")
	}
	image := os.Getenv("CAPROCK_SERVER_TEST_IMAGE")
	if image == "" {
		image = "debian:12"
	}
	const version = "0.0.0-servertest"
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	rel := filepath.Join(root, "release", "v"+version)
	mHome, mData := filepath.Join(root, "main-home"), filepath.Join(root, "main-data")
	for _, d := range []string{bin, rel, mHome, mData} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ld := "-X github.com/dspv/caprock/internal/version.Version=" + version
	build := func(goos, out, pkg string) {
		cmd := exec.Command("go", "build", "-ldflags", ld, "-o", out, pkg)
		cmd.Dir = "../.."
		cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+runtime.GOARCH, "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("go build %s: %v\n%s", pkg, err, b)
		}
	}
	caprock := filepath.Join(bin, "caprock")
	build(runtime.GOOS, caprock, "./cmd/caprock")
	linux := filepath.Join(root, "linux")
	for _, p := range []string{"caprock", "caprock-hook", "caprock-pty-host"} {
		build("linux", filepath.Join(linux, p), "./cmd/"+p)
	}
	// The archive as goreleaser lays it out, for this machine's arch; the
	// other arch's line in checksums.txt only has to exist.
	archive := fmt.Sprintf("caprock_%s_linux_%s.tar.gz", version, runtime.GOARCH)
	sum := writeArchive(t, filepath.Join(rel, archive), linux, "caprock", "caprock-hook", "caprock-pty-host")
	other := map[string]string{"amd64": "arm64", "arm64": "amd64"}[runtime.GOARCH]
	sums := sum + "  " + archive + "\n" + strings.Repeat("0", 64) + fmt.Sprintf("  caprock_%s_linux_%s.tar.gz\n", version, other)
	if err := os.WriteFile(filepath.Join(rel, "checksums.txt"), []byte(sums), 0o600); err != nil {
		t.Fatal(err)
	}

	// Both listen on every address, so the container reaches them through
	// the bridge; the daemon here dials the relay on loopback.
	files := listenAll(t)
	go func() { _ = http.Serve(files, http.FileServer(http.Dir(filepath.Join(root, "release")))) }()
	relay := startRelay(t, "0.0.0.0:0")
	_, relayPort, _ := net.SplitHostPort(relay.addr)
	_, filePort, _ := net.SplitHostPort(files.Addr().String())
	relayURL := "ws://127.0.0.1:" + relayPort

	mPort := freePort(t)
	mBase := "http://127.0.0.1:" + strconv.Itoa(mPort)
	mEnv := append(daemonEnv(bin, mHome, mData), "CAPROCK_TEST_RELEASE_BASE=http://127.0.0.1:"+filePort)
	main := startBinary(t, caprock, mEnv, mPort, mData, "main")
	post(t, mBase+"/v1/pair/remote", `{"on":false,"relay":"`+relayURL+`"}`)

	var made struct {
		Script string `json:"script"`
		State  string `json:"state"`
		Server bool   `json:"server"`
	}
	if code := callJSON(t, "POST", mBase+"/v1/machines/server-script", `{"ssh_key":false}`, &made); code != 200 || !made.Server {
		t.Fatalf("server-script: %d %+v\n%s", code, made, main.log())
	}
	script := filepath.Join(root, "caprock-setup.sh")
	if err := os.WriteFile(script, []byte(made.Script), 0o600); err != nil {
		t.Fatal(err)
	}

	// A Debian with systemd as PID 1, as a cloud server boots.
	name := fmt.Sprintf("caprock-servertest-%d", time.Now().UnixNano())
	run := func(timeout time.Duration, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		b, err := exec.CommandContext(ctx, docker, args...).CombinedOutput() //nolint:gosec // the test's own argv
		return string(b), err
	}
	boot := "apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus socat ca-certificates && exec /sbin/init"
	if out, err := run(10*time.Minute, "run", "-d", "--name", name, "--privileged", "--cgroupns=host",
		"-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--tmpfs", "/run", "--tmpfs", "/run/lock",
		"--add-host=host.docker.internal:host-gateway", image, "sh", "-c", boot); err != nil {
		t.Fatalf("docker run: %v\n%s", err, out)
	}
	t.Cleanup(func() { _, _ = run(time.Minute, "rm", "-f", name) })
	deadline := time.Now().Add(10 * time.Minute)
	for {
		out, _ := run(30*time.Second, "exec", name, "systemctl", "is-system-running")
		if s := strings.TrimSpace(out); s == "running" || s == "degraded" {
			break
		}
		if time.Now().After(deadline) {
			logs, _ := run(time.Minute, "logs", name)
			t.Fatalf("systemd never came up in the container: %q\n%s", out, logs)
		}
		time.Sleep(2 * time.Second)
	}
	for _, port := range []string{relayPort, filePort} {
		if out, err := run(time.Minute, "exec", "-d", name, "socat",
			"TCP-LISTEN:"+port+",bind=127.0.0.1,fork,reuseaddr", "TCP:host.docker.internal:"+port); err != nil {
			t.Fatalf("socat: %v\n%s", err, out)
		}
	}
	if out, err := run(time.Minute, "cp", script, name+":/root/caprock-setup.sh"); err != nil {
		t.Fatalf("docker cp: %v\n%s", err, out)
	}

	out, err := run(20*time.Minute, "exec", "-e", "CAPROCK_SETUP_SKIP_AGENTS=1", name, "sh", "/root/caprock-setup.sh")
	if err != nil {
		t.Fatalf("the script failed: %v\n%s\nmain log:\n%s", err, out, main.log())
	}
	for _, want := range []string{"==> caprock setup: check the system", "SHA-256: good", "caprock " + version, "Joined.", "==> caprock setup: done"} {
		if !strings.Contains(out, want) {
			t.Errorf("the script did not print %q:\n%s", want, out)
		}
	}

	// The laptop: joined, and the server reachable through the relay.
	var after struct {
		State string `json:"state"`
	}
	getJSONAt(t, mBase+"/v1/machines/join-key", &after)
	var list struct {
		Machines []machineStatus `json:"machines"`
	}
	if code := callJSON(t, "GET", mBase+"/v1/machines?check=1", "", &list); after.State != "joined" || code != 200 || len(list.Machines) != 1 || list.Machines[0].Status != "online" {
		t.Fatalf("after the script: key %q, machines %d %+v\nmain log:\n%s", after.State, code, list, main.log())
	}

	// What the script set up on the server, read back.
	checks := map[string]string{
		"lingering":         "loginctl show-user caprock --property=Linger --value",
		"no sudo":           "! id -nG caprock | tr ' ' '\\n' | grep -qx sudo",
		"firewall":          "ufw status | grep -q 'Status: active'",
		"unattended":        "grep -q 'Unattended-Upgrade \"1\"' /etc/apt/apt.conf.d/20auto-upgrades",
		"the service":       "runuser -u caprock -- env XDG_RUNTIME_DIR=/run/user/$(id -u caprock) systemctl --user is-active caprock.service",
		"no key in caprock": "! grep -rlF '" + strings.TrimPrefix(keyIn(made.Script), "cj1-") + "' /home/caprock",
	}
	for what, cmd := range checks {
		if out, err := run(time.Minute, "exec", name, "sh", "-c", cmd); err != nil {
			t.Errorf("%s: %v\n%s", what, err, out)
		}
	}

	// The key is in no log or file on the laptop.
	jk := strings.TrimPrefix(keyIn(made.Script), "cj1-")
	if jk == "" || strings.Contains(main.log(), jk) {
		t.Fatal("no key in the script, or the daemon logged it")
	}
	_ = filepath.WalkDir(mData, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // a file that vanished mid-walk holds nothing
		}
		if raw, err := os.ReadFile(p); err == nil && strings.Contains(string(raw), jk) {
			t.Errorf("%s holds the key", p)
		}
		return nil
	})
	relay.stop()
	main.stop(t, true)
}

// keyIn is the join key a script carries.
func keyIn(script string) string {
	const pre = "CAPROCK_JOIN_KEY='"
	i := strings.Index(script, pre)
	if i < 0 {
		return ""
	}
	rest := script[i+len(pre):]
	return rest[:strings.IndexByte(rest, '\'')]
}

func listenAll(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	return ln
}

// writeArchive writes a tar.gz of names from dir at its root, and answers
// its SHA-256.
func writeArchive(t *testing.T, path, dir string, names ...string) string {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(f, h))
	tw := tar.NewWriter(gz)
	for _, n := range names {
		raw, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if err := tw.WriteHeader(&tar.Header{Name: n, Mode: 0o755, Size: int64(len(raw)), ModTime: time.Unix(0, 0)}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(raw); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []io.Closer{tw, gz, f} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

