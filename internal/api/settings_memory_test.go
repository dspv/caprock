package api

import (
	"net/http"
	"testing"
)

// Turning memory off must actually turn it off.
//
// It did not. The PUT handler decodes into a patch of pointers so an absent
// field can be told from a cleared one, and this field was added to Settings
// without being added to that patch: `{"memory":false}` answered 200 and
// changed nothing. The worst shape of bug — the screen showed the box unticked
// while the feature kept running.
func TestMemoryCanBeTurnedOff(t *testing.T) {
	e := newEnv(t)

	get := func() Settings {
		t.Helper()
		var s Settings
		if code := e.get(t, "/v1/settings", &s); code != http.StatusOK {
			t.Fatalf("GET settings: %d", code)
		}
		return s
	}

	if !get().Memory {
		t.Fatal("memory should be on by default")
	}
	if code := e.putSettings(t, map[string]any{"memory": false}); code != http.StatusOK {
		t.Fatalf("turning it off: %d", code)
	}
	if get().Memory {
		t.Fatal("memory stayed on after being turned off")
	}
	if code := e.putSettings(t, map[string]any{"memory": true}); code != http.StatusOK {
		t.Fatalf("turning it on: %d", code)
	}
	if !get().Memory {
		t.Fatal("memory stayed off after being turned back on")
	}

	// A body that does not mention memory must not change it — the rule that
	// already protects the plan and the bot token from a partial save.
	_ = e.putSettings(t, map[string]any{"memory": false})
	_ = e.putSettings(t, map[string]any{"plan_label": "Max 20×"})
	if get().Memory {
		t.Fatal("an unrelated save switched memory back on")
	}
}
