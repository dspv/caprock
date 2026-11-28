// Package serverscript writes the setup script for a new server (ADR-109,
// .ai/26-server.md P1): a POSIX shell script that cloud-init runs as a new
// server's user data, or a person runs once as root over SSH. It creates the
// user `caprock`, turns on lingering, unattended upgrades and a firewall that
// admits nothing inbound, sets SSH to keys only (or stops it), installs Git,
// Node.js, Claude Code with Anthropic's installer and Codex, installs
// Caprock at the laptop's version with its archive checked, and ends with
// `caprock join <key>` as that user.
//
// Render is a pure function of its Input: the same input gives the same
// script, byte for byte, which is what the golden tests hold it to. It never
// reads the clock, the network or the disk; the daemon fetches the release's
// checksums (release.go) and makes the join key, then calls it.
package serverscript

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// MinisignPublicKey is the key the desktop app's updater verifies its
// bundles with (ADR-042, app/src-tauri/tauri.conf.json's plugins.updater
// .pubkey, base64 of a minisign public key file). The release workflow signs
// each Linux archive with its secret half (release.yml, linux-sign), and the
// script checks that signature before the checksum. A test holds this to the
// app's copy, so the two cannot drift.
const MinisignPublicKey = "RWTX1RX33pVjQu6PgjfJjd9yG0IAEMskOZbDzsOMugDUiz5sTShBZ1rB"

// ReleaseBase is where release archives are downloaded from; the script
// fetches <ReleaseBase>/v<version>/caprock_<version>_linux_<arch>.tar.gz.
const ReleaseBase = "https://github.com/dspv/caprock/releases/download"

// Arches are the Linux architectures a release ships archives for.
var Arches = []string{"amd64", "arm64"}

// Input is everything a script depends on.
type Input struct {
	// Version is the Caprock release to install, without the "v": the
	// laptop's own version, or the latest release for a development build.
	Version string
	// SHA256 is each archive's SHA-256, hex, by architecture (Arches), as
	// that release's checksums.txt lists it.
	SHA256 map[string]string
	// Signed says the release has a .minisig beside each Linux archive: the
	// script then checks it against MinisignPublicKey before the checksum.
	Signed bool
	// JoinKey is the key `caprock join` uses, made for a server (60 minutes).
	JoinKey string
	// SSHKey says the user gave the provider an SSH key, or runs the script
	// over SSH: SSH stays on, keys only. Without one sshd is stopped and
	// disabled, and the provider's web console is the way in.
	SSHKey bool
	// Base overrides ReleaseBase, for tests that serve the archive locally.
	Base string
}

var (
	versionRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$`)
	shaRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	keyRe     = regexp.MustCompile(`^cj1-[A-Za-z0-9_-]+$`)
	baseRe    = regexp.MustCompile(`^https?://[A-Za-z0-9.:/_-]+$`)
)

// Render writes the script. Every value it puts inside the script is checked
// first against a pattern that cannot break out of its single quotes.
func Render(in Input) (string, error) {
	if !versionRe.MatchString(in.Version) {
		return "", fmt.Errorf("not a release version: %q", in.Version)
	}
	for _, a := range Arches {
		if !shaRe.MatchString(in.SHA256[a]) {
			return "", fmt.Errorf("no SHA-256 for the linux_%s archive of %s", a, in.Version)
		}
	}
	key := strings.TrimSpace(in.JoinKey)
	if !keyRe.MatchString(key) {
		return "", errors.New("not a join key")
	}
	base := in.Base
	if base == "" {
		base = ReleaseBase
	}
	base = strings.TrimRight(base, "/")
	if !baseRe.MatchString(base) {
		return "", fmt.Errorf("not a download address: %q", base)
	}

	var b strings.Builder
	b.WriteString(header(in))
	b.WriteString("\n# The values this script was made with.\n")
	fmt.Fprintf(&b, "CAPROCK_VERSION='%s'\n", in.Version)
	fmt.Fprintf(&b, "CAPROCK_DOWNLOAD='%s/v%s'\n", base, in.Version)
	fmt.Fprintf(&b, "CAPROCK_SHA256_AMD64='%s'\n", in.SHA256["amd64"])
	fmt.Fprintf(&b, "CAPROCK_SHA256_ARM64='%s'\n", in.SHA256["arm64"])
	if in.Signed {
		fmt.Fprintf(&b, "CAPROCK_MINISIGN_KEY='%s'\n", MinisignPublicKey)
	} else {
		b.WriteString("CAPROCK_MINISIGN_KEY=''\n")
	}
	if in.SSHKey {
		b.WriteString("CAPROCK_SSH_KEY=1\n")
	} else {
		b.WriteString("CAPROCK_SSH_KEY=0\n")
	}
	fmt.Fprintf(&b, "CAPROCK_JOIN_KEY='%s'\n", key)
	b.WriteString(body)
	return b.String(), nil
}

