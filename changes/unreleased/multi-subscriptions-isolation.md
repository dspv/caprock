---
kind: Fixed
---
- **subscriptions:** a session started on an added Claude Code or Codex
  subscription now runs on that subscription's own sign-in even when your
  shell exports `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CODEX_API_KEY` or another credential the agent would otherwise use
  first. Settings → Subscriptions names any such variable it sets aside,
  and sessions on your own sign-in keep them. Removing a subscription now
  names the macOS Keychain item its sign-in is kept in and offers **Sign out
  first**, which types the agent's own sign-out into a shell tab for you to
  run. Caprock still never touches the Keychain.
