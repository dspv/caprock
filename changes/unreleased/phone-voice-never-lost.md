---
kind: Fixed
---
- **ui:** a dictated message is never silently lost on the phone. When the
  speech service ends by itself mid-recording (Chrome on Android does after a
  pause), Caprock listens again and keeps every word; interim words with no
  final are sent rather than wiped; a later, emptier result never erases
  what is in the field; Send while listening waits for the last words. A
  pointer cancel keeps recording instead of dropping it, and sliding off the
  mic sends nothing but leaves the words in the field. A message the daemon
  does not take becomes a draft with Retry, a message on its way when the
  tab is discarded comes back as a draft, and the field's text survives a
  discarded tab.
- **ui:** the dictation language can be changed from the phone's + sheet,
  which was the only way on a chat's screen (it was stuck on the phone's own
  language there), and the recording line names the language it listens in.
  Speech recognition still hears one language per recording: the browser's
  API cannot detect a second one, and Caprock has no transcription of its own.
