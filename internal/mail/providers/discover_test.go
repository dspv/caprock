package providers

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// offline replaces every network hook for one test: MX, SRV and HTTP. A hook
// left nil answers "nothing here", so no test ever reaches the network.
func offline(t *testing.T, mx map[string][]string, srv map[string][]*net.SRV, handler http.Handler) *[]string {
	t.Helper()
	origMX, origSRV, origHTTP := MXLookup, SRVLookup, HTTPClient
	t.Cleanup(func() { MXLookup, SRVLookup, HTTPClient = origMX, origSRV, origHTTP })
	MXLookup = func(_ context.Context, d string) ([]string, error) { return mx[d], nil }
	SRVLookup = func(_ context.Context, service, proto, domain string) ([]*net.SRV, error) {
		if r, ok := srv["_"+service+"._"+proto+"."+domain]; ok {
			return r, nil
		}
		return nil, errors.New("no such record")
	}
	var seen []string
	if handler == nil {
		handler = http.NotFoundHandler()
	}
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)
	target, _ := url.Parse(ts.URL)
	var mu sync.Mutex
	HTTPClient = &http.Client{Transport: rewrite{target: target, record: func(u string) {
		mu.Lock()
		seen = append(seen, u)
		mu.Unlock()
	}}}
	return &seen
}

// rewrite sends every request to the test server, keeping the Host header,
// and records the URL the code asked for.
type rewrite struct {
	target *url.URL
	record func(string)
}

func (rw rewrite) RoundTrip(r *http.Request) (*http.Response, error) {
	rw.record(r.URL.String())
	r2 := r.Clone(r.Context())
	r2.URL.Scheme, r2.URL.Host = rw.target.Scheme, rw.target.Host
	r2.Host = r.URL.Host
	return http.DefaultTransport.RoundTrip(r2)
}

func TestGuessSRV(t *testing.T) {
	offline(t, nil, map[string][]*net.SRV{
		"_imaps._tcp.srv.example":        {{Target: ".", Port: 0}, {Target: "mail.srv.example.", Port: 993}},
		"_imap._tcp.srv.example":         {{Target: "imap.srv.example.", Port: 143}},
		"_submission._tcp.srv.example":   {{Target: "smtp.srv.example.", Port: 587}},
		"_imap._tcp.plain.example":       {{Target: "imap.plain.example.", Port: 143}},
		"_submissions._tcp.only.example": {{Target: "out.only.example.", Port: 465}},
	}, nil)
	g := Guess(context.Background(), "me@srv.example")
	if g.Source != SourceSRV || g.IMAPHost != "mail.srv.example" || g.IMAPPort != 993 || g.IMAPTLS != "tls" ||
		g.SMTPHost != "smtp.srv.example" || g.SMTPPort != 587 || g.SMTPTLS != "starttls" || !g.Known {
		t.Errorf("srv: %+v", g)
	}
	g = Guess(context.Background(), "me@plain.example")
	if g.Source != SourceSRV || g.IMAPHost != "imap.plain.example" || g.IMAPPort != 143 || g.IMAPTLS != "starttls" ||
		g.SMTPHost != "smtp.plain.example" || g.SMTPPort != 465 {
		t.Errorf("srv without submission: %+v", g)
	}
	// A submission record alone does not say where the mailbox is.
	if g = Guess(context.Background(), "me@only.example"); g.Source != SourceGuess {
		t.Errorf("submission only: %+v", g)
	}
}

const autoconfigXML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="corp.example">
    <domain>corp.example</domain>
    <displayName>Corp Mail</displayName>
    <displayShortName>Corp</displayShortName>
    <incomingServer type="pop3">
      <hostname>pop.corp.example</hostname><port>995</port><socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>plain.corp.example</hostname><port>143</port><socketType>plain</socketType>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
      <username>%EMAILLOCALPART%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.corp.example</hostname><port>587</port><socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

func TestGuessAutoconfig(t *testing.T) {
	seen := offline(t, nil, nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Host == "autoconfig.corp.example" && r.URL.Path == "/mail/config-v1.1.xml":
			if r.URL.Query().Get("emailaddress") != "ann@corp.example" {
				http.Error(w, "no address", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(autoconfigXML))
		case r.Host == "wk.example" && r.URL.Path == "/.well-known/autoconfig/mail/config-v1.1.xml":
			_, _ = w.Write([]byte(strings.ReplaceAll(autoconfigXML, "%EMAILLOCALPART%", "%EMAILADDRESS%")))
		case r.Host == "broken.example":
			_, _ = w.Write([]byte(`<clientConfig><emailProvider><incomingServer type="imap"><hostname>x`))
		case r.Host == "away.example":
			http.Redirect(w, r, "https://elsewhere.example/config.xml", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))

	g := Guess(context.Background(), "ann@corp.example")
	if g.Source != SourceAutoconfig || g.Provider != "Corp" || g.IMAPHost != "imap.corp.example" || g.IMAPPort != 993 ||
		g.IMAPTLS != "tls" || g.SMTPHost != "smtp.corp.example" || g.SMTPPort != 587 || g.SMTPTLS != "starttls" ||
		g.Username != "ann" || !g.NeedsUsername || !g.Known {
		t.Errorf("autoconfig: %+v", g)
	}

	g = Guess(context.Background(), "bob@wk.example")
	if g.Source != SourceAutoconfig || g.IMAPHost != "imap.wk.example" || g.Username != "" || g.NeedsUsername {
		t.Errorf("well-known: %+v", g)
	}

	for _, addr := range []string{"x@broken.example", "x@away.example", "x@nothing.example"} {
		g = Guess(context.Background(), addr)
		domain := addr[strings.IndexByte(addr, '@')+1:]
		if g.Source != SourceGuess || g.IMAPHost != "imap."+domain || g.Known {
			t.Errorf("%s should fall through to the guess: %+v", addr, g)
		}
	}

	// Only the user's own domain is ever asked.
	for _, u := range *seen {
		host, _ := url.Parse(u)
		if !strings.HasSuffix(host.Hostname(), ".example") || strings.Contains(u, "elsewhere") {
			t.Errorf("asked a third party: %s", u)
		}
	}
	want := "https://autoconfig.corp.example/mail/config-v1.1.xml?emailaddress=ann%40corp.example"
	found := false
	for _, u := range *seen {
		found = found || u == want
	}
	if !found {
		t.Errorf("never asked %s; asked %v", want, *seen)
	}
}

func TestPresetSkipsTheNetwork(t *testing.T) {
	seen := offline(t, nil, nil, nil)
	if g := Guess(context.Background(), "a@gmail.com"); g.Source != SourcePreset {
		t.Fatalf("gmail: %+v", g)
	}
	if len(*seen) != 0 {
		t.Errorf("a preset domain made requests: %v", *seen)
	}
}

func TestParseAutoconfigRejectsPlainOnly(t *testing.T) {
	plain := strings.ReplaceAll(strings.ReplaceAll(autoconfigXML, "SSL", "plain"), "STARTTLS", "plain")
	if _, ok := parseAutoconfig([]byte(plain), "corp.example", "a@corp.example"); ok {
		t.Error("a plain-text-only config was accepted")
	}
}
