// Package redact replaces credentials and payment details in text with a
// placeholder that names what was there: "[redacted: card number]".
//
// Second Brain keeps what sessions said and hands it on — to later
// sessions, to other projects' screens, to agents through `caprock mcp` —
// so a key or a card number that lands in a memory spreads. Its store runs
// every memory through Text before it is saved, and the MCP server runs
// every answer through it before it leaves.
//
// Precision matters as much as recall: a memory full of "[redacted]" where
// a commit, a UUID, a version or a price was is a memory nobody can use.
// So a shape alone is trusted only where the shape is distinctive (an
// `sk-ant-` key, a PEM block); a bare number is a card only when it passes
// Luhn with a card network's prefix, an IBAN only when its mod-97 checksum
// holds, and anything else — an account number, a password, a hex secret —
// only after a label that says what it is.
package redact

import (
	"regexp"
	"sort"
	"strings"
)

// Kinds, as the placeholder names them.
const (
	KindPrivateKey  = "private key"
	KindAPIKey      = "api key"
	KindToken       = "token"
	KindCard        = "card number"
	KindIBAN        = "iban"
	KindPassword    = "password"
	KindSecret      = "secret"
	KindBankAccount = "bank account"
)

// Placeholder is what a value of kind is replaced with.
func Placeholder(kind string) string { return "[redacted: " + kind + "]" }

// Counts is how many values of each kind a call replaced.
type Counts map[string]int

// Add folds o into c.
func (c Counts) Add(o Counts) {
	for k, n := range o {
		c[k] += n
	}
}

// Total is the sum over every kind.
func (c Counts) Total() int {
	n := 0
	for _, v := range c {
		n += v
	}
	return n
}

// String is "card number=1 token=2", kinds sorted: for a log line.
func (c Counts) String() string {
	keys := make([]string, 0, len(c))
	for k := range c {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(strings.ReplaceAll(k, " ", "_"))
		b.WriteByte('=')
		b.WriteString(itoa(c[k]))
	}
	return b.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d []byte
	for n > 0 {
		d = append([]byte{byte('0' + n%10)}, d...)
		n /= 10
	}
	return string(d)
}

// rule is one shape: re finds a candidate, ok (when set) confirms it, and
// group, when above 0, is the submatch that holds the value — the label
// before it stays.
type rule struct {
	kind  string
	re    *regexp.Regexp
	group int
	ok    func(v string) bool
}

