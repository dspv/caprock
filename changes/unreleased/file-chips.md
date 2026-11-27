---
kind: Changed
---
- **chat:** a PDF or any other file dropped into a session reads as the
  file, not its path, wherever Caprock draws it. In the chat's bubbles each
  absolute file path is a chip with an icon for its kind (a PDF says PDF),
  its name cut in the middle, and the whole path on hover or a click; the
  words around it stay. The chat's field and the phone's New chat show an
  attached PDF with the same icon. A session that opened with a dropped
  file is named by the file and the words (`CV.pdf how is my CV`), not by
  `Application Support/caprock/paste/drop-…`, in the sidebar, tabs, cards
  and previews. Claude Code's own terminal still shows the path: Caprock
  does not draw that text.
