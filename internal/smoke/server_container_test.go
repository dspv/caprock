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

// The setup script on a real Ubuntu or Debian with systemd, in a container
// (CAPROCK_SERVER_IMAGE, debian:12 when unset; CI runs ubuntu:24.04 and
// debian:12: Hetzner's and DigitalOcean's default, and the other supported
// family; ADR-109 P1, .ai/26-server.md): `make server-container-test` on a Linux machine
// with Docker, and ci.yml's server-container job on ubuntu-latest when its
// files change. Not in `make check`: it needs Docker, a privileged
// container running systemd and the distribution's package mirrors, and
// takes minutes. It installs the agents for real (Claude Code with
// Anthropic's installer, Codex from npm) and signs in to neither, then
// asserts the "Caprock native" promise of .ai/26-server.md item by item.
//
// The computer the user works on is a daemon here, in a temp home, with a
// relay in this test; the release is this checkout built for Linux, served
// with its checksums.txt by a local file server. The container reaches both
// on its own loopback, through socat, because a ws:// relay must be on
// loopback (remote.CheckRelayURL) and the script turns a firewall on — in
// the container's own network namespace, never the host's.
func TestTheSetupScriptOnALinuxServer(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("no docker")
	}
	image := os.Getenv("CAPROCK_SERVER_IMAGE")
	if image == "" {
		image = "debian:12"
	}
	// CAPROCK_SERVER_VIA=ssh is I already have a server, as a customer's
	// email has it: root with a password, the command Caprock types run as it
	// is, ssh asking for the password (here through SSH_ASKPASS), and the
	// script turning password login off while keeping the session it runs in.
	viaSSH := os.Getenv("CAPROCK_SERVER_VIA") == "ssh"
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
	script := filepath.Join(root, "caprock-setup.sh")
	if !viaSSH {
		if code := callJSON(t, "POST", mBase+"/v1/machines/server-script", `{"ssh_key":false}`, &made); code != 200 || !made.Server {
			t.Fatalf("server-script: %d %+v\n%s", code, made, main.log())
		}
		if err := os.WriteFile(script, []byte(made.Script), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Ubuntu or Debian with systemd as PID 1, as a cloud server boots; the same
	// packages and boot on both images.
	name := fmt.Sprintf("caprock-servertest-%d", time.Now().UnixNano())
	run := func(timeout time.Duration, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		b, err := exec.CommandContext(ctx, docker, args...).CombinedOutput() //nolint:gosec // the test's own argv
		return string(b), err
	}
	// A cloud image has what logind needs to run a user manager on linger:
	// libpam-systemd (systemd only recommends it) and the user bus. A bare
	// container image has neither, so they are installed here, not by the script
	// (systemd-pam is the Red Hat family's pam_systemd). The almalinux:9 image
	// also masks systemd-logind, which no server install does: unmasked here.
	boot := "if command -v apt-get >/dev/null; then " +
		"apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd socat ca-certificates; " +
		"else dnf -y install systemd systemd-pam dbus socat procps-ng && systemctl --root=/ unmask systemd-logind.service; fi && exec /sbin/init"
	runArgs := []string{"run", "-d", "--name", name, "--privileged", "--cgroupns=host",
		"-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--tmpfs", "/run", "--tmpfs", "/run/lock",
		"--add-host=host.docker.internal:host-gateway"}
	if viaSSH {
		runArgs = append(runArgs, "-p", "127.0.0.1::22")
	}
	if out, err := run(10*time.Minute, append(runArgs, image, "sh", "-c", boot)...); err != nil {
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
	var out, sshPort, saved string
	var sshAs func(timeout time.Duration, command string) (string, error)
	if viaSSH {
		// The rented server as a provider hands it over: sshd on, root with
		// a password, password login allowed by a drop-in named as
		// cloud-init names its own.
		const password = "Tr0ub4dor-servertest"
		sshd := "if command -v apt-get >/dev/null; then apt-get install -y --no-install-recommends openssh-server; " +
			"else dnf -y install openssh-server shadow-utils; fi && mkdir -p /etc/ssh/sshd_config.d && " +
			"printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' >/etc/ssh/sshd_config.d/50-cloud-init.conf && " +
			"echo 'root:" + password + "' | chpasswd && " +
			"{ systemctl enable --now ssh.service 2>/dev/null || systemctl enable --now sshd.service; } && " +
			"{ systemctl restart ssh.service 2>/dev/null || systemctl restart sshd.service; }"
		if o, err := run(10*time.Minute, "exec", name, "sh", "-c", sshd); err != nil {
			t.Fatalf("sshd in the container: %v\n%s", err, o)
		}
		p, err := run(time.Minute, "port", name, "22/tcp")
		if err != nil {
			t.Fatalf("docker port: %v\n%s", err, p)
		}
		_, sshPort, _ = strings.Cut(strings.Fields(p)[0], ":")
		// ssh as a person runs it, but with no known_hosts or keys of the
		// runner's, and the password from SSH_ASKPASS for the prompt.
		tools := filepath.Join(root, "ssh-tools")
		if err := os.MkdirAll(tools, 0o700); err != nil {
			t.Fatal(err)
		}
		realSSH, err := exec.LookPath("ssh")
		if err != nil {
			t.Fatal("no ssh client on this machine")
		}
		files := map[string]string{
			"ssh": "#!/bin/sh\nexec " + realSSH + " -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null " +
				"-o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1 \"$@\"\n",
			"askpass": "#!/bin/sh\necho '" + password + "'\n",
		}
		for f, body := range files {
			if err := os.WriteFile(filepath.Join(tools, f), []byte(body), 0o700); err != nil { //nolint:gosec // the test's own tools
				t.Fatal(err)
			}
		}
		sshAs = func(timeout time.Duration, command string) (string, error) {
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			c := exec.CommandContext(ctx, "sh", "-c", command) //nolint:gosec // Caprock's own command, under test
			c.Env = append(os.Environ(), "PATH="+tools+":"+os.Getenv("PATH"),
				"SSH_ASKPASS="+filepath.Join(tools, "askpass"), "SSH_ASKPASS_REQUIRE=force", "DISPLAY=:0")
			b, err := c.CombinedOutput()
			return string(b), err
		}
		// Before: the password works.
		if o, err := sshAs(time.Minute, "ssh -p "+sshPort+" root@127.0.0.1 true"); err != nil {
			t.Fatalf("the password login before the script: %v\n%s", err, o)
		}

		var ssh struct {
			Command string `json:"command"`
			Server  bool   `json:"server"`
		}
		if code := callJSON(t, "POST", mBase+"/v1/machines/server-ssh", `{"address":"127.0.0.1","user":"root","port":`+sshPort+`}`, &ssh); code != 200 || !ssh.Server {
			t.Fatalf("server-ssh: %d %+v\n%s", code, ssh, main.log())
		}
		want := "ssh -p " + sshPort + " root@127.0.0.1 'sh -s' < '"
		if !strings.HasPrefix(ssh.Command, want) {
			t.Fatalf("the typed command: %s", ssh.Command)
		}
		saved = strings.TrimSuffix(strings.TrimPrefix(ssh.Command, want), "'")
		raw, err := os.ReadFile(saved)
		if err != nil {
			t.Fatalf("the saved script: %v", err)
		}
		made.Script = string(raw)
		t.Logf("running, as the user would press Enter: %s", ssh.Command)
		out, err = sshAs(35*time.Minute, ssh.Command)
		if err != nil {
			t.Fatalf("the script over ssh failed: %v\n%s\nmain log:\n%s", err, out, main.log())
		}
	} else {
		if o, err := run(time.Minute, "cp", script, name+":/root/caprock-setup.sh"); err != nil {
			t.Fatalf("docker cp: %v\n%s", err, o)
		}
		var err error
		out, err = run(35*time.Minute, "exec", name, "sh", "/root/caprock-setup.sh")
		if err != nil {
			t.Fatalf("the script failed: %v\n%s\nmain log:\n%s", err, out, main.log())
		}
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
	// Native: the same Caprock as the laptop's.
	if v := list.Machines[0].Version; v != version {
		t.Errorf("the server runs Caprock %q, the laptop %q", v, version)
	}

	// What the script set up on the server, read back.
	// The "Caprock native" checklist (.ai/26-server.md), as root on the server.
	asCaprock := "runuser -u caprock -- env -i HOME=/home/caprock PATH=/home/caprock/.local/bin:/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u caprock) "
	checks := map[string]string{
		"claude":            asCaprock + "claude --version",
		"codex":             asCaprock + "codex --version",
		"git":               asCaprock + "git --version",
		"node 20+":          asCaprock + "node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 20 ? 0 : 1)'",
		"headless chromium": asCaprock + "caprock-chromium --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>native-ok</p>' 2>/dev/null | grep -q native-ok",
		"caprock version":   "/usr/local/bin/caprock version | grep -qF 'caprock " + version + " '",
		"lingering":         "loginctl show-user caprock --property=Linger --value | grep -qx yes",
		"no sudo":           "! id -nG caprock | tr ' ' '\\n' | grep -qxE 'sudo|wheel'",
		"firewall":          "if command -v ufw >/dev/null; then ufw status | grep -q 'Status: active'; else firewall-cmd --get-default-zone | grep -qx drop; fi",
		"unattended":        "grep -qs 'Unattended-Upgrade \"1\"' /etc/apt/apt.conf.d/20auto-upgrades || grep -qs '^apply_updates = yes' /etc/dnf/automatic.conf",
		"the service":       "runuser -u caprock -- env XDG_RUNTIME_DIR=/run/user/$(id -u caprock) systemctl --user is-active caprock.service",
		"no key in caprock": "! grep -rlF '" + strings.TrimPrefix(keyIn(made.Script), "cj1-") + "' /home/caprock",
	}
	for what, cmd := range checks {
		if out, err := run(2*time.Minute, "exec", name, "sh", "-c", cmd); err != nil {
			t.Errorf("%s: %v\n%s", what, err, out)
		}
	}
	// No inbound port: with no SSH chosen, every listening TCP socket is on
	// loopback (the daemon, the test's socat). The firewall check above
	// covers what is not a TCP listener.
	tcp, err := run(time.Minute, "exec", name, "cat", "/proc/net/tcp", "/proc/net/tcp6")
	if err != nil {
		t.Fatalf("read /proc/net/tcp: %v\n%s", err, tcp)
	}
	var open []string
	for _, o := range openPorts(tcp) {
		if !viaSSH || !strings.HasSuffix(o, ":0016") { // 22, sshd, kept on over SSH
			open = append(open, o)
		}
	}
	if len(open) > 0 {
		t.Errorf("listening off loopback: %v\n%s", open, tcp)
	}

	if viaSSH {
		// sshd still on, keys only: the password the provider gave no longer
		// logs in, and the script's file on the laptop is gone with its key.
		if o, err := run(time.Minute, "exec", name, "sh", "-c", "systemctl is-active ssh.service || systemctl is-active sshd.service"); err != nil {
			t.Errorf("sshd after the script: %v\n%s", err, o)
		}
		if o, err := sshAs(time.Minute, "ssh -p "+sshPort+" root@127.0.0.1 true"); err == nil {
			t.Errorf("the password still logs in after the script:\n%s", o)
		}
		for gone := time.Now().Add(30 * time.Second); ; time.Sleep(500 * time.Millisecond) {
			if _, err := os.Stat(saved); os.IsNotExist(err) {
				break
			}
			if time.Now().After(gone) {
				t.Errorf("the saved script outlived its key: %s", saved)
				break
			}
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

// openPorts lists the listening TCP sockets in /proc/net/tcp{,6} text that
// are not on loopback, as hex address:port.
func openPorts(procNet string) []string {
	var open []string
	for _, line := range strings.Split(procNet, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[3] != "0A" { // 0A: LISTEN
			continue
		}
		addr, _, ok := strings.Cut(f[1], ":")
		if !ok {
			continue
		}
		switch {
		case len(addr) == 8 && strings.HasSuffix(addr, "7F"): // 127.x.x.x, little-endian
		case addr == "00000000000000000000000001000000": // ::1
		case len(addr) == 32 && strings.HasPrefix(addr, "0000000000000000FFFF0000") && strings.HasSuffix(addr, "7F"): // ::ffff:127.x
		default:
			open = append(open, f[1])
		}
	}
	return open
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
