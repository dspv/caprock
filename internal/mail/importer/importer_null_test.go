package importer

import (
	"encoding/json"
	"strings"
	"testing"
)

// A source with no accounts is an empty list in JSON, never null: the
// first-run screen counts every source's accounts.
func TestSourcesNeverSendNullAccounts(t *testing.T) {
	b, err := json.Marshal(Sources(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"accounts":null`) || string(b) == "null" {
		t.Fatalf("null in %s", b)
	}
}
