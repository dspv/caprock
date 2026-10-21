---
kind: Added
---
- **modules:** a private module can message its owner. `POST
  /v1/x/<id>/telegram` sends to the owner's own paired chat through the
  existing Caprock bot, its first line naming the module, with optional
  buttons or a reply field; a press or a reply is written back into the
  module's store (`telegram/<message_id>-<n>`) and never reaches a session.
  `POST /v1/x/<id>/notify` shows a desktop notification from the Caprock app,
  titled with the module's name, that opens the module when clicked.
