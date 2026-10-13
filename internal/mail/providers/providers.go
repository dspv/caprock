// Package providers knows the server settings of common mail hosts, so adding
// an account is an address and a password. Past the built-in table it asks
// only the user's own domain: its MX, its RFC 6186 SRV records and its own
// autoconfig file. No third-party directory is ever asked.
package providers

import (
	"context"
	"net"
	"strings"
)

// Where a Settings answer came from.
const (
	SourcePreset     = "preset"     // the address's domain is in the table
	SourceMX         = "mx"         // the domain's MX points at a host in the table
	SourceSRV        = "srv"        // the domain's RFC 6186 SRV records
	SourceAutoconfig = "autoconfig" // the domain's own config-v1.1.xml
	SourceGuess      = "guess"      // imap.<domain> / smtp.<domain>, unverified
)

// Settings are the servers for an address.
type Settings struct {
	Provider string `json:"provider"`
	IMAPHost string `json:"imap_host"`
	IMAPPort int    `json:"imap_port"`
	IMAPTLS  string `json:"imap_tls"`
	SMTPHost string `json:"smtp_host"`
	SMTPPort int    `json:"smtp_port"`
	SMTPTLS  string `json:"smtp_tls"`
	// Note tells the user what the host needs, e.g. an app password.
	Note string `json:"note,omitempty"`
	// HelpURL is the provider's own page for these settings.
	HelpURL string `json:"help_url,omitempty"`
	// Known is false when the settings are a guess.
	Known bool `json:"known"`
	// NeedsUsername: the sign-in name differs from the address (iCloud+
	// custom domains, an autoconfig file that says so), so the form shows the
	// Username field at once.
	NeedsUsername bool `json:"needs_username,omitempty"`
	// Username is the sign-in name when the domain's autoconfig names one.
	Username string `json:"username,omitempty"`
	// Source says how the answer was found; see the Source constants.
	Source string `json:"source"`
}

type preset struct {
	name             string
	imap             string
	imapPort         int    // 0 = 993
	imapTLS          string // with imapPort
	smtp             string
	smtpPort         int
	smtpTLS          string
	note, help       string
	domains, mxHints []string
	// mxName and mxNote replace name and note when the preset is reached
	// through a custom domain's MX record.
	mxName, mxNote string
}

