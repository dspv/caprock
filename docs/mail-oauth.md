# Sign in with Google and Microsoft in Caprock Mail

Caprock Mail can connect a Gmail / Google Workspace or an Outlook.com /
Microsoft 365 mailbox without an app password: the user clicks *Sign in with
Google* (or *Microsoft*), approves in the browser, and Mail works. iCloud has
no OAuth for mail; it keeps using an app-specific password.

For the buttons to appear, a build needs an OAuth **client ID** for each
provider — an app registration made once, by whoever ships the build. This
page is how to make them and how to put them into a build. Why and what is
sent where: [ADR-057](../.ai/08-decisions.md). The routes:
[03-contracts.md › Mail](../.ai/03-contracts.md).

## Google

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (or pick one) for Caprock Mail.
2. **APIs & Services › Library**: enable the **Gmail API**, so the scope
   picker in step 5 lists the Gmail scopes (IMAP and SMTP do not call the
   API itself).
3. **Google Auth Platform › Branding** (the OAuth consent screen): app name
   *Caprock Mail*, support email, the caprock.dev home page and privacy policy
   links, and caprock.dev as an authorized domain.
4. **Audience**: user type **External**. While the app is in **Testing**, add
   the Google accounts that will try it as **test users**.
5. **Data access** (scopes): add `https://mail.google.com/` (listed as *Read,
   compose, send and permanently delete all your email from Gmail*), plus
   `openid` and `.../auth/userinfo.email`. `https://mail.google.com/` is a
   **restricted** scope: IMAP and SMTP accept no narrower one.
6. **Clients › Create client**: application type **Desktop app**, name
   *Caprock Mail*. No redirect URI is registered: a desktop client accepts
   any loopback `http://127.0.0.1:<port>/…` redirect. Copy the **client ID**
   and the **client secret**. For a Desktop app client Google does not treat
   the secret as confidential (installed apps cannot keep one), so it is
   compiled into the binary like the ID.

Limits until Google verifies the app (Google's
[publishing status](https://support.google.com/cloud/answer/15549945) page):

- In **Testing**, only the listed test users (up to 100) can sign in, each
  sees an *unverified app* warning, and every authorization — the refresh
  token with it — expires seven days after consent, so Mail asks to sign in
  again weekly.
- **In production** without verification the warning stays and the app is
  capped at 100 users. Lifting both for a restricted scope means Google's
  verification, which for restricted scopes includes an independent security
  assessment.

## Microsoft

In the [Azure portal](https://portal.azure.com/) › **Microsoft Entra ID ›
App registrations › New registration**:

1. Name *Caprock Mail*. Supported account types: **Accounts in any
   organizational directory and personal Microsoft accounts** (the app signs
   in through the `common` endpoint, so both Outlook.com and work accounts
   work).
2. Redirect URI: platform **Mobile and desktop applications** (on the
   registration form it is called *Public client/native*), URI
   `http://localhost/v1/mail/oauth/callback`. Microsoft ignores the port of a
   `localhost` redirect, so the daemon's port can be anything
   ([redirect URI rules](https://learn.microsoft.com/entra/identity-platform/reply-url#localhost-exceptions)).
   Register it once, without a port; do not add `127.0.0.1` (the portal
   refuses an http loopback IP).
3. **Authentication**: under *Advanced settings*, **Allow public client
   flows: Yes**. No client secret is created: a desktop app is a public
   client and sends none.
4. **API permissions › Add a permission › APIs my organization uses ›
   Office 365 Exchange Online › Delegated permissions**: **IMAP.AccessAsUser.All**
   and **SMTP.Send**. Also keep (or add, under Microsoft Graph, delegated)
   `openid`, `email` and `offline_access`. None of these needs admin consent
   for a user's own mailbox, though a work tenant may require it by policy.
5. Copy the **Application (client) ID** from the Overview page.

A work mailbox can still refuse: its admin may have turned IMAP or SMTP AUTH
off for the mailbox or the tenant. Mail then shows the server's refusal with
that hint.

## Putting the IDs into a build

The daemon reads, in order, the environment, then values compiled in:

| Environment variable                | Compiled-in variable (`-ldflags -X`)                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| `CAPROCK_MAIL_GOOGLE_CLIENT_ID`     | `github.com/dspv/caprock/internal/mail/oauth.GoogleClientID`     |
| `CAPROCK_MAIL_GOOGLE_CLIENT_SECRET` | `github.com/dspv/caprock/internal/mail/oauth.GoogleClientSecret` |
| `CAPROCK_MAIL_MICROSOFT_CLIENT_ID`  | `github.com/dspv/caprock/internal/mail/oauth.MicrosoftClientID`  |

To try it before a release, set the variables in the daemon's environment and
restart it.

Releases compile them in. Set three **GitHub Actions secrets** on
`dspv/caprock` (Settings → Secrets and variables → Actions), named exactly
like the environment variables:

- `CAPROCK_MAIL_GOOGLE_CLIENT_ID`
- `CAPROCK_MAIL_GOOGLE_CLIENT_SECRET`
- `CAPROCK_MAIL_MICROSOFT_CLIENT_ID`

`release.yml` passes them as environment to goreleaser (whose `caprock`
build adds the three `-X` flags through `envOrDefault`) and to the desktop
app builds (`scripts/app-release.sh` on macOS, the `Makefile`'s `LDFLAGS`
for `make app-bundle` on Windows and Linux), so the daemon the app bundles
carries them too. `make build` and `scripts/app-local.sh` read the same
variables from your shell. An unset secret is an empty value, never a failed
build: `GET /v1/mail/oauth/providers` then answers `false` for that provider,
and Mail offers an app password instead — the import screen says *Sign-in
with Google isn't set up in this build — use an app password*.

## What the user can revoke

Removing the account in Mail deletes its refresh token from the keychain. At
the provider: Google at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions);
a personal Microsoft account at
[account.live.com/consent/Manage](https://account.live.com/consent/Manage); a
work or school account at [myapps.microsoft.com](https://myapps.microsoft.com)
or through its Entra admin. After a revocation Mail's sync error says to sign
in again.
