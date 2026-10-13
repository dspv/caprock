package api

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/bus"
	"github.com/dspv/caprock/internal/rollup"
)

func (e *env) rename(t *testing.T, id, body string) int {
	t.Helper()
	r, _ := http.NewRequest(http.MethodPut, e.srv.URL+"/v1/sessions/"+id+"/name", bytes.NewReader([]byte(body)))
	r.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// A rename is stored, names the session on every list and detail, goes out as
// a session frame, survives the agent naming it again, and an empty name
// gives the session back its own title.
func TestRenameSession(t *testing.T) {
	e := newEnv(t)
	e.seed(t, t.TempDir())
	sub := e.bus.Subscribe(16)
	defer sub.Unsubscribe()

	if code := e.rename(t, "s1", `{"name":"  Fix   the   login\nbug  "}`); code != http.StatusOK {
		t.Fatalf("rename: %d", code)
	}
	var list []SessionSummary
	e.get(t, "/v1/sessions", &list)
	if len(list) != 1 || list[0].Name != "Fix the login bug" || list[0].Description != "Fix the login bug" || list[0].DescriptionSource != DescriptionName {
		t.Fatalf("list after rename: %+v", list)
	}
	select {
	case f := <-sub.C:
		sf, ok := f.Data.(rollup.SessionFrame)
		if f.Type != bus.FrameSession || !ok || sf.Session.Name != "Fix the login bug" {
			t.Fatalf("frame: %+v", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no session frame after a rename")
	}

	// The agent naming the session later does not undo the user's name.
	if _, err := e.st.DB().Exec(`UPDATE sessions SET title = 'Agent title' WHERE session_id = 's1'`); err != nil {
		t.Fatal(err)
	}
	var d SessionDetail
	e.get(t, "/v1/sessions/s1", &d)
	if d.Name != "Fix the login bug" || d.Description != "Fix the login bug" {
		t.Fatalf("detail: name %q description %q", d.Name, d.Description)
	}

	// Searching finds a session by the name it was given.
	e.get(t, "/v1/sessions?q=login", &list)
	if len(list) != 1 {
		t.Fatalf("search by name: %d sessions", len(list))
	}

	if code := e.rename(t, "s1", `{"name":""}`); code != http.StatusOK {
		t.Fatalf("clear: %d", code)
	}
	e.get(t, "/v1/sessions/s1", &d)
	if d.Name != "" || d.Description != "Agent title" || d.DescriptionSource != DescriptionTitle {
		t.Fatalf("after clearing: name %q description %q (%s)", d.Name, d.Description, d.DescriptionSource)
	}

	long := strings.Repeat("é", sessionNameMaxRunes+10)
	if code := e.rename(t, "s1", `{"name":"`+long+`"}`); code != http.StatusOK {
		t.Fatalf("long: %d", code)
	}
	e.get(t, "/v1/sessions/s1", &d)
	if got := []rune(d.Name); len(got) != sessionNameMaxRunes {
		t.Fatalf("long name kept %d runes", len(got))
	}

	if code := e.rename(t, "nope", `{"name":"x"}`); code != http.StatusNotFound {
		t.Fatalf("unknown session: %d", code)
	}
	if code := e.rename(t, "s1", `{}`); code != http.StatusBadRequest {
		t.Fatalf("no name: %d", code)
	}
}