// presets: every host, port and TLS mode is from the provider's own help page,
// the one in help or in the comment above the entry, read 2026-10-14. MX hints
// are from the provider's DNS documentation or, where marked, from the MX
// records its own domains publish (dig, 2026-10-14). Providers whose servers
// could not be sourced from their own pages are left out: QQ Mail, NetEase
// (163/126/yeah.net), Naver and Spectrum.
var presets = []preset{
	// Gmail https://developers.google.com/workspace/gmail/imap/imap-smtp,
	// MX https://support.google.com/a/answer/174125.
	{name: "Gmail", imap: "imap.gmail.com", smtp: "smtp.gmail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Gmail needs an app password (Google Account → Security → 2-Step Verification → App passwords).",
		help:    "https://myaccount.google.com/apppasswords",
		domains: []string{"gmail.com", "googlemail.com"}, mxHints: []string{"google.com", "googlemail.com"},
		mxName: "Google Workspace",
		mxNote: "Google Workspace needs an app password (2-Step Verification on). If your admin has turned app passwords off, only Google sign-in works, which Caprock does not support yet."},
	// iCloud https://support.apple.com/en-us/102525, custom domains
	// https://support.apple.com/en-us/102374.
	{name: "iCloud", imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "iCloud needs an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords), not your Apple Account password.",
		help:    "https://account.apple.com/account/manage",
		domains: []string{"icloud.com", "me.com", "mac.com"}, mxHints: []string{"mail.icloud.com"},
		mxName: "iCloud+ (custom domain)",
		mxNote: "Your domain's mail is on iCloud. Sign in with an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords) and put your @icloud.com address in Username."},
	// https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040;
	// Microsoft 365 https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4,
	// MX https://learn.microsoft.com/en-us/purview/how-smtp-dane-works.
	{name: "Outlook", imap: "outlook.office365.com", smtp: "smtp-mail.outlook.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "Outlook.com requires Microsoft sign-in (OAuth), which Caprock does not support yet; a password is usually refused.",
		help:    "https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040",
		domains: []string{"outlook.com", "hotmail.com", "live.com", "msn.com"}},
	{name: "Microsoft 365", imap: "outlook.office365.com", smtp: "smtp.office365.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "Microsoft 365 accepts a password only if your organisation still allows IMAP basic sign-in; otherwise it needs Microsoft sign-in (OAuth), which Caprock does not support yet.",
		help:    "https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4",
		mxHints: []string{"mail.protection.outlook.com", "mx.microsoft"}},
	// Yahoo https://help.yahoo.com/kb/SLN4075.html. The yahoodns.net MX is
	// what yahoo.com and ymail.com publish.
	{name: "Yahoo", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Yahoo needs an app password (Account security → Generate app password).",
		help:    "https://help.yahoo.com/kb/SLN15241.html",
		domains: []string{"yahoo.com", "ymail.com"}, mxHints: []string{"yahoodns.net"}},
	// Cox mail moved to Yahoo: https://help.yahoo.com/kb/mail/SLN36637.html.
	{name: "Cox (Yahoo)", imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Cox mail is served by Yahoo and needs a Yahoo app password.",
		help:    "https://help.yahoo.com/kb/mail/SLN36637.html",
		domains: []string{"cox.net"}},
	// AOL https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail.
	// mx-aol.mail.gm0.yahoodns.net is what aol.com publishes.
	{name: "AOL", imap: "imap.aol.com", smtp: "smtp.aol.com", smtpPort: 465, smtpTLS: "tls",
		note:    "AOL needs an app password (Account security → Generate app password).",
		help:    "https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail",
		domains: []string{"aol.com"}, mxHints: []string{"mx-aol.mail.gm0.yahoodns.net"}},
	// Verizon mail is on AOL:
	// https://help.aol.com/articles/how-do-i-set-up-other-email-applications-to-send-and-receive-my-verizon-net-mail.
	{name: "Verizon (AOL)", imap: "imap.aol.com", smtp: "smtp.verizon.net", smtpPort: 465, smtpTLS: "tls",
		note:    "Verizon mail is served by AOL: sign in with your full @verizon.net address and an AOL app password.",
		help:    "https://help.aol.com/articles/how-do-i-set-up-other-email-applications-to-send-and-receive-my-verizon-net-mail",
		domains: []string{"verizon.net"}},
	// AT&T https://www.att.com/support/article/email-support/KM1010523/.
	// mx-att.mail.am0.yahoodns.net is what att.net publishes.
	{name: "AT&T", imap: "imap.mail.att.net", smtp: "smtp.mail.att.net", smtpPort: 465, smtpTLS: "tls",
		note: "AT&T needs a secure mail key instead of your password (myAT&T → Profile → Sign-in info → Secure mail key).",
		help: "https://www.att.com/support/article/email-support/KM1240308/",
		domains: []string{"att.net", "ameritech.net", "bellsouth.net", "currently.com", "flash.net", "nvbell.net",
			"pacbell.net", "prodigy.net", "sbcglobal.net", "snet.net", "swbell.net", "wans.net"},
		mxHints: []string{"mx-att.mail.am0.yahoodns.net"}},
	// Comcast https://www.xfinity.com/support/articles/email-client-programs-with-xfinity-email.
	{name: "Xfinity (Comcast)", imap: "imap.comcast.net", smtp: "smtp.comcast.net", smtpPort: 587, smtpTLS: "starttls",
		note:    "Allow third-party access in Xfinity Email settings on the web first.",
		help:    "https://www.xfinity.com/support/articles/email-client-programs-with-xfinity-email",
		domains: []string{"comcast.net"}, mxHints: []string{"comcast.net"}},
	// Fastmail https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports,
	// MX https://www.fastmail.help/hc/en-us/articles/360060591153-Manual-DNS-configuration.
	{name: "Fastmail", imap: "imap.fastmail.com", smtp: "smtp.fastmail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Fastmail needs an app password (Settings → Privacy & Security → App passwords).",
		help:    "https://app.fastmail.com/settings/security/apps",
		domains: []string{"fastmail.com", "fastmail.fm"}, mxHints: []string{"messagingengine.com"}},
	// https://proton.me/support/comprehensive-guide-to-bridge-settings
	{name: "Proton Mail Bridge", imap: "127.0.0.1", imapPort: 1143, imapTLS: "starttls",
		smtp: "127.0.0.1", smtpPort: 1025, smtpTLS: "starttls",
		note:    "Proton Mail works through Proton Mail Bridge (paid plans); use the ports and the Bridge password it shows under Mailbox details.",
		help:    "https://proton.me/support/comprehensive-guide-to-bridge-settings",
		domains: []string{"proton.me", "protonmail.com", "pm.me"}},
	// Zoho https://www.zoho.com/mail/help/imap-access.html and
	// https://www.zoho.com/mail/help/zoho-smtp.html; paid-organisation hosts
	// per data centre https://www.zoho.com/mail/help/adminconsole/autodiscovery-settings.html.
	{name: "Zoho Mail", imap: "imap.zoho.com", smtp: "smtp.zoho.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn IMAP on in Zoho Mail (Settings → Mail Accounts → IMAP); with two-factor sign-in use an app-specific password. Paid organisations use imappro.zoho.com and smtppro.zoho.com.",
		help:    "https://www.zoho.com/mail/help/imap-access.html",
		domains: []string{"zoho.com", "zohomail.com"}, mxHints: []string{"zoho.com"}},
	// EU personal and free-organisation hosts per Zoho support:
	// https://help.zoho.com/portal/en/community/topic/zoho-mail-server-details.
	{name: "Zoho Mail (EU)", imap: "imap.zoho.eu", smtp: "smtp.zoho.eu", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn IMAP on in Zoho Mail (Settings → Mail Accounts → IMAP); with two-factor sign-in use an app-specific password. Paid organisations use imappro.zoho.eu; the exact servers are under Settings → Mail Accounts.",
		help:    "https://www.zoho.com/mail/help/imap-access.html",
		domains: []string{"zohomail.eu"}, mxHints: []string{"zoho.eu"}},
	// Yandex https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others,
	// Yandex 360 MX https://yandex.com/support/business/domains/dns/mx.html.
	{name: "Yandex", imap: "imap.yandex.com", smtp: "smtp.yandex.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Yandex needs an app password, and IMAP turned on under Mail settings → Email clients.",
		help:    "https://id.yandex.com/security/app-passwords",
		domains: []string{"yandex.com", "yandex.ru", "ya.ru"}, mxHints: []string{"yandex.net", "yandex.ru"}},
	// Mail.ru https://help.mail.ru/mail/login/mailer/. bk.ru, inbox.ru,
	// list.ru and internet.ru publish the same mxs.mail.ru MX.
	{name: "Mail.ru", imap: "imap.mail.ru", smtp: "smtp.mail.ru", smtpPort: 465, smtpTLS: "tls",
		note:    "Mail.ru needs a password for external applications (Settings → All settings → Security), not your normal password.",
		help:    "https://help.mail.ru/mail/login/mailer/",
		domains: []string{"mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru"}, mxHints: []string{"mail.ru"}},
	// Rambler https://help.rambler.ru/mail/mobile/2037. lenta.ru and ro.ru
	// publish the same inmx.rambler.ru MX.
	{name: "Rambler", imap: "imap.rambler.ru", smtp: "smtp.rambler.ru", smtpPort: 465, smtpTLS: "tls",
		note:    "Allow mail programs in Rambler mail settings first.",
		help:    "https://help.rambler.ru/mail/mobile/2037",
		domains: []string{"rambler.ru"}, mxHints: []string{"rambler.ru"}},
	// GMX international https://support.gmx.com/pop-imap/imap/server.html.
	// gmx.com publishes mx00.gmx.net; gmx.de and gmx.net publish
	// mx00.emig.gmx.net, matched by the longer hint below.
	{name: "GMX", imap: "imap.gmx.com", smtp: "mail.gmx.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn on POP3 & IMAP in GMX settings first.",
		help:    "https://support.gmx.com/pop-imap/toggle.html",
		domains: []string{"gmx.com"}, mxHints: []string{"gmx.net"}},
	// GMX Germany https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html.
	{name: "GMX", imap: "imap.gmx.net", smtp: "mail.gmx.net", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn on POP3 & IMAP in GMX settings first.",
		help:    "https://hilfe.gmx.net/pop-imap/imap/imap-serverdaten.html",
		domains: []string{"gmx.de", "gmx.net"}, mxHints: []string{"emig.gmx.net"}},
	// WEB.DE https://hilfe.web.de/pop-imap/imap/imap-serverdaten.html.
	{name: "WEB.DE", imap: "imap.web.de", smtp: "smtp.web.de", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn on POP3 & IMAP in WEB.DE settings first.",
		help:    "https://hilfe.web.de/pop-imap/imap/imap-serverdaten.html",
		domains: []string{"web.de"}, mxHints: []string{"web.de"}},
	// mail.com https://support.mail.com/pop-imap/imap/server.html; its many
	// domains (https://www.mail.com/mail/domains/) publish mx00.mail.com.
	{name: "mail.com", imap: "imap.mail.com", smtp: "smtp.mail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "IMAP is a mail.com Premium feature and has to be turned on in its settings first.",
		help:    "https://support.mail.com/pop-imap/toggle.html",
		domains: []string{"mail.com", "email.com", "usa.com", "post.com", "consultant.com", "engineer.com", "europe.com", "asia.com"},
		mxHints: []string{"mail.com"}},
	// Seznam https://o-seznam.cz/napoveda/email/mohlo-by-se-hodit/postovni-programy-a-aplikace/.
	// email.cz and post.cz publish the same mx1.seznam.cz MX.
	{name: "Seznam", imap: "imap.seznam.cz", smtp: "smtp.seznam.cz", smtpPort: 465, smtpTLS: "tls",
		note:    "With two-step verification on, Seznam needs an app password.",
		help:    "https://o-seznam.cz/napoveda/email/mohlo-by-se-hodit/postovni-programy-a-aplikace/",
		domains: []string{"seznam.cz", "email.cz", "post.cz"}, mxHints: []string{"seznam.cz"}},
	// Daum https://cs.daum.net/faq/service/43/category/9234/detail/17988.
	{name: "Daum", imap: "imap.daum.net", smtp: "smtp.daum.net", smtpPort: 465, smtpTLS: "tls",
		note:    "Daum needs two-step verification and an app password, and IMAP turned on under Mail settings → IMAP/POP3.",
		help:    "https://cs.daum.net/faq/service/43/category/9234/detail/17988",
		domains: []string{"daum.net", "hanmail.net"}, mxHints: []string{"hanmail.net"}},
	// Orange https://assistance.orange.fr/ordinateurs-peripheriques/installer-et-utiliser/l-utilisation-du-mail-et-services-associes/mail-orange/parametrer-la-boite-mail/mail-orange-comment-acceder-a-sa-boite-mail-orange-depuis-une-application-ou-un-logiciel-de-messagerie-non-fourni-par-orange_434630-964290
	{name: "Orange", imap: "imap.orange.fr", smtp: "smtp.orange.fr", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn on POP/IMAP access in Orange Mail settings (Security → POP or IMAP protocols) first.",
		help:    "https://assistance.orange.fr/ordinateurs-peripheriques/installer-et-utiliser/l-utilisation-du-mail-et-services-associes/mail-orange/parametrer-la-boite-mail/mail-orange-comment-activer-ou-desactiver-les-acces-pop-imap-pour-les-logiciels-ou-applications-de-messagerie-tiers_427398-957069",
		domains: []string{"orange.fr", "wanadoo.fr"}, mxHints: []string{"orange.fr"}},
	// Free https://assistance.free.fr/articles/609
	{name: "Free", imap: "imap.free.fr", smtp: "smtp.free.fr", smtpPort: 587, smtpTLS: "starttls",
		help:    "https://assistance.free.fr/articles/609",
		domains: []string{"free.fr"}, mxHints: []string{"free.fr"}},
	// SFR https://assistance.sfr.fr/sfrmail-appli/sfrmail/configurer-messagerie-recevoir-email-sfr.html
	{name: "SFR", imap: "imap.sfr.fr", smtp: "smtp.sfr.fr", smtpPort: 465, smtpTLS: "tls",
		help:    "https://assistance.sfr.fr/sfrmail-appli/sfrmail/configurer-messagerie-recevoir-email-sfr.html",
		domains: []string{"sfr.fr", "neuf.fr", "cegetel.net", "9online.fr"}, mxHints: []string{"sfr.fr"}},
	// La Poste https://aide.laposte.net/contents/comment-parametrer-un-logiciel-de-messagerie-pour-envoyer-et-recevoir-mes-courriers-electroniques
	{name: "La Poste", imap: "imap.laposte.net", smtp: "smtp.laposte.net", smtpPort: 587, smtpTLS: "starttls",
		help:    "https://aide.laposte.net/contents/comment-parametrer-un-logiciel-de-messagerie-pour-envoyer-et-recevoir-mes-courriers-electroniques",
		domains: []string{"laposte.net"}, mxHints: []string{"laposte.net"}},
	// T-Online https://www.telekom.de/hilfe/apps-dienste/e-mail/einstellungen/posteingang-postausgang-server
	{name: "T-Online", imap: "secureimap.t-online.de", smtp: "securesmtp.t-online.de", smtpPort: 465, smtpTLS: "tls",
		note:    "T-Online needs its separate password for e-mail programs, not your login password.",
		help:    "https://www.telekom.de/hilfe/apps-dienste/e-mail/einstellungen/posteingang-postausgang-server",
		domains: []string{"t-online.de", "magenta.de"}, mxHints: []string{"t-online.de"}},
	// Libero https://aiuto.libero.it/articolo/mail/configurare-libero-mail-con-client-di-posta-imap-e-smtp/
	{name: "Libero", imap: "imapmail.libero.it", smtp: "smtp.libero.it", smtpPort: 465, smtpTLS: "tls",
		help:    "https://aiuto.libero.it/articolo/mail/configurare-libero-mail-con-client-di-posta-imap-e-smtp/",
		domains: []string{"libero.it", "iol.it", "inwind.it", "blu.it"}, mxHints: []string{"libero.it"}},
	// Virgilio https://aiuto.virgilio.it/articolo/mail/configurare-virgilio-mail-con-client-di-posta-imap-e-smtp/
	{name: "Virgilio", imap: "in.virgilio.it", smtp: "out.virgilio.it", smtpPort: 465, smtpTLS: "tls",
		help:    "https://aiuto.virgilio.it/articolo/mail/configurare-virgilio-mail-con-client-di-posta-imap-e-smtp/",
		domains: []string{"virgilio.it"}, mxHints: []string{"virgilio.it"}},
	// mailbox.org https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/,
	// custom domains https://kb.mailbox.org/en/private/custom-domains/using-emails-with-a-custom-domain/.
	{name: "mailbox.org", imap: "imap.mailbox.org", smtp: "smtp.mailbox.org", smtpPort: 465, smtpTLS: "tls",
		note:    "With two-factor sign-in on, mailbox.org needs a mail app password (Settings → Security).",
		help:    "https://kb.mailbox.org/en/private/e-mail/e-mail-configuration/",
		domains: []string{"mailbox.org"}, mxHints: []string{"mailbox.org"}},
	// Posteo https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp
	{name: "Posteo", imap: "posteo.de", smtp: "posteo.de", smtpPort: 465, smtpTLS: "tls",
		help: "https://posteo.de/en/help/how-do-i-set-up-posteo-in-an-email-client-pop3-imap-and-smtp",
		domains: []string{"posteo.de", "posteo.com", "posteo.net", "posteo.us", "posteo.ca", "posteo.uk", "posteo.ie",
			"posteo.es", "posteo.at", "posteo.ch", "posteo.nl", "posteo.be", "posteo.lu"},
		mxHints: []string{"posteo.de"}},
	// Purelymail https://purelymail.com/docs/setup/technical, MX
	// https://purelymail.com/docs/domainDocs.
	{name: "Purelymail", imap: "imap.purelymail.com", smtp: "smtp.purelymail.com", smtpPort: 465, smtpTLS: "tls",
		note:    "With two-factor sign-in on, Purelymail needs an app password.",
		help:    "https://purelymail.com/docs/setup/technical",
		domains: []string{"purelymail.com"}, mxHints: []string{"purelymail.com"}},
	// Runbox https://help.runbox.com/email-program-settings/, MX
	// https://help.runbox.com/moving-your-domains-email-to-runbox/.
	{name: "Runbox", imap: "mail.runbox.com", smtp: "mail.runbox.com", smtpPort: 465, smtpTLS: "tls",
		note:    "Sign in with your primary Runbox address, not an alias.",
		help:    "https://help.runbox.com/email-program-settings/",
		domains: []string{"runbox.com", "runbox.no"}, mxHints: []string{"runbox.com"}},
	// Mailfence https://kb.mailfence.com/kb/how-can-use-mailfence-messages-with-thunderbird-using-smtp-and-imap-pop/
	{name: "Mailfence", imap: "imap.mailfence.com", smtp: "smtp.mailfence.com", smtpPort: 465, smtpTLS: "tls",
		note:    "IMAP is on Mailfence paid plans only; with two-factor sign-in use a service password (Settings → Account → Security).",
		help:    "https://kb.mailfence.com/kb/how-can-use-mailfence-messages-with-thunderbird-using-smtp-and-imap-pop/",
		domains: []string{"mailfence.com"}, mxHints: []string{"mailfence.com"}},
	// Migadu https://migadu.com/guides/. Its MX (aspmx1.migadu.com) is set per
	// domain in its admin panel; the hint is what hosted domains publish.
	{name: "Migadu", imap: "imap.migadu.com", smtp: "smtp.migadu.com", smtpPort: 465, smtpTLS: "tls",
		help:    "https://migadu.com/guides/",
		mxHints: []string{"migadu.com"}},

	// Hosts for your own domain, recognised by MX.

	// Rackspace https://docs.rackspace.com/docs/rackspace-email-settings, MX
	// https://docs.rackspace.com/docs/dns-record-definitions.
	{name: "Rackspace Email", imap: "secure.emailsrvr.com", smtp: "secure.emailsrvr.com", smtpPort: 465, smtpTLS: "tls",
		help:    "https://docs.rackspace.com/docs/rackspace-email-settings",
		mxHints: []string{"emailsrvr.com"}},
	// GoDaddy Professional Email
	// https://www.godaddy.com/help/use-imap-settings-to-add-my-professional-email-to-a-client-32204;
	// its DNS help shows smtp.secureserver.net as the MX.
	{name: "GoDaddy Email", imap: "imap.secureserver.net", smtp: "smtpout.secureserver.net", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.godaddy.com/help/use-imap-settings-to-add-my-professional-email-to-a-client-32204",
		mxHints: []string{"secureserver.net"}},
	// Namecheap https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices,
	// MX https://www.namecheap.com/support/knowledgebase/article.aspx/1340/2176/namecheap-private-email-records-for-domains-with-thirdparty-dns/.
	{name: "Namecheap Private Email", imap: "mail.privateemail.com", smtp: "mail.privateemail.com", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices",
		mxHints: []string{"privateemail.com"}},
	// Spacemail https://www.spaceship.com/knowledgebase/connect-spacemail-to-email-client/,
	// MX https://www.spaceship.com/knowledgebase/spacemail-dns-records-third-party-domain/.
	{name: "Spacemail", imap: "mail.spacemail.com", smtp: "mail.spacemail.com", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.spaceship.com/knowledgebase/connect-spacemail-to-email-client/",
		mxHints: []string{"spacemail.com"}},
	// IONOS: servers per country, told apart by the MX the customer was given.
	// https://www.ionos.com/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/,
	// https://www.ionos.de/hilfe/e-mail/allgemeine-themen/serverinformationen-fuer-imap-pop3-und-smtp/,
	// https://www.ionos.co.uk/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/;
	// MX https://www.ionos.co.uk/help/email/troubleshooting-mail-basic-mail-business/adjusting-mx-records-for-receiving-email-via-ionos-mail-servers/
	// and https://www.ionos.de/hilfe/e-mail/problemloesungen-mail-basicmail-business/mx-eintraege-fuer-e-mail-empfang-ueber-ionos-mailserver-anpassen/.
	{name: "IONOS", imap: "imap.ionos.com", smtp: "smtp.ionos.com", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.ionos.com/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/",
		mxHints: []string{"ionos.com", "1and1.com"}},
	{name: "IONOS", imap: "imap.ionos.de", smtp: "smtp.ionos.de", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.ionos.de/hilfe/e-mail/allgemeine-themen/serverinformationen-fuer-imap-pop3-und-smtp/",
		mxHints: []string{"ionos.de", "kundenserver.de"}},
	{name: "IONOS", imap: "imap.ionos.co.uk", smtp: "smtp.ionos.co.uk", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.ionos.co.uk/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/",
		mxHints: []string{"ionos.co.uk", "1and1.co.uk"}},
	// OVHcloud MX Plan https://docs.ovhcloud.com/en/guides/web-cloud/email-and-collaborative-solutions/mx-plan/email-generalities,
	// MX https://docs.ovhcloud.com/en/guides/web-cloud/domains/dns-zone-mx.
	{name: "OVHcloud", imap: "imap.mail.ovh.net", smtp: "smtp.mail.ovh.net", smtpPort: 465, smtpTLS: "tls",
		note:    "These are the MX Plan servers. Email Pro uses pro<N>.mail.ovh.net (port 587, STARTTLS for sending), with N shown in the OVHcloud control panel.",
		help:    "https://docs.ovhcloud.com/en/guides/web-cloud/email-and-collaborative-solutions/mx-plan/email-generalities",
		mxHints: []string{"mail.ovh.net"}},
	// Hostinger https://www.hostinger.com/support/1575756-how-to-get-email-account-configuration-details-for-hostinger-email/,
	// MX https://www.hostinger.com/support/4407237-hostinger-email-mx-records/.
	{name: "Hostinger Email", imap: "imap.hostinger.com", smtp: "smtp.hostinger.com", smtpPort: 465, smtpTLS: "tls",
		note:    "With two-factor sign-in on, Hostinger needs an app password.",
		help:    "https://www.hostinger.com/support/1575756-how-to-get-email-account-configuration-details-for-hostinger-email/",
		mxHints: []string{"hostinger.com"}},
	// Titan https://support.titan.email/hc/en-us/articles/900000215446-Configure-Titan-on-other-apps-using-IMAP-POP,
	// MX https://www.hostinger.com/support/7056556-what-are-titan-email-mx-records/.
	{name: "Titan Email", imap: "imap.titan.email", smtp: "smtp.titan.email", smtpPort: 465, smtpTLS: "tls",
		note:    "Turn on access from other apps in Titan webmail first; with two-factor sign-in use an app password. Some EU accounts use imap0101.titan.email and smtp0101.titan.email.",
		help:    "https://support.titan.email/hc/en-us/articles/900000215446-Configure-Titan-on-other-apps-using-IMAP-POP",
		mxHints: []string{"titan.email"}},
	// Infomaniak https://www.infomaniak.com/en/support/faq/2427/manually-configure-your-emails-contacts-and-calendars-on-your-devices,
	// MX https://www.infomaniak.com/en/support/faq/2110/manage-mx-records.
	{name: "Infomaniak", imap: "mail.infomaniak.com", smtp: "mail.infomaniak.com", smtpPort: 587, smtpTLS: "starttls",
		note:    "Use the password created for this mailbox, not your Infomaniak account password.",
		help:    "https://www.infomaniak.com/en/support/faq/2427/manually-configure-your-emails-contacts-and-calendars-on-your-devices",
		mxHints: []string{"infomaniak.ch"}},
	// STRATO https://www.strato-hosting.co.uk/faq/product/the-strato-email-server,
	// MX https://www.strato.de/faq/domains/wie-lauten-die-dns-standard-einstellungen-fuer-meine-domain.
	{name: "STRATO", imap: "imap.strato.de", smtp: "smtp.strato.de", smtpPort: 465, smtpTLS: "tls",
		help:    "https://www.strato-hosting.co.uk/faq/product/the-strato-email-server",
		mxHints: []string{"rzone.de"}},
}

