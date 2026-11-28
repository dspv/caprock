# A server in one click

**Status: accepted 2026-11-28; P1 built (2026-11-28), P2–P4 not.** The decision is
[ADR-109](08-decisions.md#adr-109--a-server-in-one-click-on-the-users-own-provider-account);
this file is its build plan. The server is the user's own, rented on their
own provider account; Caprock writes its setup script, optionally calls the
provider on the user's token, and links it as any other computer
([ADR-067](08-decisions.md), [ADR-108](08-decisions.md)). User docs are in
[docs/machines.md](../docs/machines.md) (*A new server, with a script*).

## What already exists

- **Linking** (ADR-067, ADR-108): `caprock join <key>` on the server, the
  rendezvous at the laptop's relay, the key's pre-approved Allow
  (`internal/peers/join.go`, `internal/remote`).
- **Running in the background** with nobody logged in: `caprock service
  install` writes a systemd user unit (`internal/service/linux.go`); it
  needs lingering, which today a person turns on by hand.
- **The checklist** (ADR-099): `GET /v1/setup`, its steps run from the
  laptop on a click (`POST /v1/setup/run`), a terminal tab on the other
  computer shown on the laptop.
- **Sign-in commands**: `claude auth login` and `codex login`
  (`internal/subs`), each in a configuration directory of its own for a
  second subscription (ADR-048).
- **Linux builds**: `.goreleaser.yaml` ships `caprock_<version>_linux_amd64`
  and `_arm64` archives (the daemon, the hook shim, the PTY host) with
  `checksums.txt`. Neither is signed yet; the desktop app's update bundle
  is, with minisign (ADR-042), and P1 signs the Linux archives with that
  key (OQ-32, decided 2026-11-28).

## Caprock native

What every server the script sets up has when it is done, on a server that
starts **blank** — nothing assumed preinstalled, not curl, not
ca-certificates, not sudo: the script installs every tool it uses before
it uses it (owner, 2026-11-28). The container test
(`internal/smoke/server_container_test.go`) asserts each item on every
image of the CI matrix:

- [x] Claude Code (`claude --version` as `caprock`), Codex (`codex
  --version`), Git and Node.js 18 or newer, installed and running.
- [x] A headless Chromium for the agents at
  `/usr/local/bin/caprock-chromium`, rendering a page: the distribution's
  `chromium` (Debian, Kali) or `chromium-headless` (Fedora; EPEL with CRB
  on Rocky and AlmaLinux), and on Ubuntu, whose Chromium is a snap only,
  Playwright's headless shell (`playwright@1.65.1`, the version the
  dashboard's e2e pins) with the libraries Playwright installs from the
  distribution. The npm package is checked by the registry's integrity
  hash; the browser archive Playwright downloads over TLS carries no
  published checksum, the one download here without one.
- [x] The server joined and listed on the laptop as an online computer.
- [x] The `caprock` user service running, with lingering on.
- [x] No inbound port: every listening TCP socket on loopback (or sshd's
  ports, keys only, when SSH was chosen), and the firewall on.
- [x] Unattended (Debian family) or automatic (Red Hat family) security
  updates on.
- [x] The server's Caprock the same version as the laptop's (`caprock
  version` there, and the version the laptop lists for it).

## Phases

Each phase is one small PR, green on the three-OS matrix, with its docs in
the same commit (rule 9) and a changelog fragment.

### P1 — the setup script and *Copy script*

- `internal/cloudinit` (name to taste): a pure function from {Caprock
  version, archive SHA-256 per arch, join key, whether an SSH key is
  expected} to a POSIX shell script that cloud-init runs as user data and a
  person can run as root over SSH. Ubuntu LTS and Debian stable first; any
  other distribution stops at the top with a line naming the two.
- The steps of ADR-109's *What the script does*, each idempotent and
  printed before it runs; a failed step stops the script with the step's
  name, which is what the provider's console log shows.
- The laptop fills in the archive's SHA-256 from that release's
  `checksums.txt` when the script is made — the release check already talks
  to GitHub (`internal/update`), so no new destination.
- **Signed archives** (OQ-32, decided 2026-11-28): the release workflow
  signs each `caprock_<version>_linux_<arch>.tar.gz` with the minisign key
  the app updater uses (ADR-042) and publishes the `.minisig` beside it; the
  script carries the public key and verifies the signature before the
  checksum. If that key cannot be handed to goreleaser in CI, P1 ships
  checksum-only, the script's header and `docs/machines.md` say so, and
  signing is **P1b**, its own PR.
- `POST /v1/machines/server-script` (loopback only, never on a device
  allowlist): makes a join key with the 60-minute server lifetime (ADR-108
  amended by ADR-109) and returns the script. The key is in that one answer
  and nowhere else, as ADR-108 requires.
- UI: Settings → Computers → *Add a computer* → **New server** → *I'll
  create it myself*: the script in full, **Copy**, the per-provider line on
  where to paste it, a countdown while the key is open, and the server's
  page once it joins. Contract in `03-contracts.md` in the same commit.
- `caprock machines server-script` prints the same, for a laptop over SSH.
- Tests: golden scripts per input; `shellcheck` on the output in CI; a run
  of the script in a Debian container on the Linux job with the downloads
  pointed at a local file server and a fake `claude`, ending in a join
  against a local relay (the smoke test's two-daemon setup); the key never
  in a log or file (walk the data directory, as ADR-108's smoke test does).

**As built (2026-11-28).** Where it differs from the plan above, or settles
what it left open:

- The package is `internal/serverscript` (`Render`, `FetchRelease`); the
  route's adapter is `internal/daemon/join.go`, the desk's
  `peers.JoinDesk.NewServer`. Contract: `03-contracts.md` § Join keys.
- **Signing landed in P1, not P1b.** The minisign key is reachable from
  `release.yml` (the app jobs already receive `TAURI_SIGNING_PRIVATE_KEY`),
  so a `linux-sign` job signs each Linux archive with `tauri signer sign`,
  checks the decoded `.minisig` with `minisign` against the public key in
  `tauri.conf.json`, and attaches it. The laptop asks for both `.minisig`
  files when it makes a script: present, the script checks the signature
  and then the SHA-256; absent (every release before the first one this
  job runs on, or a run without the secret), it checks the SHA-256 alone
  and its header says so. Not yet seen working: the first tagged release
  after this lands is its first run. Open: once a signed release exists,
  the laptop should require signatures for that version and later, so a
  missing `.minisig` cannot quietly downgrade a script to checksum-only.
- Supported systems (owner, 2026-11-28): the whole Debian family, found by
  `ID` or `ID_LIKE` in `/etc/os-release` naming `debian` or `ubuntu` —
  Debian 12 and 13, Ubuntu 22.04 and newer, Kali rolling and the systems
  built on them — any version; and the Red Hat family (the second branch
  of the same decision): `ID` or `ID_LIKE` naming `fedora`, `rhel`,
  `centos`, `rocky` or `almalinux`, with `dnf`, firewalld's `drop` zone,
  `dnf-automatic` (security updates, applied) and EPEL for `minisign` off
  Fedora; the user, lingering and SSH steps are the same. The agents need
  Node.js 18 or newer: the
  distribution's when its candidate is, otherwise NodeSource's signed
  repository with Node.js 22 (Ubuntu 22.04's own is 12) on the Debian
  family, the `nodejs:20` module stream on the Red Hat family (EL 9
  defaults to 16), and the step
  stops naming itself if what is installed is still older. Not Arch,
  Alpine or macOS; a Mac server is *Ask for it* on the New server screen,
  a GitHub issue filled in for the user to submit. Kali's
  `unattended-upgrades` is installed and on, but its default origins name
  Debian's security archive, which Kali does not use.
- Codex is `npm install --global @openai/codex` (its documented install),
  not a GitHub release archive. Claude Code is `https://claude.ai/install.sh`,
  run as `caprock`.
- `caprock hooks install` takes no `--yes` (it never asks); the key reaches
  `caprock join` on standard input, so it is in no process's arguments.
- The firewall is `ufw`; with an SSH key it admits the ports `sshd -T`
  names, so a box on another SSH port is not locked out. Without an SSH
  key the script refuses to run over SSH (`$SSH_CONNECTION` set).
- **Tests.** Golden scripts (`internal/serverscript/testdata`, `-update`
  rewrites them); `shellcheck --severity=style` and `sh -n` on both shapes
  in `go test` wherever they are installed (the ubuntu runners have
  shellcheck); the public key held to `tauri.conf.json`'s. The join is the
  smoke test `TestTwoDaemonsJoinWithAServerScript` on all three OS: a
  script made with `caprock machines server-script` against a stand-in for
  GitHub, its key open for an hour, the join with that key on stdin as the
  script does it, and the key in no log or file. **The script run in a
  container is behind build tags** (`smoke servercontainer`, `make
  server-container-test`, Linux with Docker; `CAPROCK_SERVER_IMAGE` picks the
  image, `debian:12` when unset): Ubuntu 24.04 (Hetzner's and DigitalOcean's
  default), Ubuntu 22.04 (the NodeSource path), Debian 12 and 13, Kali
  rolling, Fedora, Rocky Linux 9 and AlmaLinux 9 (the module-stream
  path), each with systemd as
  PID 1 in a privileged container, the release served locally, the relay
  and file server reached through socat on the container's loopback, the
  agents installed for real and signed in to never, ending in the join and
  the § Caprock native checklist read back item by item.
  It is not in `make check` (minutes, a privileged container, package
  mirrors); CI runs it as `ci.yml`'s required `server-container` matrix
  (`ubuntu:24.04`, `ubuntu:22.04`, `debian:12`, `debian:13`,
  `kalilinux/kali-rolling`, `fedora`, `rockylinux:9`, `almalinux:9`) on
  ubuntu-latest when `internal/serverscript/`, `internal/peers/`,
  `cmd/caprock/`, the test or `ci.yml` change, and on `workflow_dispatch`.
  Its first runs (#1117) found two gaps the script now closes: it starts
  `user@<uid>.service` itself after lingering (and prints its status and
  journal when that fails), and it installs `procps`, whose `sysctl` `ufw
  enable` runs and a minimal Debian lacks.

### P2 — the Hetzner Cloud path

- `internal/provider` with one interface — prices and server types,
  create (type, location, image, user data, firewall), status, delete — and
  a Hetzner Cloud adapter. The API's request and answer shapes are read from
  its documentation when this is built, with the date, not from memory.
- The token: pasted in New server → *Create it with my Hetzner account*,
  checked with one read call, kept in `internal/secret`, removable. Never in
  `config.json`, an answer, a log, an event, Send secrets or the phone's
  routes; every provider route is loopback-only.
- The picker: types and locations as the API returns them, each with the
  provider's price, labelled *Hetzner's price, read <time>*, in its currency
  with its VAT treatment; nothing Caprock computes. Types the API marks
  unavailable in a location are shown as such, not hidden. The smallest
  available type with at least 16 GB of memory is pre-selected and labelled
  *suggested, not measured* (OQ-31, decided 2026-11-28); any type can be
  picked, and nothing says how many sessions a type holds.
- Create: the P1 script as user data, a provider firewall with no inbound
  rule, a name the user can change; then the server's status until it joins.
- **Delete server**: the typed-name dialog of ADR-109, Forget, then the
  provider's delete; a failure says what is left on the provider and links
  its console.
- The CLAUDE.md rule 4 sentence below, and the same in `00-index.md`'s copy
  of the rule, in this PR.
- Tests: a fake provider API (`httptest`) that records each request and
  answers create, status, delete and prices, including rate limits, an
  unavailable type, a bad token and a create that never boots; a test that
  the token appears in no answer, log or file but the secret store; a test
  that no request goes to the provider before a token is saved.

### P3 — signing in from the laptop, and readiness

- The server's page opens on its checklist right after the join. *Sign in
  to Claude Code* runs `claude auth login` in a terminal tab there (the
  ADR-099 #1088 path); the URL it prints is a link in that tab that opens
  the laptop's browser on a click; the user pastes the code back. Codex with
  its device-code sign-in, the same way. What a headless `claude auth login`
  prints and asks is read from the installed version when this is built.
- Readiness for a server adds: the systemd unit active, lingering on, the
  firewall on, SSH password login off, unattended upgrades on — each read,
  never changed, by the server's own daemon.
- *Then close your laptop*: one line once an agent runs there, saying the
  session goes on and the laptop reconnects when it wakes.
- Two optional rows during setup, off by default (OQ-33, decided
  2026-11-28):
  - *Pair your phone with this server too*: the laptop asks the server's
    daemon for an ordinary phone pairing code (never a computer code, never
    above the phone's role, offered during setup only) and draws its QR;
    the phone lands in the server's device list, which the laptop shows.
  - *Move the Telegram bot here*: the bot token crosses the link as Send
    secrets carries a value, the server starts polling, and the laptop stops
    polling and switches to *Send through <server>* (ADR-047, #1100) in the
    same step, so one poller remains.
- *Update Caprock there* (OQ-34, decided 2026-11-28): shown when the two
  versions differ; it types the server install's upgrade command (as `GET
  /v1/update` names it there) into a terminal tab on the server, shown on
  the laptop, and the user presses Enter. No minimum version is enforced on
  the link; an older side answers 404 to a route it lacks.
- Tests: the readiness reads on fixtures of each file and command output;
  the sign-in path with a fake `claude` that prints a URL and waits for a
  code; nothing of the credential in any answer; the phone code is a phone
  code with the phone's role and is refused outside setup; the bot move
  leaves exactly one poller, and a failed move leaves the laptop polling;
  *Update Caprock there* types and never presses Enter.

### P4 — a browser for agents

- The headless Chromium itself is installed by the script on every server
  (§ Caprock native, 2026-11-28), not a switch.
- Making it the agent's browser (an MCP server or the agent's own browser
  setting) is a separate switch per agent, written as ADR-099's Claude in
  Chrome row writes its setting: every other key kept.
- Tests: the setting written through the ordered codec.

## Rule 4

The draft sentence for `CLAUDE.md` rule 4, to land with P2 (not before: P1
adds no destination), after the voice-model sentence:

> And one provider, on the user's own token: with a Hetzner Cloud API token
> pasted in Settings → Computers → New server, Caprock calls that provider's
> API to list its prices, create a server with the setup script the screen
> shows, read its status and delete it, and sends it nothing else
> (ADR-109).

In `CLAUDE.md`, *ADR-109* links to `.ai/08-decisions.md` as the rule's other
ADRs do.

## Not in this plan

- A managed server Caprock runs (ADR-109 keeps it as a later paid option).
- Providers other than Hetzner Cloud on path B, until someone asks.
- A desktop or remote browser for the person on the server.
- The server's Caprock updating itself (*Update Caprock there* types the
  command; the user runs it).
