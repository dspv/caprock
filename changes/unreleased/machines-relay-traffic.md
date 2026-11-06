---
kind: Added
---
- **machines:** `GET /v1/machines` says what each linked computer's channel
  has cost the relay (`traffic`: messages and bytes each way since the daemon
  started or paired it), and `bench/peer.mjs --idle N` measures a window left
  open — so the hosted relay's free-plan headroom is read, not guessed.
