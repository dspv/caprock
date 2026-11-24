---
kind: Changed
---
- **app:** the session lists carry an ETag, and an unchanged one costs a
  304 with no body instead of the whole list (293 KB on the stand, 424 KB
  on the owner's Mac), nor is it merged into the sidebar again.
