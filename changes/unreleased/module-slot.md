---
kind: Added
---
- **modules:** a slot for private modules (ADR-075). A signed admin key
  pasted into Settings → License names the modules this machine may run;
  `caprock module install <dir>` copies one in from a local folder; each
  installed module gets a sidebar screen in the app's theme and a small JSON
  document store. Without a key nothing of it is shown.
