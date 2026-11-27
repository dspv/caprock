---
kind: Added
---
- **server:** a new server, set up by one script. Settings → Computers →
  **New server** writes a setup script to paste into your provider's create
  form (Hetzner Cloud: Cloud config; DigitalOcean: User data; any provider
  that runs cloud-init) or run once as root over SSH. On Ubuntu 24.04 LTS or
  newer, or Debian 12 or newer, it creates a user `caprock` with no password
  and no sudo, keeps its services running with nobody logged in, turns on
  unattended security upgrades and a firewall that admits nothing inbound,
  sets SSH to keys only (or stops it), installs Git, Node.js, Claude Code
  with Anthropic's installer and Codex, installs Caprock at your laptop's
  version with its archive checked, and links the server to your laptop with
  a one-time key that works for 60 minutes. `caprock machines server-script`
  prints the same script. Linux release archives now carry a minisign
  signature, which the script checks before the SHA-256 (ADR-109).
