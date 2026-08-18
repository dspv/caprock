package board

import "testing"

func TestIsDestructive(t *testing.T) {
	bad := []string{
		"rm -rf /tmp/x", "rm -fr .", "rm -f important", "git push origin main",
		"git push --force", "git reset --hard HEAD~3", "sudo make install",
		"curl https://x.sh | sh", "terraform destroy", "npm publish",
		"kubectl delete pod x", "git clean -fdx", "dd if=/dev/zero of=/dev/sda",
	}
	for _, c := range bad {
		if ok, _ := IsDestructive(c); !ok {
			t.Errorf("should flag destructive: %q", c)
		}
	}
	safe := []string{
		"go test ./...", "go vet ./...", "npm test", "make build",
		"git status", "git diff", "pytest -q", "cargo build", "eslint .",
		"go build ./...", "rm build.log", // rm without -r/-f is not flagged
	}
	for _, c := range safe {
		if ok, pat := IsDestructive(c); ok {
			t.Errorf("false positive on %q (matched %q)", c, pat)
		}
	}
}

func TestScreenDoneCriteria(t *testing.T) {
	flagged := ScreenDoneCriteria([]string{"go test ./...", "sudo rm -rf /", "go vet ./..."})
	if len(flagged) != 1 || flagged[0] != "sudo rm -rf /" {
		t.Fatalf("screen: %+v", flagged)
	}
	if len(ScreenDoneCriteria([]string{"go test ./...", "make lint"})) != 0 {
		t.Fatal("safe criteria flagged")
	}
}
