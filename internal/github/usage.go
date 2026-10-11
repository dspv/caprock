package github

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// What GitHub itself billed for Actions this month, read from its billing
// usage report when the connected token may read it — GitHub's figures, not
// an estimate. Asked only when GET /v1/github/actions-usage is; never polled.
//
// Endpoints (docs.github.com/en/rest/billing/usage, read 2026-10-12), each
// "only available to" accounts "with access to the enhanced billing
// platform":
//
//   - GET /users/{username}/settings/billing/usage — a fine-grained token
//     needs the "Plan" user permission (read).
//   - GET /organizations/{org}/settings/billing/usage — "you must be an
//     administrator of an organization"; a fine-grained token needs the
//     "Administration" organization permission (read).
//
// The page names no scope for a classic or OAuth token; when GitHub refuses
// one, the scopes its answer asks for (X-Accepted-OAuth-Scopes) are passed on.

// usageKept is how long an answer is reused, a refusal included.
const usageKept = 30 * time.Minute

// usageCached bounds the answers kept.
const usageCached = 16

// Why the usage is not available.
const (
	UsageNotConnected = "not_connected"
	UsagePermission   = "permission" // 403: the token may not read billing
	UsageNotFound     = "not_found"  // 404: no such account, or no enhanced billing
	UsageError        = "error"      // anything else; Error says what
)

// Documented permissions, said when GitHub's answer names none.
var (
	usageNeedsUser = []string{`"Plan" user permission (read), for a fine-grained token`}
	usageNeedsOrg  = []string{`"Administration" organization permission (read), for a fine-grained token`, "organization administrator"}
)

// ActionsUsageSKU is one SKU's Actions usage this month.
type ActionsUsageSKU struct {
	SKU         string  `json:"sku"`
	UnitType    string  `json:"unit_type"`
	Quantity    float64 `json:"quantity"`
	GrossUSD    float64 `json:"gross_usd"`
	DiscountUSD float64 `json:"discount_usd"`
	NetUSD      float64 `json:"net_usd"`
}

// ActionsUsage is GET /v1/github/actions-usage.
type ActionsUsage struct {
	Account string `json:"account"`
	Org     bool   `json:"org"`
	Year    int    `json:"year"`
	Month   int    `json:"month"`
	// Available is true when GitHub answered with the report.
	Available bool `json:"available"`
	// Reason says why not: not_connected, permission, not_found or error.
	Reason string `json:"reason,omitempty"`
	// Needs names what to grant the token when Reason is permission.
	Needs []string `json:"needs,omitempty"`
	// Minutes sums the Actions items billed in minutes; the dollars sum
	// every Actions item (storage included). Net is after GitHub's discount,
	// which is how the included minutes appear.
	Minutes     float64           `json:"minutes"`
	GrossUSD    float64           `json:"gross_usd"`
	DiscountUSD float64           `json:"discount_usd"`
	NetUSD      float64           `json:"net_usd"`
	BySKU       []ActionsUsageSKU `json:"by_sku"`
	// Endpoint is the GitHub path asked (no token, no host).
	Endpoint string `json:"endpoint,omitempty"`
	At       int64  `json:"at"`
	Error    *Error `json:"error,omitempty"`
}

type usageEntry struct {
	u  ActionsUsage
	at time.Time
}

type usageCache struct {
	mu sync.Mutex
	m  map[string]usageEntry
}

// apiUsageItem is one row of GitHub's billing usage report.
type apiUsageItem struct {
	Date           string  `json:"date"`
	Product        string  `json:"product"`
	SKU            string  `json:"sku"`
	Quantity       float64 `json:"quantity"`
	UnitType       string  `json:"unitType"`
	PricePerUnit   float64 `json:"pricePerUnit"`
	GrossAmount    float64 `json:"grossAmount"`
	DiscountAmount float64 `json:"discountAmount"`
	NetAmount      float64 `json:"netAmount"`
}

