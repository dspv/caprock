---
kind: Added
---
- **app:** voice input in the chat and the composer on Windows and Linux,
  recognised on the computer by whisper.cpp running inside the app: hold
  the mic to talk, or click to start and stop, as on a Mac. The words
  arrive a sentence at a time after each pause, and *Finishing…* covers
  the last one after you let go. It needs a voice model, downloaded once
  under the new Settings → Voice input — *Accurate* (191 MB, recommended)
  or *Fast* (149 MB) — from huggingface.co only when you press Download,
  its SHA-256 checked against the copy built into Caprock; nothing else is
  sent and your voice never leaves the computer. Until it is in, the mic
  says so and links there. The model stays in memory only while you
  dictate and for a minute after (ADR-104).
