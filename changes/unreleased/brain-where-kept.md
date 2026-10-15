---
kind: Added
---
- **brain:** Second Brain says where it is kept — in its Settings and under
  *Details* in How it works: the real path of `caprock.db` as the daemon
  resolved it (with *Copy path*), the tables `brain_nodes`, `brain_edges`
  and `brain_runs`, and that the session text goes to Anthropic through
  your own Claude to be read while nothing goes to Caprock.
  `GET /v1/brain/status` carries the path as `db_path`.
