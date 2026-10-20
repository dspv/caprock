---
kind: Fixed
---
- **ui:** the phone no longer scrolls sideways. On an iPhone, tapping a field
  smaller than 16px (the phone home's Repository and Project pickers, most
  Settings fields, Cost's cap) zoomed the page in and left it panning
  sideways; every field is 16px on a phone or touch screen now. A chat file's
  Markdown viewer no longer grows to the width of its longest link or path,
  and a wide table in a reply scrolls in its own frame instead of breaking
  every cell into two-letter lines. A new e2e test walks every phone screen,
  sheet and menu at 360, 390 and 430 px in a phone profile and fails on any
  sideways scroll, anything cut off at the edge or any field under 16px.
