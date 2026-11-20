package readiness

import (
	"encoding/base64"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"unicode/utf16"
)

// encodePS is a script as -EncodedCommand takes it: UTF-16LE, base64.
func encodePS(s string) string {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 0, 2*len(u))
	for _, r := range u {
		b = append(b, byte(r), byte(r>>8))
	}
	return base64.StdEncoding.EncodeToString(b)
}

// The Windows PATH fix is PowerShell typed into a shell tab. It is run here,
// on the Windows CI job, with the two registry calls swapped for a variable
// and an echo, so its quoting and its logic are checked by PowerShell itself
// and no Path anywhere is read or written.
func TestWindowsPathFixRunsInPowerShell(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PowerShell's parser is on Windows")
	}
	ps, err := exec.LookPath("powershell.exe")
	if err != nil {
		if ps, err = exec.LookPath("pwsh.exe"); err != nil {
			t.Skip("no PowerShell")
		}
	}
	cmd := PathFix("windows", "")
	get := "[Environment]::GetEnvironmentVariable('Path','User')"
	set := "[Environment]::SetEnvironmentVariable('Path', "
	if !strings.Contains(cmd, get) || !strings.Contains(cmd, set) || !strings.HasSuffix(cmd, ", 'User') }") {
		t.Fatalf("the command changed shape; update this test: %q", cmd)
	}
	dry := strings.Replace(cmd, get, "$env:FAKE_USER_PATH", 1)
	dry = strings.Replace(dry, set, "Write-Output (", 1)
	dry = strings.TrimSuffix(dry, ", 'User') }") + ") }"
	const profile = `C:\Users\test`
	dir := profile + `\.local\bin`
	for _, c := range []struct{ name, path, want string }{
		{"appended", `C:\a;C:\b`, `C:\a;C:\b;` + dir},
		{"a trailing ; is not doubled", `C:\a;`, `C:\a;` + dir},
		{"empty", "", dir},
		{"already there", `C:\a;` + dir, ""},
		{"already there, other case", `C:\a;` + strings.ToUpper(dir), ""},
	} {
		// Encoded: a command line's own quoting would be tested otherwise, not
		// what a person types at the prompt.
		run := exec.Command(ps, "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePS(dry))
		run.Env = append(os.Environ(), "USERPROFILE="+profile, "FAKE_USER_PATH="+c.path)
		out, err := run.CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", c.name, err, out)
		}
		if got := strings.TrimSpace(string(out)); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}
