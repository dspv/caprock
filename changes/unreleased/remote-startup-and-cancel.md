---
kind: Fixed
---
- **remote:** turning access from anywhere on in the first moments after
  Caprock started could leave it connected but reporting itself off, so the
  pairing link came back empty until the next restart. The settings are now
  read once, under the same lock as the switch.
- **remote:** a request cancelled by the phone or another computer is no
  longer ended as if its answer were complete, so a cut-short answer is
  never read as whole.