func (p preset) settings(source string) Settings {
	s := Settings{Provider: p.name, IMAPHost: p.imap, IMAPPort: 993, IMAPTLS: "tls",
		SMTPHost: p.smtp, SMTPPort: p.smtpPort, SMTPTLS: p.smtpTLS, Note: p.note, HelpURL: p.help,
		Known: true, Source: source}
	if p.imapPort != 0 {
		s.IMAPPort, s.IMAPTLS = p.imapPort, p.imapTLS
	}
	return s
}

// byMX is a preset reached through a custom domain's MX record.
func (p preset) byMX(email string) Settings {
	s := p.settings(SourceMX)
	if p.mxName != "" {
		s.Provider = p.mxName
	}
	if p.mxNote != "" {
		s.Note = p.mxNote
	}
	if p.name == "iCloud" {
		// iCloud+ custom domain: the sign-in is the @icloud.com address, the
		// mail is still yours.
		s.Note += " Mail is still sent from " + strings.ToLower(email) + "."
		s.NeedsUsername = true
	}
	return s
}

// MXLookup resolves MX hosts; replaced in tests.
var MXLookup = func(ctx context.Context, domain string) ([]string, error) {
	mx, err := net.DefaultResolver.LookupMX(ctx, domain)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(mx))
	for i, m := range mx {
		out[i] = strings.TrimSuffix(strings.ToLower(m.Host), ".")
	}
	return out, nil
}

