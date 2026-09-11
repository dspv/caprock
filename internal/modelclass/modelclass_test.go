package modelclass

import "testing"

func TestIsInternalIsAnExplicitAllowList(t *testing.T) {
	for _, id := range []string{"codex-auto-review", " CODEX-AUTO-REVIEW "} {
		if !IsInternal(id) {
			t.Errorf("%q was not recognised", id)
		}
	}
	for _, id := range []string{"", "gpt-5.6-sol", "codex-auto-review-next"} {
		if IsInternal(id) {
			t.Errorf("%q was hidden by an over-broad rule", id)
		}
	}
}
