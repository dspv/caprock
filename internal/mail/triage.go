package mail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dspv/caprock/internal/mail/ai"
	"github.com/dspv/caprock/internal/mail/engine"
	store "github.com/dspv/caprock/internal/mail/mailstore"
)

// AI triage: while AI is on, the assistant sorts inbox conversations into a
// few categories with a one-line summary each, in the background, a batch of
// conversations per call. It only labels: nothing is moved or deleted on the
// server. Sample mode labels the sample inbox from a canned table, with no
// model call.
const (
	triageWindow   = 200 // the newest inbox conversations considered
	triageBatch    = 8   // conversations per model call
	triageMaxTries = 2   // a conversation the model fails this often waits for a restart
	triageMinWait  = 2 * time.Minute
	triageMaxWait  = 30 * time.Minute
)

// triageState is the sorter's part of Service. One run at a time.
type triageState struct {
	mu        sync.Mutex
	running   bool
	again     bool // kicked while running: look again before stopping
	pending   int  // conversations left in this run
	by        string
	failUntil time.Time
	wait      time.Duration
	tries     map[string]int
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	// chatter replaces the provider's client (tests).
	chatter ai.Chatter
}

func (t *triageState) init() {
	t.ctx, t.cancel = context.WithCancel(context.Background())
	t.tries = map[string]int{}
}

// kickTriage starts a sorting run unless one is running or a failure is
// still cooling down. It never waits.
func (s *Service) kickTriage() {
	t := &s.tri
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.ctx == nil || t.ctx.Err() != nil || time.Now().Before(t.failUntil) {
		return
	}
	if t.running {
		t.again = true
		return
	}
	t.running = true
	t.wg.Add(1)
	go func() { defer t.wg.Done(); s.runTriage() }()
}

// retryTriage forgets past failures (AI just turned on, provider changed,
// sample switched) and kicks.
func (s *Service) retryTriage() {
	s.tri.mu.Lock()
	s.tri.failUntil, s.tri.wait = time.Time{}, 0
	clear(s.tri.tries)
	s.tri.mu.Unlock()
	s.kickTriage()
}

// current is the instance being served, without opening anything: nil when
// Mail is not open.
func (s *Service) current() (*store.Store, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sample != nil {
		return s.sample.st, true
	}
	return s.st, false
}

type classifyFn func(ctx context.Context, convs []ai.Conversation) ([]ai.Verdict, error)

// sorter works out who sorts now: the canned table in sample mode, else the
// provider chosen in settings — only while ai_enabled is on.
func (s *Service) sorter(ctx context.Context, st *store.Store, sample bool) (classifyFn, string, string, bool) {
	if sample {
		return cannedTriage, "sample", "Sample labels", true
	}
	set := readSettings(ctx, st)
	if set["ai_enabled"] != "1" {
		return nil, "", "", false
	}
	ps, models, ok := s.chosen(ctx, set)
	if !ok {
		return nil, "", "", false
	}
	c := s.tri.chatter
	if c == nil {
		var err error
		if c, err = s.chatter(ctx, ps, set); err != nil {
			return nil, "", "", false
		}
	}
	model := effectiveModel(ps, set, models)
	id := ps.ID
	if model != "" {
		id += "/" + model
	}
	lang := set["ai_language"]
	return func(ctx context.Context, convs []ai.Conversation) ([]ai.Verdict, error) {
		return ai.Triage(ctx, c, convs, lang)
	}, id, who(ps.Label, model), true
}

// effectiveModel is the model a provider answers with, "" for a CLI's own default.
func effectiveModel(ps providerState, set map[string]string, models []string) string {
	switch {
	case ps.Kind == ai.KindLocal && set["ai_model"] != "":
		return set["ai_model"]
	case ps.Kind == ai.KindLocal && len(models) > 0:
		return models[0]
	case ps.Model != "":
		return ps.Model
	}
	return ps.Info.Model
}

// who names a provider and model for the screen: "Claude Code · haiku".
func who(label, model string) string {
	if model == "" {
		return label
	}
	return label + " · " + model
}

func todoKey(td store.TriageTodo) string {
	return fmt.Sprintf("%d\x00%s\x00%d", td.AccountID, td.ThreadKey, td.Newest)
}

