package serverscript

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// I already have a server (ADR-109, amended 2026-11-28): the user's own ssh,
// in a terminal tab on the computer they work on, typed and not run. The
// command sends the setup script, saved by the daemon to a 0600 file, to the
// server; ssh asks for whatever it asks (a host key, a password, a key's
// passphrase) in that terminal, and Caprock never sees the answer.

// SSHTarget is the server as the user names it.
type SSHTarget struct {
	// Address is an IPv4 or IPv6 address or a host name.
	Address string `json:"address"`
	// User is who ssh logs in as: root, or a user with sudo.
	User string `json:"user"`
	// Port is sshd's port; 0 is 22.
	Port int `json:"port,omitempty"`
}

var (
	hostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	userRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
)

// Errors the form tells apart.
var (
	ErrBadAddress = errors.New("the address is an IP address or a host name: letters, digits, dots and hyphens (an IPv6 address: hex digits and colons), nothing else")
	ErrBadUser    = errors.New("the user is a Linux user name: lowercase letters, digits, _ and -, starting with a letter or _")
	ErrBadPort    = errors.New("the port is a number from 1 to 65535")
)

// Check accepts only what cannot be read as anything but an address, a user
// and a port by a shell or by ssh: no spaces, quotes, ;, $, `, a leading -
// (an ssh option), @ or : outside an IPv6 address.
func (t SSHTarget) Check() error {
	a := t.Address
	switch {
	case strings.Contains(a, ":"):
		ip := net.ParseIP(a)
		if ip == nil || ip.To4() != nil || strings.ContainsAny(a, "%[]") {
			return ErrBadAddress
		}
	case !hostRe.MatchString(a):
		return ErrBadAddress
	}
	if !userRe.MatchString(t.User) {
		return ErrBadUser
	}
	if t.Port < 0 || t.Port > 65535 {
		return ErrBadPort
	}
	return nil
}

// RemoteScript is where the two-step command (a user who is not root) puts
// the script on the server, in that user's home, removed after it runs.
const RemoteScript = "caprock-setup.sh"

// SSHCommand is the command typed into the terminal tab, for the shell that
// tab runs on goos: sh-like on macOS and Linux (bash, zsh, fish), PowerShell
// on Windows (Caprock's shell tab there, agents.windowsShell).
//
//   - root: the script on ssh's standard input, `sh -s` on the server, one
//     login. PowerShell's pipe rewrites line endings and encoding, so on
//     Windows the redirection is cmd's (`cmd --% /c …`, PowerShell passing
//     the rest untouched), byte for byte.
//   - another user: sudo needs a terminal for its password, which standard
//     input cannot be, so the script is copied with scp first and run with
//     `ssh -t … sudo sh`, then removed; two logins.
func SSHCommand(goos string, t SSHTarget, scriptPath string) (string, error) {
	if err := t.Check(); err != nil {
		return "", err
	}
	port := t.Port
	if port == 0 {
		port = 22
	}
	p := strconv.Itoa(port)
	login := t.User + "@" + t.Address
	// scp reads host:path, so an IPv6 address is bracketed there.
	scpHost := t.Address
	if strings.Contains(scpHost, ":") {
		scpHost = "[" + scpHost + "]"
	}
	dest := t.User + "@" + scpHost + ":" + RemoteScript
	remote := "sudo sh " + RemoteScript + "; rm -f " + RemoteScript

	if goos == "windows" {
		if strings.ContainsAny(scriptPath, "\"%\r\n") {
			return "", fmt.Errorf("the script's path cannot be quoted for the terminal: %q", scriptPath)
		}
		q := `"` + scriptPath + `"`
		if t.User == "root" {
			return "cmd --% /c ssh -p " + p + " " + login + ` "sh -s" < ` + q, nil
		}
		return "scp -P " + p + " " + q + " " + dest + "; if ($?) { ssh -t -p " + p + " " + login + " '" + remote + "' }", nil
	}
	if strings.ContainsAny(scriptPath, "'\r\n") {
		return "", fmt.Errorf("the script's path cannot be quoted for the terminal: %q", scriptPath)
	}
	q := "'" + scriptPath + "'"
	if t.User == "root" {
		return "ssh -p " + p + " " + login + " 'sh -s' < " + q, nil
	}
	return "scp -P " + p + " " + q + " " + dest + " && ssh -t -p " + p + " " + login + " '" + remote + "'", nil
}
