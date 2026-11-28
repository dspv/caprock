// Package talks is Talks (ADR-110): two people who trust each other link
// their Caprocks once, and after that a one-line goal starts a Talk in which
// each side's own agent, grounded in its owner's 2nd Brain, talks to the
// other's until they are done, a cap is reached, or a person steps in.
//
// What leaves this machine is the envelopes this package writes and nothing
// else: the messages this side's agent wrote and the guard let through (or
// the owner sent from a hold), the goal, a Talk's end, and this side's cost
// total when shared. Never the 2nd Brain, a session, a file, the brief, the
// agent's private note to its owner, or the grounding a turn read. They
// travel through the person link (pairing.KindPerson, peers.PeopleFile) as
// Noise ciphertext on the relay; nothing goes to Caprock.
//
// The guard runs on every outgoing message: internal/redact plus the
// owner's literal never-share terms, and a hit holds the message for its
// owner (Send, Edit, Drop). The caps — messages and dollars per side per
// Talk — hold the Talk when reached. The other side's words reach the agent
// only quoted as data in the turn's prompt, and the turn has no tool: an
// incoming message can run nothing, by construction (Agent).
package talks

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/redact"
)

// The defaults Settings → Talks starts from (ADR-110, decided 2026-11-28).
// Limits Caprock chose for a Talk, not estimates of what one costs (rule 6).
const (
	// DefaultMaxMessages is how many messages this side's agent sends in a
	// Talk before the Talk holds for its owner.
	DefaultMaxMessages = 12
	// DefaultMaxUSD is how much this side's turns may cost in a Talk before
	// it holds, in dollars as the agent reports them.
	DefaultMaxUSD = 5.0
	// DefaultBrief is the brief every Talk starts with.
	DefaultBrief = "Never share secrets, keys, credentials, or other people's private data."
)

// Bounds on what one envelope and one setting may hold.
const (
	// MaxBody is the longest message, in bytes.
	MaxBody = 32 << 10
	// MaxGoal is the longest goal, in runes.
	MaxGoal = 500
	// maxTerms and maxTermRunes bound the never-share terms.
	maxTerms     = 100
	maxTermRunes = 200
	// maxBriefRunes bounds the brief.
	maxBriefRunes = 4000
	// MaxOpenPerPerson is how many Talks one person may have open with this
	// side at once (not finished or ended): a partner's Caprock opening
	// Talks without end would spend this side's agent on each.
	MaxOpenPerPerson = 10
)

// The states of a Talk on this side.
const (
	// StateInvited is a Talk the other person started while *Let them start
	// talks* is off here: it waits for this side's Accept.
	StateInvited = "invited"
	// StateMyTurn is this side's agent's turn: running, or about to.
	StateMyTurn = "my_turn"
	// StateWaiting is the other side's turn.
	StateWaiting = "waiting"
	// StateHeld waits for this side's owner: Hold says why.
	StateHeld = "held"
	// StateFinished is both agents saying they are done.
	StateFinished = "finished"
	// StateEnded is ended by a person, or by Remove: EndedBy says whose.
	StateEnded = "ended"
)

// Why a Talk is held (Talk.Hold).
const (
	// HoldRedaction is a message the guard caught: redaction or a
	// never-share term. Send, Edit or Drop.
	HoldRedaction = "redaction"
	// HoldNeedsOwner is a message the agent itself flagged for its owner.
	HoldNeedsOwner = "needs_owner"
	// HoldCap is a cap reached: Continue or End.
	HoldCap = "cap"
	// HoldError is a turn that failed: Continue tries again.
	HoldError = "error"
)

// Who ended a Talk, and who started one.
const (
	ByMe   = "me"
	ByThem = "them"
)

// The kinds of envelope this version sends (ADR-110 lists the rest:
// artifact, outcome, accept come with P2).
const (
	KindMessage = "message"
	KindHuman   = "human"
	KindState   = "state"
)

// The states a KindState envelope carries.
const (
	EnvOpen  = "open"
	EnvEnded = "ended"
)

// How one of this side's envelopes left (TalkEnvelope.How).
const (
	HowAuto     = "auto"
	HowFromHold = "from_hold"
	HowEdited   = "edited"
	HowTyped    = "typed"
)

// KindNeverShare is what a never-share term's placeholder names.
const KindNeverShare = "never-share term"

// Author is who wrote an envelope.
type Author struct {
	// Kind is "agent" or "person".
	Kind string `json:"kind"`
	// Name is the sending person's name for Talks.
	Name string `json:"name"`
	// Agent and Model label an agent's message.
	Agent string `json:"agent,omitempty"`
	Model string `json:"model,omitempty"`
	// Edited says the owner rewrote the agent's draft from a hold.
	Edited bool `json:"edited,omitempty"`
}

// Envelope is what travels between two Caprocks (ADR-110). Its JSON is
// stored on both sides byte for byte as it travelled, and its hash is over
// those bytes, so the two transcripts can be checked equal.
type Envelope struct {
	V    int    `json:"v"`
	Kind string `json:"kind"`
	Talk string `json:"talk"`
	// Seq is per sender, from 1; Prev is the hash of the sender's previous
	// envelope in this Talk, "" for its first.
	Seq    int64  `json:"seq"`
	Prev   string `json:"prev"`
	Author Author `json:"author"`
	Body   string `json:"body"`
	// State is a KindState envelope's: EnvOpen (Body is the goal) or
	// EnvEnded.
	State string `json:"state,omitempty"`
	// Done is the sending agent saying it has nothing more to add.
	Done bool `json:"done,omitempty"`
	// CostUSD is the sender's cost total for this Talk, when shared: their
	// claim, shown as theirs.
	CostUSD *float64 `json:"cost_usd,omitempty"`
	// At is the sender's clock, unix ms.
	At int64 `json:"at"`
}