// The rules, in order: whole blocks first, so a key inside a PEM block is
// one private key, not a key and a block; labelled values last, so a
// "token: ghp_…" is counted as the token its shape says it is.
var rules = []rule{
	// PEM private keys: the whole block, or what is left of one a clip cut
	// before its END line.
	{kind: KindPrivateKey, re: regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)`)},
	// Anthropic, OpenAI and most "sk-" keys. A real key has digits; a
	// kebab-case name that happens to start with "sk-" has none.
	{kind: KindAPIKey, re: regexp.MustCompile(`\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_\-]{20,}`), ok: isSKKey},
	// Stripe secret, restricted and publishable keys.
	{kind: KindAPIKey, re: regexp.MustCompile(`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`)},
	// AWS access key ids.
	{kind: KindAPIKey, re: regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`), ok: notExample},
	// Google API keys.
	{kind: KindAPIKey, re: regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}`)},
	// GitHub tokens: classic, OAuth, user-to-server, server-to-server,
	// refresh, and fine-grained.
	{kind: KindToken, re: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})`)},
	// Slack tokens.
	{kind: KindToken, re: regexp.MustCompile(`\bxox[abposr]-[A-Za-z0-9-]{10,}`), ok: hasDigit},
	// Telegram bot tokens: the bot's id, a colon, 35 characters.
	{kind: KindToken, re: regexp.MustCompile(`\b\d{8,10}:[A-Za-z0-9_\-]{35}\b`)},
	// JSON web tokens.
	{kind: KindToken, re: regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}`)},
	// An Authorization header's bearer value.
	{kind: KindToken, re: regexp.MustCompile(`(?i)\bbearer\s+([A-Za-z0-9._~+/\-]{20,}=*)`), group: 1, ok: hasDigitAndLetter},
	// Payment cards: 13 to 19 digits, single spaces or dashes between
	// groups; confirmed by Luhn and a network's prefix (isCard).
	{kind: KindCard, re: regexp.MustCompile(`\b\d(?:[ \-]?\d){12,18}\b`), ok: isCard},
	// IBAN: a country, two check digits, then the account, in groups of
	// four or run together; confirmed by mod 97 (isIBAN).
	{kind: KindIBAN, re: regexp.MustCompile(`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b`), ok: isIBAN},
	// A password after its label: "password: …", "pwd=…", "passphrase is …".
	{kind: KindPassword, re: regexp.MustCompile(`(?i)(?:(?:\b|_)(?:password|passwd|passphrase|pwd)\b|` + ruPassword + `)` + labelSep + `([^\s"'` + "`" + `,;)\]]{6,})`), group: 1, ok: isPassword},
	// A secret after its label: "api key: …", "token=…", "client_secret …".
	{kind: KindSecret, re: regexp.MustCompile(`(?i)(?:\b|_)(?:secret|client[_ \-]?secret|api[_ \-]?key|access[_ \-]?key|secret[_ \-]?key|private[_ \-]?key|auth[_ \-]?token|access[_ \-]?token|refresh[_ \-]?token|bot[_ \-]?token|token|webhook[_ \-]?secret|signing[_ \-]?key)\b` + labelSep + `([A-Za-z0-9+/_\-.=]{16,})`), group: 1, ok: isHighEntropy},
	// A bank account or routing number after its label.
	{kind: KindBankAccount, re: regexp.MustCompile(`(?i)(?:\b(?:account|acct|a/c)(?:\s+(?:number|no\.?|#))?|\brouting(?:\s+(?:number|no\.?|#))?|\baba\b|\bsort\s+code|\bbsb\b|` + ruAccount + `)["'` + "`" + `]?\s*(?:[:=#]|\bis\b)?\s*([0-9](?:[0-9 \-]{4,30}[0-9]))`), group: 1, ok: isAccount},
}

// labelSep is what stands between a label and its value: a colon, an
// equals sign or "is", with quotes around either side, or only a space
// before a value in backquotes ("password `…`").
const labelSep = `["'` + "`" + `]?(?:\s*(?:[:=]|\bis\b)\s*["'` + "`" + `]?|\s+` + "`" + `)`

// notExample leaves out the example keys vendors print in their docs
// (AWS's end in EXAMPLE): quoting one gives nothing away.
func notExample(v string) bool { return !strings.HasSuffix(v, "EXAMPLE") }

// The Russian labels, written as escapes: the repository holds no
// Cyrillic (CLAUDE.md rule 5), and the owner's sessions are in Russian.
const (
	// "parol" (password), "parolya" and the like.
	ruPassword = `\x{043f}\x{0430}\x{0440}\x{043e}\x{043b}[\x{044c}\x{044f}\x{0435}\x{0438}]?`
	// "r/s" and "k/s" (settlement and correspondent account), "schet" or
	// "schyot" (account), "BIK" (the bank's code).
	ruAccount = `[\x{0440}\x{043a}]/\x{0441}|\x{0441}\x{0447}[\x{0435}\x{0451}]\x{0442}[\x{0430}\x{0443}]?|\x{0431}\x{0438}\x{043a}|\x{043a}\x{043e}\x{0440}\x{0440}\.?\s*\x{0441}\x{0447}[\x{0435}\x{0451}]\x{0442}`
)

// Text returns s with every value a rule finds replaced by its
// placeholder, and how many of each kind it replaced. Text that holds
// nothing comes back unchanged, the same string.
func Text(s string) (string, Counts) {
	var counts Counts
	for _, r := range rules {
		if !r.re.MatchString(s) {
			continue
		}
		s = replace(s, r, &counts)
	}
	return s, counts
}

// String is Text without the counts.
func String(s string) string {
	out, _ := Text(s)
	return out
}

// Strings runs Text over each of in, returning a new slice and the counts.
func Strings(in []string) ([]string, Counts) {
	var counts Counts
	out := make([]string, len(in))
	for i, s := range in {
		var c Counts
		out[i], c = Text(s)
		if c != nil {
			if counts == nil {
				counts = Counts{}
			}
			counts.Add(c)
		}
	}
	return out, counts
}

func replace(s string, r rule, counts *Counts) string {
	idx := r.re.FindAllStringSubmatchIndex(s, -1)
	if idx == nil {
		return s
	}
	var b strings.Builder
	last := 0
	for _, m := range idx {
		from, to := m[0], m[1]
		if r.group > 0 {
			from, to = m[2*r.group], m[2*r.group+1]
			if from < 0 {
				continue
			}
		}
		v := s[from:to]
		if strings.HasPrefix(v, "[redacted") || (r.ok != nil && !r.ok(v)) {
			continue
		}
		b.WriteString(s[last:from])
		b.WriteString(Placeholder(r.kind))
		last = to
		if *counts == nil {
			*counts = Counts{}
		}
		(*counts)[r.kind]++
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

func hasDigit(v string) bool { return strings.ContainsAny(v, "0123456789") }

// isSKKey: a vendor's own prefix (sk-ant-, sk-proj-, sk-svcacct-) is
// enough; a bare "sk-" run needs digits, which a kebab-case name lacks.
func isSKKey(v string) bool {
	for _, p := range []string{"sk-ant-", "sk-proj-", "sk-svcacct-"} {
		if strings.HasPrefix(v, p) {
			return true
		}
	}
	return hasDigitAndLetter(v[3:])
}

func hasDigitAndLetter(v string) bool {
	letter := false
	for _, c := range v {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			letter = true
			break
		}
	}
	return letter && hasDigit(v)
}

func digitsOf(v string) string {
	var b strings.Builder
	for _, c := range v {
		if c >= '0' && c <= '9' {
			b.WriteRune(c)
		}
	}
	return b.String()
}

// isCard reports whether v is a payment card number: 13 to 19 digits, its
// separators (if any) single and of one kind, a known network's prefix and
// length, and a Luhn checksum that holds. A Unix time in milliseconds, a
// phone number or an order id fails the prefix or the checksum.
func isCard(v string) bool {
	if strings.Contains(v, " ") && strings.Contains(v, "-") {
		return false
	}
	d := digitsOf(v)
	n := len(d)
	if n < 13 || n > 19 || !luhn(d) {
		return false
	}
	p2, p4, p6 := atoi(d[:2]), atoi(d[:4]), atoi(d[:6])
	switch {
	case d[0] == '4': // Visa
		return n == 13 || n == 16 || n == 19
	case p2 >= 51 && p2 <= 55, p6 >= 222100 && p6 <= 272099: // Mastercard
		return n == 16
	case p2 == 34 || p2 == 37: // American Express
		return n == 15
	case p4 >= 2200 && p4 <= 2204: // Mir
		return n >= 16
	case p4 == 6011, p2 == 65, p4 >= 6440 && p4 <= 6499: // Discover
		return n >= 16
	case p4 >= 3528 && p4 <= 3589: // JCB
		return n >= 16
	case p2 == 62: // UnionPay
		return n >= 16
	case p2 == 36, p2 == 38, p4 >= 3000 && p4 <= 3059: // Diners
		return n >= 14
	}
	return false
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func luhn(d string) bool {
	sum, double := 0, false
	for i := len(d) - 1; i >= 0; i-- {
		x := int(d[i] - '0')
		if double {
			x *= 2
			if x > 9 {
				x -= 9
			}
		}
		sum += x
		double = !double
	}
	return sum%10 == 0
}

// ibanLength is each IBAN country's length.
var ibanLength = map[string]int{
	"AD": 24, "AE": 23, "AL": 28, "AT": 20, "AZ": 28, "BA": 20, "BE": 16, "BG": 22, "BH": 22, "BR": 29,
	"BY": 28, "CH": 21, "CR": 22, "CY": 28, "CZ": 24, "DE": 22, "DK": 18, "DO": 28, "EE": 20, "EG": 29,
	"ES": 24, "FI": 18, "FO": 18, "FR": 27, "GB": 22, "GE": 22, "GI": 23, "GL": 18, "GR": 27, "GT": 28,
	"HR": 21, "HU": 28, "IE": 22, "IL": 23, "IQ": 23, "IS": 26, "IT": 27, "JO": 30, "KW": 30, "KZ": 20,
	"LB": 28, "LC": 32, "LI": 21, "LT": 20, "LU": 20, "LV": 21, "MC": 27, "MD": 24, "ME": 22, "MK": 19,
	"MR": 27, "MT": 31, "MU": 30, "NL": 18, "NO": 15, "PK": 24, "PL": 28, "PS": 29, "PT": 25, "QA": 29,
	"RO": 24, "RS": 22, "RU": 33, "SA": 24, "SC": 31, "SE": 24, "SI": 19, "SK": 24, "SM": 27, "ST": 25,
	"SV": 28, "TL": 23, "TN": 24, "TR": 26, "UA": 29, "VA": 22, "VG": 24, "XK": 20,
}

// isIBAN reports whether v is an IBAN: a known country, that country's
// length, and the mod-97 checksum.
func isIBAN(v string) bool {
	s := strings.ReplaceAll(v, " ", "")
	if len(s) < 15 || ibanLength[s[:2]] != len(s) {
		return false
	}
	s = s[4:] + s[:4]
	rem := 0
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
			rem = (rem*10 + int(c-'0')) % 97
		case c >= 'A' && c <= 'Z':
			rem = (rem*100 + int(c-'A'+10)) % 97
		default:
			return false
		}
	}
	return rem == 1
}

// notValues are what follows a password label in prose and code without
// being a password: a placeholder, a reference to where it lives, a type.
var notValues = map[string]bool{
	"required": true, "optional": true, "string": true, "str": true, "none": true, "null": true,
	"nil": true, "empty": true, "true": true, "false": true, "undefined": true, "redacted": true,
	"hidden": true, "masked": true, "secret": true, "password": true, "env": true, "prompt": true,
	"field": true, "input": true, "manager": true, "reset": true, "protected": true, "change": true,
}

// placeholderish reports a value that stands for a password rather than
// being one: <your-password>, ${PASS}, $PASSWORD, ****, xxxx, process.env.X.
func placeholderish(v string) bool {
	l := strings.ToLower(strings.Trim(v, ".:"))
	if notValues[l] {
		return true
	}
	switch {
	case strings.ContainsAny(v[:1], "<{$*%[(#@/~."):
		// A placeholder, a variable, or a path ("pwd: /Users/me").
		return true
	case strings.HasPrefix(l, "process.env") || strings.HasPrefix(l, "os.getenv") || strings.HasPrefix(l, "env."):
		return true
	case strings.Trim(l, "x*•.") == "":
		return true
	}
	return false
}

// isPassword reports whether what follows a password label looks like one:
// not a placeholder, a URL or code, and not a plain word or identifier — a
// password has a digit or a symbol. Six digits alone pass, as a PIN does;
// a date or a version, digits with dots or dashes, does not.
func isPassword(v string) bool {
	v = strings.TrimRight(v, ".")
	if len(v) < 6 || placeholderish(v) || strings.Contains(v, "://") || strings.ContainsAny(v, "([{") {
		return false
	}
	letter, digit, symbol, sep := false, false, false, false
	for _, c := range v {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			letter = true
		case c >= '0' && c <= '9':
			digit = true
		case c > 127:
			// A word in another script: prose, not a password.
			return false
		case c == '_' || c == '.' || c == '-':
			// What joins the words of an identifier (form.password_hash).
			sep = true
		default:
			symbol = true
		}
	}
	if !letter {
		return digit && !symbol && !sep
	}
	return digit || symbol
}

// isHighEntropy reports whether what follows a key, token or secret label
// is a credential rather than a word, a path or a number: 16 or more
// characters with letters and digits, and not a dotted name, a path, an
// environment variable's name or words joined by separators.
func isHighEntropy(v string) bool {
	v = strings.TrimRight(v, ".")
	if len(v) < 16 || placeholderish(v) || !hasDigitAndLetter(v) {
		return false
	}
	if strings.Count(v, ".") >= 1 && !strings.HasPrefix(v, "eyJ") {
		// A dotted name or a file: config.api_key.v2, settings.json.
		return false
	}
	// An environment variable's name (MY_API_KEY_2) or words joined by
	// separators (stripe-key-name-v2) name a secret; they are not one.
	return !envName.MatchString(v) && !joinedWords.MatchString(v)
}

var (
	envName     = regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$`)
	joinedWords = regexp.MustCompile(`^[A-Za-z][a-z0-9]*(?:[_\-][A-Za-z0-9][a-z0-9]*)+$`)
)

// isAccount reports whether what follows an account or routing label is a
// number of an account's length: 6 to 34 digits.
func isAccount(v string) bool {
	n := len(digitsOf(v))
	return n >= 6 && n <= 34
}