// ActionsUsage reads this month's (UTC) Actions usage of owner — the
// account itself when owner is "" or its own login, else that organization —
// from GitHub's billing usage report, kept usageKept. A refusal is an answer
// (Available false, with the reason and what to grant), not an error; the
// error is only for a malformed owner. It does not mark the health line: a
// token without billing access is not a broken connection.
func (s *Service) ActionsUsage(ctx context.Context, owner string) (ActionsUsage, *Error) {
	s.init()
	const doing = "Reading your GitHub Actions usage"
	owner = strings.TrimSpace(owner)
	if owner != "" && !namePart.MatchString(owner) {
		return ActionsUsage{}, errorf(KindInvalid, doing, "%q is not a GitHub account name", owner)
	}
	now := s.Now().UTC()
	out := ActionsUsage{Account: owner, Year: now.Year(), Month: int(now.Month()), BySKU: []ActionsUsageSKU{}, At: now.UnixMilli()}
	tok, src, e := s.token(ctx, doing)
	if e != nil {
		out.Reason, out.Error = UsageNotConnected, e
		return out, nil //nolint:nilerr // not connected is an answer, carried in out.Error
	}
	if owner == "" {
		u, e := s.me(ctx)
		if e != nil {
			out.Reason, out.Error = UsageError, e
			return out, nil //nolint:nilerr // carried in out.Error, like every refusal
		}
		owner = u.Login
	}
	out.Account = owner
	if u, e := s.me(ctx); e == nil && !strings.EqualFold(u.Login, owner) {
		out.Org = true
	}
	key := cacheKey(tok, fmt.Sprintf("%s %v %d-%02d", strings.ToLower(owner), out.Org, out.Year, out.Month))
	s.usage.mu.Lock()
	if s.usage.m == nil {
		s.usage.m = map[string]usageEntry{}
	}
	c, have := s.usage.m[key]
	s.usage.mu.Unlock()
	if have && s.Now().Sub(c.at) < usageKept {
		return c.u, nil
	}
	out.Endpoint = "/users/" + url.PathEscape(owner) + "/settings/billing/usage"
	if out.Org {
		out.Endpoint = "/organizations/" + url.PathEscape(owner) + "/settings/billing/usage"
	}
	path := fmt.Sprintf("%s?year=%d&month=%d", out.Endpoint, out.Year, out.Month)
	res, ce := s.c.do(ctx, request{method: http.MethodGet, path: path, doing: doing, token: tok, source: src})
	if ce == nil {
		var body struct {
			Items []apiUsageItem `json:"usageItems"`
		}
		ce = decode(res, doing, &body)
		if ce == nil {
			out.Available = true
			sumUsage(&out, body.Items)
		}
	}
	keep := true
	if ce != nil {
		out.Error = ce
		switch ce.Kind {
		case KindScope, KindForbidden:
			out.Reason, out.Needs = UsagePermission, ce.Needs
			if len(out.Needs) == 0 {
				out.Needs = usageNeedsUser
				if out.Org {
					out.Needs = usageNeedsOrg
				}
			}
		case KindNotFound:
			out.Reason = UsageNotFound
			ce.Message = "GitHub has no billing usage report for " + owner + " (404): the account is not on GitHub's enhanced billing platform, or this token cannot see it."
		default:
			out.Reason = UsageError
			keep = false // a network failure or a rate limit is asked again next time
		}
	}
	if keep {
		s.usage.mu.Lock()
		if _, ok := s.usage.m[key]; !ok && len(s.usage.m) >= usageCached {
			var oldest string
			var at time.Time
			for k, v := range s.usage.m {
				if oldest == "" || v.at.Before(at) {
					oldest, at = k, v.at
				}
			}
			delete(s.usage.m, oldest)
		}
		s.usage.m[key] = usageEntry{u: out, at: s.Now()}
		s.usage.mu.Unlock()
	}
	return out, nil
}

// sumUsage keeps the Actions rows of a report, summed per SKU and unit.
func sumUsage(out *ActionsUsage, items []apiUsageItem) {
	by := map[string]*ActionsUsageSKU{}
	for _, it := range items {
		if !strings.EqualFold(it.Product, "actions") {
			continue
		}
		k := it.SKU + "\x00" + it.UnitType
		row := by[k]
		if row == nil {
			row = &ActionsUsageSKU{SKU: it.SKU, UnitType: it.UnitType}
			by[k] = row
		}
		row.Quantity += it.Quantity
		row.GrossUSD = usd(row.GrossUSD + it.GrossAmount)
		row.DiscountUSD = usd(row.DiscountUSD + it.DiscountAmount)
		row.NetUSD = usd(row.NetUSD + it.NetAmount)
		if strings.Contains(strings.ToLower(it.UnitType), "minute") {
			out.Minutes += it.Quantity
		}
		out.GrossUSD = usd(out.GrossUSD + it.GrossAmount)
		out.DiscountUSD = usd(out.DiscountUSD + it.DiscountAmount)
		out.NetUSD = usd(out.NetUSD + it.NetAmount)
	}
	for _, row := range by {
		out.BySKU = append(out.BySKU, *row)
	}
	sort.Slice(out.BySKU, func(i, j int) bool {
		if out.BySKU[i].GrossUSD != out.BySKU[j].GrossUSD {
			return out.BySKU[i].GrossUSD > out.BySKU[j].GrossUSD
		}
		return out.BySKU[i].SKU < out.BySKU[j].SKU
	})
}
