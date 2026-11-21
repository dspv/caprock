package api

import (
	"testing"
	"time"

	"github.com/dspv/caprock/internal/cost"
	"github.com/dspv/caprock/internal/modelclass"
)

// Every Cursor model name the pricing watch found unmapped on 2026-11-17
// (cursor.com/docs/models and Caprock's own Cursor picker) reaches a priced
// row, so the overhead's "at list price" column has a figure for it. The
// Cursor chat itself is still never priced from the table (ADR-095).
func TestCursorNamesMapToPricedRows(t *testing.T) {
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatalf("embedded table: %v", err)
	}
	for name, want := range map[string]string{
		"grok-4.7":           "cursor-grok-4.7",
		"grok-4.7-fast":      "cursor-grok-4.7",
		"grok-4.7-500k":      "cursor-grok-4.7-500k",
		"grok-4.7-500k-fast": "cursor-grok-4.7-500k",
		"grok-4.6":           "cursor-grok-4.6",
		"grok-4.6-fast":      "cursor-grok-4.6",
		"grok-4.5":           "cursor-grok-4.5",
		"grok-4.5-fast":      "cursor-grok-4.5",
		"muse-wonder":        "cursor-muse-wonder",
		"muse-wonder-1.0":    "cursor-muse-wonder",
		"gemini-3.1-pro":     "gemini-3.1-pro-preview",
		"sonnet-4":           "claude-sonnet-4",
		"sonnet-4-thinking":  "claude-sonnet-4",
		"composer-2.5":       "cursor-composer-2.5",
		"composer-2.5-fast":  "cursor-composer-2.5",
		"claude-4.5-sonnet":  "claude-sonnet-4-5",
		"gpt-5.6-sol":        "gpt-5.6-sol",
		// The names on the owner's unpriced Cursor chats (2026-11-21): the
		// table knows every one, so their tokens are unpriced only because
		// Cursor recorded no cost for those chats (ADR-095).
		"claude-4-sonnet":            "claude-sonnet-4",
		"claude-4.5-sonnet-thinking": "claude-sonnet-4-5",
		"claude-4-opus-thinking":     "claude-opus-4",
		"claude-4.1-opus-thinking":   "claude-opus-4-1",
		"gpt-5":                      "gpt-5",
		"gpt-4.1":                    "gpt-4.1",
		"o3":                         "o3",
	} {
		m, ok := tb.LookupAt(cursorFamilyID(modelclass.Family(name)), time.Now())
		if !ok {
			t.Errorf("%q: no priced row", name)
			continue
		}
		if m.ID != want {
			t.Errorf("%q priced by %q, want %q", name, m.ID, want)
		}
		if m.Input == 0 && m.Output == 0 {
			t.Errorf("%q: row %q has no price", name, m.ID)
		}
	}
}

// Every id the map points at is a row in the table, so a renamed row cannot
// leave a mapping silently unpriced.
func TestCursorFamilyIDsAreRows(t *testing.T) {
	tb, err := cost.Embedded()
	if err != nil {
		t.Fatalf("embedded table: %v", err)
	}
	for fam, id := range cursorFamilyIDs {
		if m, ok := tb.LookupAt(id, time.Now()); !ok || m.ID != id {
			t.Errorf("cursorFamilyIDs[%q] = %q, which is not a row in pricing.json", fam, id)
		}
	}
}
