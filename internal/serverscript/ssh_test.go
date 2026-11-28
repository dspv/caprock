package serverscript

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// Sent as ssh's standard input to sh -s, a step that reads standard input
// (apt, npm, an installer) gets nothing, and the steps after it still run.
func TestTheStepsSurviveAStepThatReadsStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh")
	}
	script := "#!/bin/sh\nX=1\n" + group("\nset -eu\ncat\necho \"end $X\"\n") + "echo after\n"
	cmd := exec.Command("sh", "-s")
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	if err != nil || string(out) != "end 1\nafter\n" {
		t.Fatalf("%v: %q", err, out)
	}
}

// The address, user and port are typed into a terminal: nothing in them may
// be read by a shell or by ssh as anything else.
func TestTheSSHTargetRefusesInjection(t *testing.T) {
	bad := []SSHTarget{
		{Address: "1.2.3.4; rm -rf /", User: "root"},
		{Address: "1.2.3.4 -oProxyCommand=sh", User: "root"},
		{Address: "-oProxyCommand=touch /tmp/x", User: "root"},
		{Address: "host'name", User: "root"},
		{Address: `host"name`, User: "root"},
		{Address: "$(id)", User: "root"},
		{Address: "`id`", User: "root"},
		{Address: "a|b", User: "root"},
		{Address: "a&b", User: "root"},
		{Address: "a>b", User: "root"},
		{Address: "user@host", User: "root"},
		{Address: "host:22", User: "root"},
		{Address: "fe80::1%eth0", User: "root"},
		{Address: "[2001:db8::1]", User: "root"},
		{Address: "::ffff:1.2.3.4", User: "root"},
		{Address: "host\nname", User: "root"},
		{Address: "", User: "root"},
		{Address: strings.Repeat("a", 254), User: "root"},
		{Address: "1.2.3.4", User: "root; id"},
		{Address: "1.2.3.4", User: "-oProxyCommand=x"},
		{Address: "1.2.3.4", User: "Root"},
		{Address: "1.2.3.4", User: "ro ot"},
		{Address: "1.2.3.4", User: ""},
		{Address: "1.2.3.4", User: "root", Port: -1},
		{Address: "1.2.3.4", User: "root", Port: 65536},
	}
	for _, b := range bad {
		if err := b.Check(); err == nil {
			t.Errorf("accepted %+v", b)
		}
		if _, err := SSHCommand("linux", b, "/tmp/s.sh"); err == nil {
			t.Errorf("made a command for %+v", b)
		}
	}
	for _, ok := range []SSHTarget{
		{Address: "1.2.3.4", User: "root"},
		{Address: "server-1.example.com", User: "deploy", Port: 2222},
		{Address: "2001:db8::1", User: "ubuntu"},
		{Address: "a", User: "_svc"},
	} {
		if err := ok.Check(); err != nil {
			t.Errorf("refused %+v: %v", ok, err)
		}
	}
}

// The command as each system's terminal takes it, for root (one login) and
// for another user (scp, then sudo with a terminal).
func TestTheSSHCommandPerSystem(t *testing.T) {
	root := SSHTarget{Address: "1.2.3.4", User: "root"}
	user := SSHTarget{Address: "2001:db8::1", User: "deploy", Port: 2222}
	for _, c := range []struct {
		goos, path string
		target     SSHTarget
		want       string
	}{
		{"darwin", "/Users/a b/Library/x.sh", root, `ssh -p 22 root@1.2.3.4 'sh -s' < '/Users/a b/Library/x.sh'`},
		{"linux", "/home/a/.local/share/caprock/x.sh", root, `ssh -p 22 root@1.2.3.4 'sh -s' < '/home/a/.local/share/caprock/x.sh'`},
		{"windows", `C:\Users\a b\AppData\x.sh`, root, `cmd --% /c ssh -p 22 root@1.2.3.4 "sh -s" < "C:\Users\a b\AppData\x.sh"`},
		{"linux", "/s.sh", user, `scp -P 2222 '/s.sh' deploy@[2001:db8::1]:caprock-setup.sh && ssh -t -p 2222 deploy@2001:db8::1 'sudo sh caprock-setup.sh; rm -f caprock-setup.sh'`},
		{"windows", `C:\s.sh`, user, `scp -P 2222 "C:\s.sh" deploy@[2001:db8::1]:caprock-setup.sh; if ($?) { ssh -t -p 2222 deploy@2001:db8::1 'sudo sh caprock-setup.sh; rm -f caprock-setup.sh' }`},
	} {
		got, err := SSHCommand(c.goos, c.target, c.path)
		if err != nil || got != c.want {
			t.Errorf("%s %+v:\n got %s (%v)\nwant %s", c.goos, c.target, got, err, c.want)
		}
	}
	if _, err := SSHCommand("linux", root, "/tmp/it's.sh"); err == nil {
		t.Error("a path with a single quote was quoted for sh")
	}
	if _, err := SSHCommand("windows", root, `C:\"x".sh`); err == nil {
		t.Error("a path with a double quote was quoted for cmd")
	}
}

// The script crosses ssh byte for byte: plain ASCII, Unix line endings.
func TestTheScriptIsASCIIWithUnixLineEndings(t *testing.T) {
	s, err := Render(testInput())
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range s {
		if r > 126 || (r < 32 && r != '\n' && r != '\t') {
			t.Fatalf("byte %d is %q", i, r)
		}
	}
}
