---
kind: Fixed
---
- **ui:** a share button can no longer leave the sheet stuck on "Drawing…"
  with every button off. A press on a card whose figures are still being
  counted waits at most six seconds, saying *Counting this month…*, then
  sends the card as shown (its corner still names the reading); the picture
  embeds only the fonts the page already loaded, from the browser's cache,
  instead of fetching eight font files from a daemon busy counting the
  month; and drawing has a 30-second limit, after which the buttons come
  back with *Could not draw the card — try again.* Panel pictures get the
  same limit.
