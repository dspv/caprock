package spam

import (
	"sort"
	"strings"
)

// The static lists below are small on purpose: each one feeds a rule worth a
// few points, never a verdict on its own, and the learning classifier covers
// whatever they miss.

// brands are names phishing mail puts in the From display name. The value is
// the domains (registrable part) that may legitimately send under that name;
// a brand whose domain merely contains the key (paypal.de, amazon.co.uk) is
// accepted by the containment check in brandSpoof.
var brands = map[string][]string{
	"paypal":           {"paypal.com"},
	"apple":            {"apple.com", "icloud.com", "me.com"},
	"icloud":           {"apple.com", "icloud.com"},
	"amazon":           {"amazon.com", "amazonses.com", "amazon.co.uk"},
	"microsoft":        {"microsoft.com", "outlook.com", "office.com", "live.com"},
	"office 365":       {"microsoft.com", "office.com", "office365.com"},
	"outlook":          {"microsoft.com", "outlook.com"},
	"netflix":          {"netflix.com"},
	"google":           {"google.com", "gmail.com", "youtube.com"},
	"facebook":         {"facebook.com", "facebookmail.com", "meta.com"},
	"instagram":        {"instagram.com", "facebookmail.com", "mail.instagram.com"},
	"whatsapp":         {"whatsapp.com"},
	"dhl":              {"dhl.com", "dhl.de"},
	"fedex":            {"fedex.com"},
	"ups":              {"ups.com"},
	"usps":             {"usps.com"},
	"docusign":         {"docusign.com", "docusign.net"},
	"dropbox":          {"dropbox.com", "dropboxmail.com"},
	"coinbase":         {"coinbase.com"},
	"binance":          {"binance.com"},
	"metamask":         {"metamask.io"},
	"wells fargo":      {"wellsfargo.com"},
	"bank of america":  {"bankofamerica.com", "bofa.com"},
	"american express": {"americanexpress.com", "aexp.com"},
	"linkedin":         {"linkedin.com"},
	"spotify":          {"spotify.com"},
	"adobe":            {"adobe.com"},
	"norton":           {"norton.com", "nortonlifelock.com"},
	"mcafee":           {"mcafee.com"},
	"geek squad":       {"geeksquad.com", "bestbuy.com"},
	"irs":              {"irs.gov"},
	"walmart":          {"walmart.com"},
	"costco":           {"costco.com"},
	"ebay":             {"ebay.com"},
	"stripe":           {"stripe.com"},
}

// brandNames is brands' keys, longest first, so "office 365" is tried before
// "outlook" and the answer never depends on map order.
var brandNames = func() []string {
	ks := make([]string, 0, len(brands))
	for k := range brands {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool {
		if len(ks[i]) != len(ks[j]) {
			return len(ks[i]) > len(ks[j])
		}
		return ks[i] < ks[j]
	})
	return ks
}()

// brandDomains is every domain in brands, for the deceptive-link rule.
var brandDomains = func() map[string]bool {
	m := map[string]bool{}
	for _, ds := range brands {
		for _, d := range ds {
			m[d] = true
		}
	}
	return m
}()

// freemail domains: anyone can get an address there, so a Reply-To pointing
// to one from a company's From is a classic way to collect answers.
var freemail = setOf(
	"gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com",
	"msn.com", "aol.com", "icloud.com", "me.com", "mail.com", "gmx.com", "gmx.net", "gmx.de", "web.de",
	"yandex.com", "yandex.ru", "mail.ru", "proton.me", "protonmail.com", "zoho.com", "qq.com", "163.com",
	"126.com", "inbox.com", "tutanota.com", "rambler.ru",
)

// shorteners hide where a link goes; legitimate senders rarely need them.
var shorteners = setOf(
	"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly",
	"shorturl.at", "rb.gy", "t.ly", "tiny.cc", "bl.ink", "lnkd.in", "s.id", "v.gd", "qr.ae", "short.io",
	"shorte.st", "adf.ly", "bitly.com", "clck.ru", "u.to",
)

// cheapTLDs are top-level domains where spam far outweighs everything else
// (the ones public abuse rankings such as Spamhaus's keep listing). Worth a
// little, never alone.
var cheapTLDs = setOf(
	"top", "xyz", "click", "icu", "buzz", "rest", "cyou", "monster", "cfd", "sbs", "bond", "lol",
	"quest", "zip", "mov", "gq", "tk", "ml", "cf", "ga", "work", "loan", "win", "bid", "date",
	"party", "racing", "review", "stream", "download", "country", "kim", "men", "science",
)

// secondLevel are public suffixes with two labels, so registrable() keeps three.
var secondLevel = setOf(
	"co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp",
	"co.nz", "com.br", "com.mx", "com.ar", "co.in", "co.za", "com.tr", "com.cn", "com.hk", "com.sg",
	"co.kr", "com.tw", "co.il", "com.ua", "com.pl", "com.es", "co.id", "com.my", "com.ph",
)

func setOf(xs ...string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// domainOf is the lower-case part after the last @, or "".
func domainOf(addr string) string {
	addr = strings.ToLower(strings.TrimSpace(addr))
	i := strings.LastIndexByte(addr, '@')
	if i < 0 {
		return ""
	}
	return strings.Trim(addr[i+1:], "<>. ")
}

// registrable approximates the registrable domain: the last two labels, or
// three under a known two-label public suffix. Good enough to tell
// mail.paypal.com from paypal.com.evil.top without a public suffix list.
func registrable(host string) string {
	host = strings.Trim(strings.ToLower(host), ". ")
	labels := strings.Split(host, ".")
	if len(labels) <= 2 {
		return host
	}
	last2 := strings.Join(labels[len(labels)-2:], ".")
	if secondLevel[last2] && len(labels) >= 3 {
		return strings.Join(labels[len(labels)-3:], ".")
	}
	return last2
}

func tldOf(host string) string {
	if i := strings.LastIndexByte(host, '.'); i >= 0 {
		return host[i+1:]
	}
	return ""
}
