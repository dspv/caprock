---
kind: Fixed
---
- **remote:** after one write to a closing terminal fails, the computer drops what is typed next at once instead of writing it into the closing socket; the revoke test types a bounded burst, so the flood guard no longer trips it on a small CI runner.
