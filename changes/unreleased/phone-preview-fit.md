---
kind: Fixed
---
- **app:** a Page tab in Phone mode never draws past the tab any more. A
  device whose page area did not fit kept its true size, and the page's
  window drew over the status bar, past the app's window and over the Dock;
  it is now drawn smaller to fit (*drawn at 74%*) and the page zoomed out to
  match, so it still lays out at the device's width. The bar's DPR reads
  *2*, not *2.200000047683716*.
- **app:** a page where nothing answers says so instead of a blank white
  page: *Nothing answers at 127.0.0.1:22776* (or *No address found for* a
  host) with Retry, in a normal tab and inside the phone alike.
