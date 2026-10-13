package providers

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// LookupTimeout bounds each discovery step: the MX lookup, the SRV lookups
// and each autoconfig fetch.
var LookupTimeout = 3 * time.Second

// SRVLookup resolves an RFC 6186 service record (`_service._proto.domain`);
// replaced in tests.
var SRVLookup = func(ctx context.Context, service, proto, domain string) ([]*net.SRV, error) {
	_, addrs, err := net.DefaultResolver.LookupSRV(ctx, service, proto, domain)
	return addrs, err
}

// HTTPClient fetches a domain's autoconfig file; replaced in tests. It
// follows a redirect only within the user's own domain (see sameDomain), so
// the address never reaches a third party.
var HTTPClient = &http.Client{}

// srvSettings reads RFC 6186 records: _imaps / _imap for the mailbox,
// _submissions / _submission for sending. Implicit TLS wins over STARTTLS, as
// the RFC 8314 update recommends. The mailbox record is required; without a
// submission record the conventional smtp. name is used.
func srvSettings(ctx context.Context, domain string) (Settings, bool) {
	ctx, cancel := context.WithTimeout(ctx, LookupTimeout)
	defer cancel()
	services := []string{"imaps", "imap", "submissions", "submission"}
	found := make([]*net.SRV, len(services))
	var wg sync.WaitGroup
	for i, svc := range services {
		wg.Add(1)
		go func() {
			defer wg.Done()
			addrs, err := SRVLookup(ctx, svc, "tcp", domain)
			if err != nil {
				return
			}
			for _, a := range addrs {
				// A target of "." means the service is not offered (RFC 2782).
				if host := strings.TrimSuffix(strings.ToLower(a.Target), "."); host != "" && a.Port != 0 {
					found[i] = &net.SRV{Target: host, Port: a.Port}
					return
				}
			}
		}()
	}
	wg.Wait()
	s := Settings{Provider: domain, Known: true, Source: SourceSRV}
	switch {
	case found[0] != nil:
		s.IMAPHost, s.IMAPPort, s.IMAPTLS = found[0].Target, int(found[0].Port), "tls"
	case found[1] != nil:
		s.IMAPHost, s.IMAPPort, s.IMAPTLS = found[1].Target, int(found[1].Port), "starttls"
	default:
		return Settings{}, false
	}
	switch {
	case found[2] != nil:
		s.SMTPHost, s.SMTPPort, s.SMTPTLS = found[2].Target, int(found[2].Port), "tls"
	case found[3] != nil:
		s.SMTPHost, s.SMTPPort, s.SMTPTLS = found[3].Target, int(found[3].Port), "starttls"
	default:
		s.SMTPHost, s.SMTPPort, s.SMTPTLS = "smtp."+domain, 465, "tls"
	}
	return s, true
}

// clientConfig is the Thunderbird autoconfig format, config-v1.1.xml
// (https://wiki.mozilla.org/Thunderbird:Autoconfiguration:ConfigFileFormat).
type clientConfig struct {
	XMLName  xml.Name `xml:"clientConfig"`
	Provider struct {
		DisplayName      string         `xml:"displayName"`
		DisplayShortName string         `xml:"displayShortName"`
		Incoming         []configServer `xml:"incomingServer"`
		Outgoing         []configServer `xml:"outgoingServer"`
	} `xml:"emailProvider"`
}

type configServer struct {
	Type       string `xml:"type,attr"`
	Hostname   string `xml:"hostname"`
	Port       int    `xml:"port"`
	SocketType string `xml:"socketType"`
	Username   string `xml:"username"`
}

// autoconfigURLs are the two places a domain publishes its own autoconfig
// file, in Thunderbird's order. Mozilla's ISPDB is deliberately not asked:
// the address goes to nobody but the domain it belongs to.
func autoconfigURLs(domain, email string) []string {
	return []string{
		"https://autoconfig." + domain + "/mail/config-v1.1.xml?emailaddress=" + url.QueryEscape(email),
		"https://" + domain + "/.well-known/autoconfig/mail/config-v1.1.xml",
	}
}

