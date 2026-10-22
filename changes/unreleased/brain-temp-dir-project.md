---
kind: Fixed
---
- **brain:** a session that ran in a folder under the system's temp directory
  no longer files its memories under a throwaway project named after that
  folder (an archive extracted to `ops-seo-site-m143z5ko` made one per run).
  A checkout there with a remote is named after the remote's repository;
  anything else keeps its memories with their topics and no project.
