package spam

import (
	"html"
	"net/url"
	"regexp"
	"strings"
)

// Body is what the rules read from a message's decoded text and HTML.
type Body struct {
	Text string
	HTML string
}

// bodyFacts are counted once per verdict.
type bodyFacts struct {
	textLen    int      // visible characters, links excluded
	images     int      // <img> tags
	links      int      // http(s) links
	hosts      []string // every link's host, lower case, deduplicated
	shortener  bool     // a link through a URL shortener
	deceptive  bool     // a link whose text names another domain than it goes to
	hasContent bool     // a body was fetched at all
}

var (
	reAnchor   = regexp.MustCompile(`(?is)<a\b[^>]*?href\s*=\s*["']?(https?://[^"'\s>]+)[^>]*>(.*?)</a>`)
	reImg      = regexp.MustCompile(`(?i)<img\b`)
	reURL      = regexp.MustCompile(`(?i)https?://[^\s<>"'()]+`)
	reAnyTag   = regexp.MustCompile(`(?s)<[^>]*>`)
	reDropping = regexp.MustCompile(`(?is)<(style|script|head|title)[^>]*>.*?</(style|script|head|title)>`)
	reDomainy  = regexp.MustCompile(`(?i)^(?:https?://)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/:?#].*)?$`)
	reSpace    = regexp.MustCompile(`\s+`)
)

const maxBodyScan = 200 << 10 // the rules read the first 200 KB of each part

func clip(s string) string {
	if len(s) > maxBodyScan {
		return s[:maxBodyScan]
	}
	return s
}

func readBody(b Body) bodyFacts {
	var f bodyFacts
	text, h := clip(b.Text), clip(b.HTML)
	f.hasContent = strings.TrimSpace(text) != "" || strings.TrimSpace(h) != ""
	hosts := map[string]bool{}
	addHost := func(raw string) {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return
		}
		host := strings.ToLower(u.Hostname())
		if !hosts[host] {
			hosts[host] = true
			f.hosts = append(f.hosts, host)
		}
		if shorteners[host] || shorteners[strings.TrimPrefix(host, "www.")] {
			f.shortener = true
		}
	}
	visible := text
	if h != "" {
		f.images = len(reImg.FindAllStringIndex(h, -1))
		for _, m := range reAnchor.FindAllStringSubmatch(h, -1) {
			f.links++
			addHost(m[1])
			label := strings.TrimSpace(html.UnescapeString(reAnyTag.ReplaceAllString(m[2], "")))
			if dm := reDomainy.FindStringSubmatch(label); dm != nil {
				// Only a brand's own domain counts: newsletters routinely show
				// their site and link through a click tracker, phishing shows
				// paypal.com and links elsewhere.
				shown := registrable(dm[1])
				if u, err := url.Parse(m[1]); err == nil && u.Host != "" && brandDomains[shown] {
					if real := registrable(u.Hostname()); real != shown {
						f.deceptive = true
					}
				}
			}
		}
		s := reDropping.ReplaceAllString(h, " ")
		s = reAnyTag.ReplaceAllString(s, " ")
		visible = html.UnescapeString(s)
	}
	for _, u := range reURL.FindAllString(text, -1) {
		if h == "" {
			f.links++
		}
		addHost(u)
	}
	visible = reURL.ReplaceAllString(visible, " ")
	visible = reSpace.ReplaceAllString(visible, " ")
	f.textLen = len([]rune(strings.TrimSpace(visible)))
	return f
}
