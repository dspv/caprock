---
kind: Security
---
- **brain:** Second Brain no longer keeps credentials or payment details.
  Before a memory's title, summary or keywords are saved — by the automatic
  extraction, by hand, by the re-tag or from an Obsidian note — API keys and
  tokens (`sk-…`, GitHub, Slack, AWS, Google, Stripe, Telegram bot tokens,
  JWTs, bearer values, PEM private keys), card numbers (Luhn-checked),
  IBANs (checksum-checked), labelled passwords, secrets and bank account or
  routing numbers become a placeholder such as `[redacted: card number]`.
  The prose sent to the model to be read is filtered the same way, and the
  extraction's instructions say never to record such values. Memories kept
  before this are scrubbed once on start; the log says how many, by kind.
  `caprock mcp` uses the same filter, so its placeholders now name the kind
  too. The Second Brain settings say so in one line.
