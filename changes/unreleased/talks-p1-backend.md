---
kind: Added
---
- **talks:** Talks between two people's agents, through the API (ADR-110).
  `POST /v1/talks/invite` makes a link (`https://caprock.dev/talk#<key>`,
  good for 24 hours) and `POST /v1/talks/accept` takes it on the other
  person's Caprock: the two are linked both ways through the relay, each
  with a token that reaches the other's Talk inbox and nothing else.
  `POST /v1/talks {person, goal}` starts a Talk in which each side's own
  agent, run headless with no tools and grounded in its owner's 2nd Brain,
  answers the other's in turn. Every outgoing message passes secret
  redaction and the owner's never-share terms; a hit holds it for its
  owner (Send redacted, Edit, Drop), and so does a cap — 12 messages and
  $5 per side per Talk, defaults in `PUT /v1/talks/settings`. An envelope
  the other side cannot take waits in an outbox and is retried; Remove
  ends the link from either side.
