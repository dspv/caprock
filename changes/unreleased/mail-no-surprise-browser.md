---
kind: Fixed
---
- **mail:** the Caprock Mail Mac preview no longer opens Mail in your
  browser by itself. After a Caprock update the Mail page reloads onto the
  new version, and when that reload came while Caprock was still restarting
  the preview took its own page for a link and handed it to the browser. It
  now refuses that reload quietly, and only a link you click opens the
  browser. The fix is in the preview's source (`app/mail-mac`): rebuild it
  with `app/mail-mac/build.sh` and copy it to Applications again.