func (s *Service) runTriage() {
	t := &s.tri
	ctx := t.ctx
	defer func() {
		t.mu.Lock()
		t.running, t.again, t.pending = false, false, 0
		t.mu.Unlock()
		s.version.Add(1)
	}()
	for ctx.Err() == nil {
		st, sample := s.current()
		if st == nil {
			return
		}
		classify, model, by, ok := s.sorter(ctx, st, sample)
		if !ok {
			return
		}
		todo, err := st.TriagePending(ctx, triageWindow)
		if err != nil {
			s.triageFailed(err)
			return
		}
		t.mu.Lock()
		left := todo[:0]
		for _, td := range todo {
			if t.tries[todoKey(td)] < triageMaxTries {
				left = append(left, td)
			}
		}
		if len(left) == 0 {
			again := t.again
			t.again = false
			t.mu.Unlock()
			if again {
				continue
			}
			return
		}
		first := t.pending == 0
		t.pending, t.by = len(left), by
		t.mu.Unlock()
		if first {
			s.version.Add(1) // the screen shows "Sorting N conversations…"
		}
		batch := left[:min(triageBatch, len(left))]
		convs := make([]ai.Conversation, 0, len(batch))
		senders := map[string]string{}
		for _, td := range batch {
			ms, err := st.ThreadMail(ctx, td.AccountID, td.ThreadKey, 3)
			if err != nil || len(ms) == 0 {
				continue
			}
			cv := ai.Conversation{Key: todoKey(td)}
			for _, m := range ms {
				from := m.FromName
				if from == "" {
					from = m.FromAddr
				} else if m.FromAddr != "" {
					from += " <" + m.FromAddr + ">"
				}
				body := m.BodyText
				if body == "" {
					body = m.Snippet
				}
				cv.Mail = append(cv.Mail, ai.Mail{From: from, Date: time.Unix(m.Date, 0).Format("2006-01-02 15:04"), Subject: m.Subject, Body: body})
			}
			senders[cv.Key] = ms[len(ms)-1].FromAddr
			convs = append(convs, cv)
		}
		got := map[string]bool{}
		if len(convs) > 0 {
			verdicts, err := classify(ctx, convs)
			if err != nil {
				if ctx.Err() == nil {
					s.triageFailed(err)
					t.mu.Lock()
					for _, td := range batch {
						t.tries[todoKey(td)]++
					}
					t.mu.Unlock()
				}
				return
			}
			for _, v := range verdicts {
				td := findTodo(batch, v.Key)
				if td == nil {
					continue
				}
				if err := st.SaveTriage(ctx, store.Triage{AccountID: td.AccountID, ThreadKey: td.ThreadKey, MessageID: td.Newest,
					Category: v.Category, Reply: v.Reply, Summary: v.Summary, Model: model}, senders[v.Key]); err != nil {
					s.triageFailed(err)
					return
				}
				got[v.Key] = true
			}
		}
		t.mu.Lock()
		for _, td := range batch {
			if !got[todoKey(td)] {
				t.tries[todoKey(td)]++ // not answered: at most triageMaxTries more calls
			}
		}
		t.wait = 0
		t.mu.Unlock()
		s.version.Add(1)
	}
}

func findTodo(batch []store.TriageTodo, key string) *store.TriageTodo {
	for i := range batch {
		if todoKey(batch[i]) == key {
			return &batch[i]
		}
	}
	return nil
}

// triageFailed cools down before the next run: 2 minutes, doubling to 30.
// Nothing is shown; the next sync after the wait tries again.
func (s *Service) triageFailed(err error) {
	t := &s.tri
	t.mu.Lock()
	defer t.mu.Unlock()
	t.wait = min(max(triageMinWait, t.wait*2), triageMaxWait)
	t.failUntil = time.Now().Add(t.wait)
	s.log.Info("mail: triage paused", "err", err, "retry_in", t.wait)
}

// triageStatus is the state route's triage part: whether a run is on, how
// many conversations it has left, who sorts, and the label counts.
func (s *Service) triageStatus(ctx context.Context, st *store.Store) map[string]any {
	counts, err := st.TriageCounts(ctx)
	if err != nil {
		counts = []store.TriageCount{}
	}
	t := &s.tri
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]any{"running": t.running && t.pending > 0, "pending": t.pending, "by": t.by, "counts": counts}
}

