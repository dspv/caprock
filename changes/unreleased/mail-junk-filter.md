---
kind: Added
---
- **mail:** junk stays out of the Inbox, even when your mail provider
  leaves it there (owner request, translated: "there's a lot of spam in my
  inbox — every mail client filters this"). Caprock's own filter runs on the
  machine, with no AI and nothing sent anywhere, and is on from the start. It
  reads what the receiving server wrote into each message — SPF, DKIM and
  DMARC results and the server's own spam verdict — plus a few cheap checks
  (a brand name on an unrelated domain, replies sent to a free mail address,
  URL shorteners, image-only mail), and a small learning classifier taught by
  your Spam folder and by every *Spam* (`!`) and *Not spam* (`n`, new) you
  press. Anyone you have written to, or said *Not spam* for, is never junk.
  Hidden mail is listed under *Caprock thinks these are junk* in Spam
  (`g !`), whose count the sidebar shows, and the reader says why; nothing is
  moved or deleted on the server unless you press Spam yourself.