// header is the comment a person reads first, in a provider's form or a
// console log: what the script does, and how the archive is checked.
func header(in Input) string {
	check := "its minisign signature (the desktop app's update key) and its SHA-256"
	if !in.Signed {
		check = "its SHA-256 only: this release's Linux archives are not signed"
	}
	ssh := "SSH stays on for keys only; password login is off"
	if !in.SSHKey {
		ssh = "SSH stopped and disabled (no SSH key was expected); the\n#     provider's web console is the way in"
	}
	return `#!/bin/sh
# Caprock server setup (ADR-109), made by Caprock on the computer you work on.
#
# Paste it whole as the new server's user data (Hetzner Cloud: Cloud config;
# DigitalOcean: User data; any provider that runs cloud-init), or run it once
# as root over SSH: sudo sh caprock-setup.sh
#
# For the Debian family (Debian, Ubuntu, Kali and the systems built on them)
# and the Red Hat family (Fedora, Rocky Linux, AlmaLinux, CentOS Stream,
# RHEL), by ID or ID_LIKE in /etc/os-release. As root, each step
# printed before it runs, and the first that fails stops the script with
# its name:
#   - a user "caprock" with no password and no sudo, lingering on, so its
#     services run with nobody logged in
#   - unattended security upgrades, and a firewall that admits nothing
#     inbound but SSH when SSH stays on
#   - ` + ssh + `
#   - Git from the distribution; Node.js 20 or newer from the distribution,
#     or, when it is older, NodeSource's signed repository (Debian family)
#     or the nodejs:20 module stream (Red Hat family); Claude Code with
#     Anthropic's own installer; Codex from npm; a headless Chromium for
#     the agents (the distribution's, or Playwright's headless shell on Ubuntu)
#   - Caprock ` + in.Version + ` from its GitHub release, checked by
#     ` + check + `
#   - as caprock: caprock hooks install, caprock service install, then
#     caprock join with the key below
#
# The key works once, for 60 minutes from when it was made, and carries no
# token or credential. Keep Caprock running and online on the computer that
# made it until this server joins.
`
}