// byMXHost finds the preset whose hint matches an MX host. The longest hint
// wins, so mx-att.mail.am0.yahoodns.net is AT&T and not Yahoo, and
// emig.gmx.net is GMX Germany and not GMX international.
func byMXHost(mx []string) (preset, bool) {
	var best preset
	bestLen := 0
	for _, host := range mx {
		for _, p := range presets {
			for _, h := range p.mxHints {
				if (host == h || strings.HasSuffix(host, "."+h)) && len(h) > bestLen {
					best, bestLen = p, len(h)
				}
			}
		}
		if bestLen > 0 {
			// The first MX host that matches anything decides.
			return best, true
		}
	}
	return preset{}, false
}

// Guess returns server settings for an address. In order: a known host by
// domain; a known host by the domain's MX record (a custom domain on Google
// Workspace, Microsoft 365, iCloud+, Zoho, a web host); the domain's RFC 6186
// SRV records; the domain's own Thunderbird-format autoconfig file; and last
// the conventional imap./smtp. names. Every network question goes to the
// user's own domain or its DNS; no third-party directory is asked.
func Guess(ctx context.Context, email string) Settings {
	email = strings.TrimSpace(email)
	at := strings.LastIndexByte(email, '@')
	if at < 0 {
		return Settings{}
	}
	domain := strings.ToLower(strings.TrimSpace(email[at+1:]))
	if domain == "" {
		return Settings{}
	}
	for _, p := range presets {
		for _, d := range p.domains {
			if d == domain {
				return p.settings(SourcePreset)
			}
		}
	}
	if p, ok := byMXHost(mxHosts(ctx, domain)); ok {
		return p.byMX(email)
	}
	if s, ok := srvSettings(ctx, domain); ok {
		return s
	}
	if s, ok := autoconfigSettings(ctx, domain, strings.ToLower(email)); ok {
		return s
	}
	return Settings{Provider: domain, IMAPHost: "imap." + domain, IMAPPort: 993, IMAPTLS: "tls",
		SMTPHost: "smtp." + domain, SMTPPort: 465, SMTPTLS: "tls", Source: SourceGuess}
}
