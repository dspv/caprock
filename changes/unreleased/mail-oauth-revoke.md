---
kind: Added
---
- **mail:** removing an account signed in with Google now also revokes
  Caprock's access at Google, not only the token on this machine; for a
  Microsoft account, which offers apps no way to do that, the confirmation
  says where to remove the access. `docs/mail-oauth.md` gains the owner's
  setup checklist and a step-by-step test on a real Gmail and Outlook account,
  and the Go tests walk a whole account's life against a fake provider and
  fake mail servers: sign in, sync, read, send after the access token
  expired, remove.