// body is the script after its values: fixed text, so the values above are
// the only part that changes between two scripts.
const body = `
set -eu
umask 022

STEP='start'
on_exit() {
	rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "caprock setup: stopped at step \"$STEP\" (exit $rc)" >&2
	fi
}
trap on_exit EXIT

step() {
	STEP=$1
	echo
	echo "==> caprock setup: $1"
}

stop() {
	echo "caprock setup: $*" >&2
	exit 1
}

unsupported() {
	stop "this system ($1) is not supported: use one of the Debian family (Debian, Ubuntu, Kali and the systems built on them) or the Red Hat family (Fedora, Rocky Linux, AlmaLinux, CentOS Stream, RHEL)"
}

step 'check the system'
[ "$(id -u)" -eq 0 ] || stop 'run this as root: sudo sh caprock-setup.sh'
[ -r /etc/os-release ] || unsupported 'no /etc/os-release'
os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
os_like=$(sed -n 's/^ID_LIKE=//p' /etc/os-release | tr -d '"')
os_ver=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
# The family is the package manager and the tools the steps below use: a
# system is in it by its own ID or by one it names in ID_LIKE.
family=''
for id in $os_id $os_like; do
	case "$id" in
	debian | ubuntu) family=debian ;;
	fedora | rhel | centos | rocky | almalinux) family=redhat ;;
	esac
done
[ -n "$family" ] || unsupported "$os_id"
case "$(uname -m)" in
x86_64 | amd64)
	arch=amd64
	sha=$CAPROCK_SHA256_AMD64
	;;
aarch64 | arm64)
	arch=arm64
	sha=$CAPROCK_SHA256_ARM64
	;;
*) stop "this processor ($(uname -m)) is not supported: Caprock ships amd64 and arm64 for Linux" ;;
esac
if [ "$CAPROCK_SSH_KEY" != 1 ] && [ -n "${SSH_CONNECTION:-}" ]; then
	stop 'you are running this over SSH, and this script would stop SSH: make it again on the computer you work on with "I log in with an SSH key" ticked'
fi
echo "$os_id ${os_ver:-rolling} ($family family), $arch"

step 'install packages from the distribution'
export DEBIAN_FRONTEND=noninteractive
apt_get() {
	apt-get -o DPkg::Lock::Timeout=600 -y "$@"
}
if [ "$family" = redhat ]; then
	# util-linux: runuser (a minimal Fedora has util-linux-core without it).
	dnf -y install ca-certificates bash git tar gzip procps-ng util-linux shadow-utils firewalld
	# An image with curl-minimal has a working curl; the full one conflicts.
	command -v curl >/dev/null 2>&1 || dnf -y install curl
	dnf -y install dnf-automatic || dnf -y install dnf5-plugin-automatic
	if [ -n "$CAPROCK_MINISIGN_KEY" ]; then
		# minisign is in Fedora, and in EPEL for the others.
		if [ "$os_id" != fedora ]; then
			dnf -y install epel-release
		fi
		dnf -y install minisign
	fi
else
	apt_get update
	apt_get install --no-install-recommends ca-certificates bash curl git tar gzip procps passwd gnupg ufw unattended-upgrades
	if [ -n "$CAPROCK_MINISIGN_KEY" ]; then
		apt_get install --no-install-recommends minisign
	fi
fi

step 'install Node.js 20 or newer'
if [ "$family" = redhat ]; then
	# The distribution's own when it is new enough; otherwise its nodejs:20
	# module stream (Rocky, AlmaLinux and CentOS Stream 9 default to 16).
	candidate=$(dnf -q info nodejs 2>/dev/null | sed -n 's/^Version *: *//p' | sort -V | tail -n 1)
	candidate_major=${candidate%%.*}
	case "$candidate_major" in
	'' | *[!0-9]*) candidate_major=0 ;;
	esac
	if [ "$candidate_major" -ge 20 ]; then
		echo "from the distribution: $candidate"
	else
		echo "the distribution has Node.js ${candidate:-none}: its nodejs:20 module stream instead"
		dnf -y module reset nodejs
		dnf -y module enable nodejs:20
	fi
	dnf -y install nodejs npm
else
	# The distribution's own when it is new enough; otherwise NodeSource's
	# signed repository (its documented setup), Node.js 22.
	candidate=$(apt-cache policy nodejs | sed -n 's/^ *Candidate: //p')
	candidate=${candidate#*:}
	candidate_major=${candidate%%.*}
	case "$candidate_major" in
	'' | *[!0-9]*) candidate_major=0 ;;
	esac
	if [ "$candidate_major" -ge 20 ]; then
		echo "from the distribution: $candidate"
		apt_get install --no-install-recommends nodejs npm
	else
		echo "the distribution has Node.js ${candidate:-none}: from NodeSource instead"
		mkdir -p /etc/apt/keyrings
		nskey=$(mktemp)
		curl -fsSL --retry 3 -o "$nskey" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key
		gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$nskey"
		rm -f "$nskey"
		echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' >/etc/apt/sources.list.d/nodesource.list
		apt_get update
		apt_get install nodejs
	fi
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || stop "Node.js $node_major is too old for the agents and their browser: 20 or newer is needed"
echo "Node.js $(node --version)"

step 'create the user caprock: no password, no sudo, its services running with nobody logged in'
if ! id caprock >/dev/null 2>&1; then
	useradd --create-home --user-group --shell /bin/bash caprock
fi
usermod --lock caprock
for g in sudo wheel; do
	if id -nG caprock | tr ' ' '\n' | grep -qx "$g"; then
		gpasswd --delete caprock "$g" >/dev/null
	fi
done
# Lingering is logind's: started here when the bus has not activated it yet.
if ! systemctl is-active --quiet systemd-logind.service; then
	systemctl start systemd-logind.service || {
		systemctl status systemd-logind.service --no-pager -l >&2 || true
		journalctl -b -u systemd-logind.service -n 40 --no-pager >&2 || true
		stop 'systemd-logind is not running, and lingering needs it'
	}
fi
loginctl enable-linger caprock
cuid=$(id -u caprock)
chome=$(getent passwd caprock | cut -d: -f6)
# Lingering asks logind to start the user manager; starting it here too makes
# the wait deterministic, and its status is what a failure prints.
systemctl start "user@$cuid.service" || true
i=0
while [ ! -S "/run/user/$cuid/systemd/private" ]; do
	i=$((i + 1))
	if [ "$i" -gt 60 ]; then
		systemctl status "user@$cuid.service" --no-pager -l >&2 || true
		journalctl -b -u "user@$cuid.service" -u systemd-logind.service -n 40 --no-pager >&2 || true
		stop "the user services of caprock did not start: no /run/user/$cuid/systemd/private after a minute"
	fi
	sleep 1
done

as_caprock() {
	(cd "$chome" && runuser -u caprock -- env -i HOME="$chome" USER=caprock LOGNAME=caprock SHELL=/bin/bash LANG=C.UTF-8 \
		XDG_RUNTIME_DIR="/run/user/$cuid" PATH="$chome/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@")
}

step 'turn on unattended security upgrades'
if [ "$family" = redhat ]; then
	conf=/etc/dnf/automatic.conf
	if [ -f "$conf" ]; then
		sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' "$conf"
	else
		printf '[commands]\nupgrade_type = security\napply_updates = yes\n' >"$conf"
	fi
	timer=''
	for t in dnf-automatic.timer dnf5-automatic.timer; do
		if systemctl enable --now "$t" >/dev/null 2>&1; then
			timer=$t
			break
		fi
	done
	[ -n "$timer" ] || stop 'could not turn on dnf-automatic'
	echo "$timer: security updates, applied"
else
	cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
	systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true
fi

step 'SSH: password login off'
ssh_ports=''
if [ -x /usr/sbin/sshd ]; then
	if [ "$CAPROCK_SSH_KEY" = 1 ]; then
		mkdir -p /etc/ssh/sshd_config.d
		cat >/etc/ssh/sshd_config.d/01-caprock.conf <<'EOF'
# Caprock server setup (ADR-109): keys only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
		mkdir -p /run/sshd
		/usr/sbin/sshd -t
		/usr/sbin/sshd -T | grep -qx 'passwordauthentication no' || stop 'sshd does not read /etc/ssh/sshd_config.d: turn PasswordAuthentication off in /etc/ssh/sshd_config, then run this again'
		ssh_ports=$(/usr/sbin/sshd -T | sed -n 's/^port //p')
		systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service 2>/dev/null || true
		echo "keys only, on port(s): $ssh_ports"
	else
		for u in ssh.socket ssh.service sshd.service; do
			systemctl disable --now "$u" >/dev/null 2>&1 || true
		done
		if systemctl is-active --quiet ssh.service || systemctl is-active --quiet ssh.socket || systemctl is-active --quiet sshd.service; then
			stop 'could not stop SSH'
		fi
		echo 'stopped and disabled: use the provider web console to reach this server'
	fi
else
	echo 'no SSH server here'
fi

step 'turn on a firewall that admits nothing inbound'
# systemd-resolved answers LLMNR (and on some systems mDNS) on every
# address: off, so nothing listens off loopback but sshd when it stays on.
if [ -d /etc/systemd ] && command -v resolvectl >/dev/null 2>&1; then
	mkdir -p /etc/systemd/resolved.conf.d
	printf '[Resolve]\nLLMNR=no\nMulticastDNS=no\n' >/etc/systemd/resolved.conf.d/90-caprock.conf
	systemctl try-restart systemd-resolved.service >/dev/null 2>&1 || true
fi
if [ "$family" = redhat ]; then
	# firewalld's drop zone: nothing inbound but replies and loopback.
	systemctl enable --now firewalld.service
	for p in $ssh_ports; do
		firewall-cmd --permanent --zone=drop --add-port="$p/tcp" >/dev/null
	done
	firewall-cmd --set-default-zone=drop >/dev/null
	firewall-cmd --reload >/dev/null
	firewall-cmd --list-all
else
	ufw default deny incoming >/dev/null
	ufw default allow outgoing >/dev/null
	for p in $ssh_ports; do
		ufw allow "$p/tcp" >/dev/null
	done
	ufw --force enable >/dev/null
	ufw status verbose
fi

step "install Claude Code with Anthropic's installer"
if [ "${CAPROCK_SETUP_SKIP_AGENTS:-}" = 1 ]; then
	echo 'skipped: CAPROCK_SETUP_SKIP_AGENTS=1'
else
	installer=$(mktemp)
	curl -fsSL --retry 3 -o "$installer" https://claude.ai/install.sh
	chmod 0644 "$installer"
	as_caprock bash "$installer"
	rm -f "$installer"
	as_caprock claude --version || stop 'Claude Code was installed but does not run'
fi

step 'install Codex from npm'
if [ "${CAPROCK_SETUP_SKIP_AGENTS:-}" = 1 ]; then
	echo 'skipped: CAPROCK_SETUP_SKIP_AGENTS=1'
else
	npm install --global @openai/codex
	as_caprock codex --version || stop 'Codex was installed but does not run'
fi

step 'install a headless Chromium for the agents'
# The distribution's own where it has one (Debian, Kali: chromium; Fedora,
# and EPEL elsewhere: chromium-headless). Ubuntu ships Chromium as a snap
# only, so there it is Playwright's headless shell, pinned, with the
# libraries Playwright installs from the distribution. Either way it is
# /usr/local/bin/caprock-chromium.
browser=''
chromium_deb=''
if [ "$family" = debian ]; then
	chromium_deb=$(apt-cache policy chromium | sed -n 's/^ *Candidate: //p')
	[ "$chromium_deb" != '(none)' ] || chromium_deb=''
fi
if [ "$family" = redhat ]; then
	if [ "$os_id" != fedora ]; then
		dnf -y install epel-release dnf-plugins-core
		dnf config-manager --set-enabled crb >/dev/null 2>&1 || true
	fi
	dnf -y install chromium-headless
	browser=$(find /usr/lib64/chromium-browser -name headless_shell -type f 2>/dev/null | head -n 1)
elif [ "$os_id" = ubuntu ] || [ -z "$chromium_deb" ]; then
	PLAYWRIGHT_BROWSERS_PATH=/opt/caprock-browsers npx --yes playwright@1.65.1 install --with-deps chromium-headless-shell
	chmod -R a+rX /opt/caprock-browsers
	browser=$(find /opt/caprock-browsers -type f \( -name chrome-headless-shell -o -name headless_shell \) 2>/dev/null | head -n 1)
else
	apt_get install --no-install-recommends chromium
	browser=/usr/bin/chromium
fi
[ -n "$browser" ] && [ -x "$browser" ] || stop 'no headless Chromium was installed'
ln -sf "$browser" /usr/local/bin/caprock-chromium
page=$(as_caprock caprock-chromium --headless --no-sandbox --disable-gpu --dump-dom 'data:text/html,<p>caprock-ok</p>' 2>/dev/null || true)
case "$page" in
*caprock-ok*) echo "headless Chromium: $browser" ;;
*) stop "the headless Chromium at $browser does not render a page" ;;
esac

step "install Caprock $CAPROCK_VERSION"
work=$(mktemp -d)
archive="caprock_${CAPROCK_VERSION}_linux_${arch}.tar.gz"
curl -fsSL --retry 3 -o "$work/$archive" "$CAPROCK_DOWNLOAD/$archive"
if [ -n "$CAPROCK_MINISIGN_KEY" ]; then
	curl -fsSL --retry 3 -o "$work/$archive.minisig" "$CAPROCK_DOWNLOAD/$archive.minisig"
	minisign -V -q -P "$CAPROCK_MINISIGN_KEY" -m "$work/$archive" -x "$work/$archive.minisig" ||
		stop "the signature of $archive does not match Caprock's key: nothing was installed"
	echo 'signature: good'
else
	echo 'signature: not checked, this release has no signed Linux archives'
fi
echo "$sha  $work/$archive" | sha256sum -c - >/dev/null ||
	stop "the SHA-256 of $archive is not the one the computer you work on read: nothing was installed"
echo 'SHA-256: good'
tar -xzf "$work/$archive" -C "$work" caprock caprock-hook caprock-pty-host
install -m 0755 "$work/caprock" "$work/caprock-hook" "$work/caprock-pty-host" /usr/local/bin/
rm -rf "$work"
got=$(/usr/local/bin/caprock version)
case "$got" in
"caprock $CAPROCK_VERSION "*) echo "$got" ;;
*) stop "installed Caprock says \"$got\", not $CAPROCK_VERSION" ;;
esac

step 'as caprock: caprock hooks install'
as_caprock caprock hooks install

step 'as caprock: caprock service install'
as_caprock caprock service install
i=0
until as_caprock caprock status --json 2>/dev/null | grep -q '"pid"'; do
	i=$((i + 1))
	[ "$i" -le 60 ] || stop 'Caprock did not start: see journalctl --user -u caprock as caprock'
	sleep 1
done

step 'as caprock: caprock join, with the key from the computer you work on'
n=0
until printf '%s\n' "$CAPROCK_JOIN_KEY" | as_caprock caprock join; do
	n=$((n + 1))
	[ "$n" -lt 3 ] || stop 'could not join: make a new script on the computer you work on, or run caprock join there with a new key'
	echo 'trying again in 20 s'
	sleep 20
done

STEP='done'
echo
echo '==> caprock setup: done. Sign in to Claude Code and Codex from this server page on the computer you work on.'
`
