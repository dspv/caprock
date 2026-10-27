-- The share cards this machine uploaded to caprock.dev (ADR-086): one row
-- per picture the user sent there by pressing X, Threads or LinkedIn in a
-- share sheet, so the post's link shows that card as its preview. The row
-- keeps the delete token the site answered with, which is the only way to
-- take the picture down again (Settings → Privacy, and the box the sheet
-- shows after posting). Written by POST /v1/share/card, read by GET
-- /v1/share/cards, removed by DELETE /v1/share/cards/{id} once the site has
-- deleted the picture.
--
-- Nothing is filled here: rows appear as cards are shared.
-- See 03-contracts.md § Shared cards DDL.
CREATE TABLE IF NOT EXISTS shared_cards (
  id           TEXT    PRIMARY KEY,           -- the site's id: caprock.dev/c/<id>
  url          TEXT    NOT NULL,              -- the page the post links to
  image        TEXT    NOT NULL DEFAULT '',   -- the picture's own address, as the site said it
  delete_token TEXT    NOT NULL,              -- X-Delete-Token for DELETE /api/card/<id>; never in a response
  bytes        INTEGER NOT NULL DEFAULT 0,    -- the PNG's size
  at           INTEGER NOT NULL               -- unix ms it was uploaded
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_shared_cards_at ON shared_cards(at);