// autoconfigSettings fetches both autoconfig locations at once and takes the
// first, in order, that parses into an IMAP and an SMTP server.
func autoconfigSettings(ctx context.Context, domain, email string) (Settings, bool) {
	urls := autoconfigURLs(domain, email)
	results := make([]*Settings, len(urls))
	var wg sync.WaitGroup
	for i, u := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, err := fetchAutoconfig(ctx, u, domain)
			if err != nil {
				return
			}
			if s, ok := parseAutoconfig(body, domain, email); ok {
				results[i] = &s
			}
		}()
	}
	wg.Wait()
	for _, s := range results {
		if s != nil {
			return *s, true
		}
	}
	return Settings{}, false
}

const maxAutoconfigBytes = 64 << 10

func fetchAutoconfig(ctx context.Context, rawURL, domain string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, LookupTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	client := *HTTPClient
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !sameDomain(r.URL.Hostname(), domain) {
			return http.ErrUseLastResponse
		}
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck // read-only body
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("autoconfig: " + resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxAutoconfigBytes))
}

// sameDomain: host is the domain or one of its subdomains.
func sameDomain(host, domain string) bool {
	host = strings.ToLower(host)
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// parseAutoconfig picks the first IMAP server over SSL or STARTTLS (SSL
// preferred) and the same for SMTP. A plain-text server is never offered.
func parseAutoconfig(body []byte, domain, email string) (Settings, bool) {
	var cfg clientConfig
	if err := xml.Unmarshal(body, &cfg); err != nil {
		return Settings{}, false
	}
	in, ok := pickServer(cfg.Provider.Incoming, "imap")
	if !ok {
		return Settings{}, false
	}
	out, ok := pickServer(cfg.Provider.Outgoing, "smtp")
	if !ok {
		return Settings{}, false
	}
	local := email
	if at := strings.LastIndexByte(email, '@'); at >= 0 {
		local = email[:at]
	}
	sub := strings.NewReplacer("%EMAILADDRESS%", email, "%EMAILLOCALPART%", local, "%EMAILDOMAIN%", domain)
	name := strings.TrimSpace(cfg.Provider.DisplayShortName)
	if name == "" {
		name = strings.TrimSpace(cfg.Provider.DisplayName)
	}
	if name == "" {
		name = domain
	}
	s := Settings{Provider: name, Known: true, Source: SourceAutoconfig,
		IMAPHost: strings.ToLower(sub.Replace(strings.TrimSpace(in.Hostname))), IMAPPort: in.Port, IMAPTLS: socketTLS(in.SocketType),
		SMTPHost: strings.ToLower(sub.Replace(strings.TrimSpace(out.Hostname))), SMTPPort: out.Port, SMTPTLS: socketTLS(out.SocketType)}
	if s.IMAPHost == "" || s.SMTPHost == "" {
		return Settings{}, false
	}
	if user := sub.Replace(strings.TrimSpace(in.Username)); user != "" && !strings.EqualFold(user, email) {
		s.Username = user
		s.NeedsUsername = true
	}
	return s, true
}

func pickServer(servers []configServer, kind string) (configServer, bool) {
	for _, want := range []string{"SSL", "STARTTLS"} {
		for _, sv := range servers {
			if strings.EqualFold(sv.Type, kind) && strings.EqualFold(strings.TrimSpace(sv.SocketType), want) &&
				sv.Port > 0 && sv.Port < 65536 {
				return sv, true
			}
		}
	}
	return configServer{}, false
}

func socketTLS(socketType string) string {
	if strings.EqualFold(strings.TrimSpace(socketType), "SSL") {
		return "tls"
	}
	return "starttls"
}

// mxHosts runs MXLookup under the step timeout.
func mxHosts(ctx context.Context, domain string) []string {
	ctx, cancel := context.WithTimeout(ctx, LookupTimeout)
	defer cancel()
	mx, err := MXLookup(ctx, domain)
	if err != nil {
		return nil
	}
	return mx
}
