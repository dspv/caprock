-- Caprock Mail schema. Applied idempotently at open; versioned by user_version.

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
    last_error  TEXT NOT NULL DEFAULT ''
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
    last_seen  INTEGER NOT NULL DEFAULT 0
);