type labelReq struct {
	MessageID int64  `json:"message_id"`
	Category  string `json:"category"`
}

// triageLabel is the user's own label for a conversation ("Not spam"). It is
// kept from then on, and a label other than spam clears the sender.
func (s *Service) triageLabel(w http.ResponseWriter, r *http.Request) {
	s.with(w, r, func(st *store.Store, _ *engine.Engine) {
		var req labelReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			fail(w, 400, err)
			return
		}
		if !ai.ValidCategory(req.Category) {
			fail(w, 400, fmt.Errorf("category must be one of %s", strings.Join(ai.Categories, ", ")))
			return
		}
		m, err := st.Message(r.Context(), req.MessageID)
		if errors.Is(err, store.ErrNotFound) {
			fail(w, 404, err)
			return
		}
		if err != nil {
			fail(w, 500, err)
			return
		}
		if err := st.LabelTriage(r.Context(), m.AccountID, m.ThreadKey, req.Category, m.FromAddr); err != nil {
			fail(w, 500, err)
			return
		}
		s.version.Add(1)
		writeJSON(w, map[string]bool{"ok": true})
	})
}

// canned labels the sample inbox by sender: what a model would say, made up
// with the sample, so the feature shows without a call.
var canned = map[string]ai.Verdict{
	"maya@northwind.io":                 {Category: ai.CatImportant, Reply: true, Summary: "Maya needs your infrastructure line items for the Q4 budget by Thursday evening."},
	"noreply@github.com":                {Category: ai.CatUpdates, Summary: "PR #482 merged into main: webhook deliveries now retry with backoff."},
	"tomas@acme-logistics.com":          {Category: ai.CatImportant, Summary: "Tomás sent the countersigned contract renewal; the new term starts on the 1st."},
	"jonas@northwind.io":                {Category: ai.CatImportant, Reply: true, Summary: "Jonas asks to move the hiring plan to day 1 of the offsite; comments due Wednesday."},
	"priya@northwind.io":                {Category: ai.CatImportant, Summary: "Priya's first offsite agenda draft; comments welcome before Wednesday."},
	"receipts@stripe.com":               {Category: ai.CatUpdates, Summary: "Stripe receipt: $2,140.00 paid to Northwind Cloud (compute and storage)."},
	"lena@designhaus.studio":            {Category: ai.CatImportant, Summary: "Lena shared three brand directions (she prefers B) and wants a call this week."},
	"security@northwind.io":             {Category: ai.CatUpdates, Summary: "New sign-in from Safari on macOS in Lisbon; nothing to do if it was you."},
	"sofia.m@icloud.com":                {Category: ai.CatImportant, Reply: true, Summary: "Sofia asks if you're in for dinner at the new Georgian place, Saturday at 8."},
	"noreply@flytap.com":                {Category: ai.CatUpdates, Summary: "Flight booked: LIS → BER on 14 Nov, 07:25, reference K7Q2XP."},
	"rcosta@gmail.com":                  {Category: ai.CatImportant, Reply: true, Summary: "Your landlord asks if someone is home Tuesday 9–12 for the boiler service."},
	"kale@hackernewsletter.com":         {Category: ai.CatNewsletter, Summary: "Weekly digest: local-first software, SQLite in production, slow mail clients."},
	"deals@shopmart-offers.biz":         {Category: ai.CatNewsletter, Summary: "Promotion: 40% off everything this weekend."},
	"alerts@mailbox-verify-center.info": {Category: ai.CatSpam, Summary: "Claims your mailbox will be closed and asks you to sign in through a look-alike link."},
}

func cannedTriage(_ context.Context, convs []ai.Conversation) ([]ai.Verdict, error) {
	var out []ai.Verdict
	for _, cv := range convs {
		v := ai.Verdict{Category: ai.CatUpdates, Summary: ai.CleanLine(cv.Mail[len(cv.Mail)-1].Subject, ai.SummaryMax)}
		// The newest message from a known sender: the user's own reply in a
		// conversation names no one.
	find:
		for i := len(cv.Mail) - 1; i >= 0; i-- {
			for addr, c := range canned {
				if strings.Contains(cv.Mail[i].From, addr) {
					v = c
					break find
				}
			}
		}
		v.Key = cv.Key
		out = append(out, v)
	}
	return out, nil
}
