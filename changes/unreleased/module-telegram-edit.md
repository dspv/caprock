---
kind: Added
---
- **modules:** a module can edit a Telegram message it sent — new text, new buttons, or none (`PATCH /v1/x/<id>/telegram/<message_id>`) — so a batch of approved drafts shows which cards are done, can thread a new message under one of its own with `reply_to_message_id`, and can pin one message at a time with `pin` (silently, replacing only its own previous pin). Presses on edited buttons land in the module's store like the first ones; any message the module did not send is a 404.
