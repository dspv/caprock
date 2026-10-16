-- Caprock Mail schema. Applied idempotently at open. A column added to a table
-- that already shipped is also listed in addedColumns (store.go), which adds it
-- to an existing mail.db.

CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL,
    username    TEXT NOT NULL,
    imap_host   TEXT NOT NULL,
    imap_port   INTEGER NOT NULL,
    imap_tls    TEXT NOT NULL DEFAULT 'tls',  -- tls | starttls | none
    smtp_host   TEXT NOT NULL,
    smtp_port   INTEGER NOT NULL,
    smtp_tls    TEXT NOT NULL DEFAULT 'tls',
    color       TEXT NOT NULL DEFAULT '',
    signature   TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    last_sync   INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT NOT NULL DEFAULT '',
    auth        TEXT NOT NULL DEFAULT 'password' -- password | oauth2:google | oauth2:microsoft; added to older files by addColumns
);

CREATE TABLE IF NOT EXISTS folders (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,          -- the server's mailbox name
    delim        TEXT NOT NULL DEFAULT '/',
    role         TEXT NOT NULL DEFAULT '', -- inbox sent drafts trash junk archive all flagged
    uidvalidity  INTEGER NOT NULL DEFAULT 0,
    last_uid     INTEGER NOT NULL DEFAULT 0, -- highest UID stored
    total        INTEGER NOT NULL DEFAULT 0,
    unread       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid          INTEGER NOT NULL,
    message_id   TEXT NOT NULL DEFAULT '',
    in_reply_to  TEXT NOT NULL DEFAULT '',
    refs         TEXT NOT NULL DEFAULT '',  -- space separated
    thread_key   TEXT NOT NULL DEFAULT '',
    subject      TEXT NOT NULL DEFAULT '',
    from_name    TEXT NOT NULL DEFAULT '',
    from_addr    TEXT NOT NULL DEFAULT '',
    to_json      TEXT NOT NULL DEFAULT '[]',
    cc_json      TEXT NOT NULL DEFAULT '[]',
    reply_to     TEXT NOT NULL DEFAULT '',
    date         INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    seen         INTEGER NOT NULL DEFAULT 0,
    flagged      INTEGER NOT NULL DEFAULT 0,
    answered     INTEGER NOT NULL DEFAULT 0,
    has_attach   INTEGER NOT NULL DEFAULT 0,
    snippet      TEXT NOT NULL DEFAULT '',
    body_text    TEXT NOT NULL DEFAULT '',
    body_html    TEXT NOT NULL DEFAULT '',
    structure    TEXT NOT NULL DEFAULT '', -- JSON: text parts and attachments by IMAP part path
    body_state   INTEGER NOT NULL DEFAULT 0, -- 0 headers only, 1 body fetched
    -- The local junk filter's verdict (inbox mail only); added to older files by addColumns.
    junk         INTEGER NOT NULL DEFAULT 0,  -- 1: hidden from the inbox as junk
    junk_score   INTEGER NOT NULL DEFAULT 0,  -- 0-100, 50 is the threshold
    junk_why     TEXT NOT NULL DEFAULT '',    -- comma-separated rule codes, strongest first
    junk_hdr     TEXT NOT NULL DEFAULT '',    -- JSON spam.Header; '' = not read yet
    UNIQUE (folder_id, uid)
);
CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS messages_date ON messages(date DESC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_key);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages(account_id, message_id);
CREATE INDEX IF NOT EXISTS messages_body_state ON messages(body_state) WHERE body_state = 0;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, people, body,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    addr       TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    weight     INTEGER NOT NULL DEFAULT 0,  -- sent-to counts more than received-from
    last_seen  INTEGER NOT NULL DEFAULT 0,
    sent       INTEGER NOT NULL DEFAULT 0   -- times the user wrote to it; added by addColumns
);

-- The local junk filter (internal/mail/spam). Global, not per account: one
-- person's idea of junk does not change with the address it reached, and a
-- second account's mail would otherwise start from nothing.
-- Token counts: in how many learned spam and ham messages a token appeared.
-- Pruned to the most-seen tokens past 60,000 rows (PruneJunkTokens).
CREATE TABLE IF NOT EXISTS junk_tokens (
    token TEXT PRIMARY KEY,
    spam  INTEGER NOT NULL DEFAULT 0,
    ham   INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Which messages were learned and as what, so one is never counted twice and
-- a change of mind (Not spam after Spam) moves its tokens across.
CREATE TABLE IF NOT EXISTS junk_trained (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    msg_key    TEXT NOT NULL,    -- the Message-ID, else folder:uid
    spam       INTEGER NOT NULL, -- 1 spam, 0 ham
    by_user    INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL,
    PRIMARY KEY (account_id, msg_key)
);

-- Senders the user said "Not spam" for: never junk again.
CREATE TABLE IF NOT EXISTS junk_allow (
    addr TEXT PRIMARY KEY,
    at   INTEGER NOT NULL
);

-- AI triage (added 2026-10-15): one row per inbox conversation the assistant
-- sorted, keyed like the conversation itself. message_id is the newest
-- message (row id) it saw, so a conversation that gains a message is sorted
-- again; user_set marks a label the user gave, which the model never
-- overwrites. Rows go with their account.
CREATE TABLE IF NOT EXISTS triage (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_key  TEXT NOT NULL,
    message_id  INTEGER NOT NULL DEFAULT 0,
    category    TEXT NOT NULL,              -- important | updates | newsletter | spam
    reply       INTEGER NOT NULL DEFAULT 0, -- the last message waits on the user's answer
    summary     TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',   -- provider[/model] that answered; "user" or "sample"
    user_set    INTEGER NOT NULL DEFAULT 0,
    at          INTEGER NOT NULL,           -- unix seconds
    PRIMARY KEY (account_id, thread_key)
);

-- Senders the user said are not spam, per account: the model's spam verdict
-- for their mail is replaced by the label the user gave.
CREATE TABLE IF NOT EXISTS triage_senders (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    addr        TEXT NOT NULL,
    category    TEXT NOT NULL,
    PRIMARY KEY (account_id, addr)
);