// Hash is the hex SHA-256 of an envelope's bytes.
func Hash(raw []byte) string {
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

// Errors a caller turns into an answer.
var (
	ErrBadEnvelope = errors.New("that is not a Talk envelope this Caprock reads")
	ErrNotYours    = errors.New("that talk is not one with you")
	ErrOutOfOrder  = errors.New("that envelope does not follow the last one received")
	ErrNotHeld     = errors.New("nothing is held in that talk")
	ErrEnded       = errors.New("that talk has ended")
	ErrGoal        = errors.New("a talk needs a goal of one line")
	ErrNoPerson    = errors.New("no such person is linked for Talks")
	ErrCaught      = errors.New("that text holds what the guard does not let leave")
	ErrState       = errors.New("that talk is not in a state that allows this")
	ErrTooMany     = errors.New("too many talks are open with this person: finish or end one first")
)

// Settings are Settings → Talks, kept in SettingsFile beside people.json:
// the never-share terms are the owner's own words (a client's name, a price
// floor), so not in config.json, which is pasted into support threads.
type Settings struct {
	// Name is what this side is called to the people it talks with.
	Name string `json:"name,omitempty"`
	// Brief is the brief every new Talk starts with.
	Brief string `json:"brief,omitempty"`
	// NeverShare are literal terms the guard holds a message for,
	// case-folded.
	NeverShare []string `json:"never_share,omitempty"`
	// MaxMessages and MaxUSD are the caps per side per Talk; 0 is the
	// default.
	MaxMessages int     `json:"max_messages,omitempty"`
	MaxUSD      float64 `json:"max_usd,omitempty"`
	// ShareCost sends this side's cost total with each message; nil is on.
	ShareCost *bool `json:"share_cost,omitempty"`
	// Agent and Model are the agent and model the turns run with; "" is the
	// default (the strongest model of the agent this machine reads with).
	Agent string `json:"agent,omitempty"`
	Model string `json:"model,omitempty"`
}

// SettingsFile is where Settings live, mode 0600.
const SettingsFile = "talks.json"

// Caps are the settings' caps with the defaults filled in.
func (s Settings) Caps() (int, float64) {
	n, usd := s.MaxMessages, s.MaxUSD
	if n <= 0 {
		n = DefaultMaxMessages
	}
	if usd <= 0 {
		usd = DefaultMaxUSD
	}
	return n, usd
}

// BriefOrDefault is the brief a new Talk starts with.
func (s Settings) BriefOrDefault() string {
	if b := strings.TrimSpace(s.Brief); b != "" {
		return b
	}
	return DefaultBrief
}

// SharesCost is ShareCost with nil read as on.
func (s Settings) SharesCost() bool { return s.ShareCost == nil || *s.ShareCost }

// Clean bounds what a settings write may hold.
func (s Settings) Clean() Settings {
	s.Name = cleanLine(s.Name, 40)
	if r := []rune(strings.TrimSpace(s.Brief)); len(r) > maxBriefRunes {
		s.Brief = string(r[:maxBriefRunes])
	}
	var terms []string
	seen := map[string]bool{}
	for _, t := range s.NeverShare {
		t = cleanLine(t, maxTermRunes)
		if t == "" || seen[strings.ToLower(t)] || len(terms) >= maxTerms {
			continue
		}
		seen[strings.ToLower(t)] = true
		terms = append(terms, t)
	}
	s.NeverShare = terms
	if s.MaxMessages < 0 {
		s.MaxMessages = 0
	}
	if s.MaxUSD < 0 {
		s.MaxUSD = 0
	}
	s.Agent, s.Model = cleanLine(s.Agent, 40), cleanLine(s.Model, 80)
	return s
}

// ReadSettings loads talks.json; a missing file is the defaults.
func ReadSettings(dir string) (Settings, error) {
	b, err := os.ReadFile(filepath.Join(dir, SettingsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		return Settings{}, err
	}
	return s.Clean(), nil
}

// WriteSettings saves talks.json, 0600, atomically.
func WriteSettings(dir string, s Settings) error {
	b, err := json.MarshalIndent(s.Clean(), "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(filepath.Join(dir, SettingsFile), b, 0o600)
}

// Guard is what runs on every outgoing text (ADR-110, the guard's step 2):
// internal/redact, then the literal never-share terms, case-folded. It
// returns the text as it would leave — every value caught replaced by a
// placeholder that names its kind — and what was caught. Anything caught
// holds a message.
func Guard(text string, terms []string) (string, redact.Counts) {
	out, caught := redact.Text(text)
	if caught == nil {
		caught = redact.Counts{}
	}
	for _, t := range terms {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		re, err := regexp.Compile(`(?i)` + regexp.QuoteMeta(t))
		if err != nil {
			continue
		}
		if n := len(re.FindAllStringIndex(out, -1)); n > 0 {
			caught[KindNeverShare] += n
			out = re.ReplaceAllLiteralString(out, redact.Placeholder(KindNeverShare))
		}
	}
	return out, caught
}

// cleanLine keeps one printable line of at most n runes.
func cleanLine(s string, n int) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s))
	if r := []rune(s); len(r) > n {
		s = strings.TrimSpace(string(r[:n]))
	}
	return s
}

// cleanBody keeps a message within MaxBody, on a rune boundary, and valid
// UTF-8.
func cleanBody(s string) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= MaxBody {
		return s
	}
	s = s[:MaxBody]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
