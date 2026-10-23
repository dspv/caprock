package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/redact"
)

// Fake values only: the Stripe docs' test card, a made-up key.
const (
	fakeCard = "4242 4242 4242 4242"
	fakeKey  = "sk-ant-api03-AbCdEf0123456789xyzXYZ_abcd"
)

func TestBrainNodeIsRedactedBeforeItIsSaved(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	n, _, err := InsertBrainNode(ctx, s.db, BrainNode{
		Kind: BrainDecision, Title: "Pay the hosting with card " + fakeCard,
		Summary:  "The key " + fakeKey + " lives in .env; password: hunter2! for the staging admin. Commit 3ce9d978 shipped it for $30/year.",
		Keywords: []string{"hosting", fakeKey, "billing"},
		Source:   BrainSource{Project: "acme"},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{"4242", "sk-ant", "hunter2"} {
		if strings.Contains(n.Title+n.Summary+n.Keywords.String(), gone) {
			t.Fatalf("%q kept: %+v", gone, n)
		}
	}
	if !strings.Contains(n.Title, redact.Placeholder(redact.KindCard)) || !strings.Contains(n.Summary, "3ce9d978") || !strings.Contains(n.Summary, "$30/year") {
		t.Fatalf("title %q summary %q", n.Title, n.Summary)
	}
	if n.Keywords.String() != "hosting, billing" {
		t.Fatalf("keywords %q", n.Keywords)
	}
	var search string
	if err := s.db.QueryRowContext(ctx, `SELECT search FROM brain_nodes WHERE id = ?`, n.ID).Scan(&search); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(search, "4242") || strings.Contains(search, "sk-ant") {
		t.Fatalf("search keeps a secret: %q", search)
	}

	// An edit by hand goes through the filter too.
	sum := "routing # 021000021"
	u, err := UpdateBrainNode(ctx, s.db, n.ID, BrainPatch{Summary: &sum}, 2)
	if err != nil || strings.Contains(u.Summary, "021000021") {
		t.Fatalf("patch kept it: %q %v", u.Summary, err)
	}
}

// The filter never leaves a title empty: a title that is nothing but a
// secret is kept as the placeholder that names it, so the memory is stored
// rather than refused as one with no title.
func TestATitleThatIsWhollyASecretKeepsItsPlaceholder(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	for _, title := range []string{fakeKey, "  " + fakeKey + "  ", fakeCard} {
		n, created, err := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainFinding, Title: title, Summary: "Found in the logs."}, 1)
		if err != nil || !created {
			t.Fatalf("%q: created %v, err %v", title, created, err)
		}
		if NormTitle(n.Title) == "" || !strings.HasPrefix(n.Title, "[redacted: ") || strings.Contains(n.Title, "sk-ant") || strings.Contains(n.Title, "4242") {
			t.Fatalf("%q stored as %q", title, n.Title)
		}
	}
	// A title that is only punctuation is refused, as before: there is
	// nothing in it the filter took.
	if _, _, err := InsertBrainNode(ctx, s.db, BrainNode{Kind: BrainFinding, Title: " / ", Summary: "x"}, 1); !errors.Is(err, ErrBrainInvalid) {
		t.Fatalf("a title of punctuation: %v", err)
	}
}

func TestBrainKeywordsFromRetagAreRedacted(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	n := mustBrain(t, s, BrainNode{Kind: BrainFinding, Title: "Stripe sandbox works"})
	if _, err := SetBrainKeywords(ctx, s.db, n.ID, []string{"stripe", "sk_" + "test_FAKEfake0123456789abcd"}); err != nil {
		t.Fatal(err)
	}
	got, _ := GetBrainNode(ctx, s.db, n.ID)
	if got.Keywords.String() != "stripe" {
		t.Fatalf("keywords %q", got.Keywords)
	}
}

func TestScrubBrainSecretsRedactsOldRowsOnce(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	// Rows as an earlier version stored them: straight into the table.
	if _, err := s.db.ExecContext(ctx, `INSERT INTO brain_nodes (kind, title, norm, summary, search, project, created_at, updated_at, keywords)
		VALUES ('finding', 'Bank details for the invoice', 'bank details for the invoice', ?, ?, 'acme', 1, 1, ?)`,
		"IBAN DE89 3704 0044 0532 0130 00, card "+fakeCard, "bank details de89 3704 0044 0532 0130 00 "+fakeCard, "invoice, "+fakeKey); err != nil {
		t.Fatal(err)
	}
	clean := mustBrain(t, s, BrainNode{Kind: BrainIdea, Title: "Keep SQLite in WAL mode", Summary: "Version 0.149.0, commit 8ce675d0, session 0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a."})

	nodes, notes, counts, err := ScrubBrainSecrets(ctx, s.db, 5)
	if err != nil {
		t.Fatal(err)
	}
	if nodes != 1 || notes != 0 || counts[redact.KindIBAN] != 1 || counts[redact.KindCard] != 1 || counts[redact.KindAPIKey] != 1 {
		t.Fatalf("nodes=%d notes=%d counts=%v", nodes, notes, counts)
	}
	var summary, search, kw string
	if err := s.db.QueryRowContext(ctx, `SELECT summary, search, keywords FROM brain_nodes WHERE title = 'Bank details for the invoice'`).Scan(&summary, &search, &kw); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{summary, search, kw} {
		if strings.Contains(v, "3704") || strings.Contains(v, "4242") || strings.Contains(v, "sk-ant") {
			t.Fatalf("scrub left a value: %q", v)
		}
	}
	if kw != "invoice" {
		t.Fatalf("keywords %q", kw)
	}
	if got, _ := GetBrainNode(ctx, s.db, clean.ID); got.Summary != clean.Summary || got.UpdatedAt != clean.UpdatedAt {
		t.Fatalf("an ordinary memory changed: %+v", got)
	}
	// Idempotent: nothing left to do.
	nodes, notes, counts, err = ScrubBrainSecrets(ctx, s.db, 6)
	if err != nil || nodes != 0 || notes != 0 || counts.Total() != 0 {
		t.Fatalf("second run: nodes=%d notes=%d counts=%v err=%v", nodes, notes, counts, err)
	}
}

func TestScrubBrainSecretsRedactsNoteExcerpts(t *testing.T) {
	ctx := context.Background()
	s := openTest(t)
	v, err := InsertBrainVault(ctx, s.db, "notes", "/vault", false, 1)
	if err != nil {
		t.Fatal(err)
	}
	note := BrainVaultNote{VaultID: v.ID, Path: "bank.md", Title: "Bank", Excerpt: "card " + fakeCard + " for the hosting", Mtime: 1}
	id, err := InsertBrainNoteNode(ctx, s.db, v.ID, note, 1)
	if err != nil {
		t.Fatal(err)
	}
	note.NodeID = id
	if _, err := InsertBrainVaultNote(ctx, s.db, note); err != nil {
		t.Fatal(err)
	}
	nodes, notes, counts, err := ScrubBrainSecrets(ctx, s.db, 5)
	if err != nil || nodes != 1 || notes != 1 || counts[redact.KindCard] != 1 {
		t.Fatalf("nodes=%d notes=%d counts=%v err=%v", nodes, notes, counts, err)
	}
	var excerpt, summary, search string
	if err := s.db.QueryRowContext(ctx, `SELECT excerpt FROM brain_vault_notes`).Scan(&excerpt); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRowContext(ctx, `SELECT summary, search FROM brain_nodes WHERE id = ?`, id).Scan(&summary, &search); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{excerpt, summary, search} {
		if strings.Contains(v, "4242") {
			t.Fatalf("left in %q", v)
		}
	}
}
