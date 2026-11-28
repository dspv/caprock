#!/bin/sh
# Caprock server setup (ADR-109), made by Caprock on the computer you work on.
#
# Paste it whole as the new server's user data (Hetzner Cloud: Cloud config;
# DigitalOcean: User data; any provider that runs cloud-init), or run it once
# as root over SSH: sudo sh caprock-setup.sh
#
# For Ubuntu 24.04 LTS or newer, or Debian 12 or newer. As root, each step
# printed before it runs, and the first that fails stops the script with
# its name:
#   - a user "caprock" with no password and no sudo, lingering on, so its
#     services run with nobody logged in
#   - unattended security upgrades, and a firewall that admits nothing
#     inbound but SSH when SSH stays on
#   - SSH stopped and disabled (no SSH key was expected); the
#     provider's web console is the way in
#   - Git, Node.js and npm from the distribution; Claude Code with
#     Anthropic's own installer; Codex from npm
#   - Caprock 0.201.0 from its GitHub release, checked by
#     its SHA-256 only: this release's Linux archives are not signed
#   - as caprock: caprock hooks install, caprock service install, then
#     caprock join with the key below
#
# The key works once, for 60 minutes from when it was made, and carries no
# token or credential. Keep Caprock running and online on the computer that
# made it until this server joins.

# The values this script was made with.
CAPROCK_VERSION='0.201.0'
CAPROCK_DOWNLOAD='https://github.com/dspv/caprock/releases/download/v0.201.0'
CAPROCK_SHA256_AMD64='a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
CAPROCK_SHA256_ARM64='b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
CAPROCK_MINISIGN_KEY=''
CAPROCK_SSH_KEY=0
CAPROCK_JOIN_KEY='cj1-AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RFRkdISUpLTE1OT1A'

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
	stop "this system is not supported: use Ubuntu 24.04 LTS or newer, or Debian 12 or newer"
}

step 'check the system'
[ "$(id -u)" -eq 0 ] || stop 'run this as root: sudo sh caprock-setup.sh'
[ -r /etc/os-release ] || unsupported
os_id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
os_ver=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
os_major=${os_ver%%.*}
case "$os_major" in
'' | *[!0-9]*) unsupported ;;
esac
case "$os_id" in
ubuntu)
	# An LTS release is an even year's .04.
	case "$os_ver" in
	*.04) ;;
	*) unsupported ;;
	esac
	[ $((os_major % 2)) -eq 0 ] || unsupported
	[ "$os_major" -ge 24 ] || unsupported
	;;
debian)
	[ "$os_major" -ge 12 ] || unsupported
	;;
*) unsupported ;;
esac
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
echo "$os_id $os_ver, $arch"

step 'install packages from the distribution'
export DEBIAN_FRONTEND=noninteractive
apt_get() {
	apt-get -o DPkg::Lock::Timeout=600 -y "$@"
}
apt_get update
apt_get install --no-install-recommends ca-certificates curl git tar gzip procps nodejs npm ufw unattended-upgrades
if [ -n "$CAPROCK_MINISIGN_KEY" ]; then
	apt_get install --no-install-recommends minisign
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 18 ] || stop "Node.js $node_major is too old for the agents: 18 or newer is needed"

step 'create the user caprock: no password, no sudo, its services running with nobody logged in'
if ! id caprock >/dev/null 2>&1; then
	useradd --create-home --user-group --shell /bin/bash caprock
fi
passwd --lock caprock >/dev/null
if id -nG caprock | tr ' ' '\n' | grep -qx sudo; then
	gpasswd --delete caprock sudo >/dev/null
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
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

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
		if systemctl is-active --quiet ssh.service || systemctl is-active --quiet ssh.socket; then
			stop 'could not stop SSH'
		fi
		echo 'stopped and disabled: use the provider web console to reach this server'
	fi
else
	echo 'no SSH server here'
fi

step 'turn on a firewall that admits nothing inbound'
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $ssh_ports; do
	ufw allow "$p/tcp" >/dev/null
done
ufw --force enable >/dev/null
ufw status verbose

step "install Claude Code with Anthropic's installer"
if [ "${CAPROCK_SETUP_SKIP_AGENTS:-}" = 1 ]; then
	echo 'skipped: CAPROCK_SETUP_SKIP_AGENTS=1'
else
	installer=$(mktemp)
	curl -fsSL --retry 3 -o "$installer" https://claude.ai/install.sh
	chmod 0644 "$installer"
	as_caprock bash "$installer"
	rm -f "$installer"
fi

step 'install Codex from npm'
if [ "${CAPROCK_SETUP_SKIP_AGENTS:-}" = 1 ]; then
	echo 'skipped: CAPROCK_SETUP_SKIP_AGENTS=1'
else
	npm install --global @openai/codex
fi

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
