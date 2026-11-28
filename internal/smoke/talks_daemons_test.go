//go:build smoke

package smoke

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dspv/caprock/internal/peers"
	"github.com/dspv/caprock/internal/remote"
)

// ADR-110 P1, the backend end to end: two real daemons of two people, each
// in its own home and data directory, a relay in this test on loopback
// (relaysrv — never the hosted one), and the fake claude as each side's
// agent (never a real one). Dima invites; Ana accepts with the link, which
// turns access from anywhere on at her side; Dima starts a Talk; the agents
// talk both ways; Ana's never-share term holds her agent's reply, which she
// sends from the hold redacted; the message caps stop both; Ana's person
// token reaches the Talk inbox on Dima's side and nothing else; and Ana's
// Remove cuts the link both ways, after which her token is refused and the
// Talk is ended on both sides.
func TestTwoPeopleTalkThroughTheirAgents(t *testing.T) {
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	bin := filepath.Join(root, "bin")
	dHome, dData := filepath.Join(root, "dima-home"), filepath.Join(root, "dima-data")
	aHome, aData := filepath.Join(root, "ana-home"), filepath.Join(root, "ana-data")
	for _, d := range []string{bin, dHome, dData, aHome, aData} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	exe := ""
	if runtime.GOOS == "windows" {
		exe = ".exe"
	}
	caprock := filepath.Join(bin, "caprock"+exe)
	goBuild(t, caprock, "./cmd/caprock")
	goBuild(t, filepath.Join(bin, "claude"+exe), "./testdata/fakeclaude")
	t.Cleanup(func() {
		killHolders(t, dData)
		killHolders(t, aData)
		if runtime.GOOS == "windows" {
			time.Sleep(2 * time.Second)
		}
	})

	relay := startRelay(t, "127.0.0.1:0")
	relayURL := "ws://" + relay.addr

	dPort, aPort := freePort(t), freePort(t)
	dBase := "http://127.0.0.1:" + strconv.Itoa(dPort)
	aBase := "http://127.0.0.1:" + strconv.Itoa(aPort)
	dEnv, aEnv := daemonEnv(bin, dHome, dData), daemonEnv(bin, aHome, aData)
	dima := startBinary(t, caprock, dEnv, dPort, dData, "dima")
	ana := startBinary(t, caprock, aEnv, aPort, aData, "ana")
	logs := func() string { return "\ndima log:\n" + dima.log() + "\nana log:\n" + ana.log() }

	// Both chose this relay and left access from anywhere off: inviting
	// and accepting turn it on.
	post(t, dBase+"/v1/pair/remote", `{"on":false,"relay":"`+relayURL+`"}`)
	post(t, aBase+"/v1/pair/remote", `{"on":false,"relay":"`+relayURL+`"}`)
	if code := callJSON(t, "PUT", dBase+"/v1/talks/settings", `{"name":"Dima","max_messages":3}`, nil); code != 200 {
		t.Fatalf("Dima's settings: %d", code)
	}
	if code := callJSON(t, "PUT", aBase+"/v1/talks/settings", `{"name":"Ana","max_messages":3,"never_share":["Pelican"]}`, nil); code != 200 {
		t.Fatalf("Ana's settings: %d", code)
	}

	// Dima: one invitation, a day long, as a link.
	var inv struct {
		Key            string `json:"key"`
		Link           string `json:"link"`
		State          string `json:"state"`
		ExpiresAt      int64  `json:"expires_at"`
		TurnedOnRemote bool   `json:"turned_on_remote"`
	}
	if code := callJSON(t, "POST", dBase+"/v1/talks/invite", `{}`, &inv); code != 200 || inv.Link != "https://caprock.dev/talk#"+inv.Key || !strings.HasPrefix(inv.Key, "cj1-") || !inv.TurnedOnRemote {
		t.Fatalf("invite: %d %+v%s", code, inv, logs())
	}
	if left := time.Until(time.UnixMilli(inv.ExpiresAt)); left < 23*time.Hour {
		t.Fatalf("the invitation lives %s, want a day", left)
	}
	waitInviteOnline(t, dBase, logs)

	// Ana: Accept, with the whole link pasted.
	var dimaThere struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Status     string `json:"status"`
		LetStart   bool   `json:"let_start"`
		SafetyCode string `json:"safety_code"`
	}
	if code := callJSON(t, "POST", aBase+"/v1/talks/accept", `{"key":`+strconv.Quote(inv.Link)+`}`, &dimaThere); code != 200 || dimaThere.Name != "Dima" || !dimaThere.LetStart || dimaThere.Status != "online" {
		t.Fatalf("accept: %d %+v%s", code, dimaThere, logs())
	}
	var people struct {
		People []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			LetStart   bool   `json:"let_start"`
			SafetyCode string `json:"safety_code"`
		} `json:"people"`
	}
	getJSONAt(t, dBase+"/v1/talks/people", &people)
	if len(people.People) != 1 || people.People[0].Name != "Ana" || !people.People[0].LetStart || people.People[0].SafetyCode != dimaThere.SafetyCode {
		t.Fatalf("Dima's people: %+v (Ana's safety code %q)", people, dimaThere.SafetyCode)
	}
	anaID := people.People[0].ID
	if runtime.GOOS != "windows" {
		for _, dir := range []string{dData, aData} {
			if fi, err := os.Stat(filepath.Join(dir, peers.PeopleFile)); err != nil || fi.Mode().Perm() != 0o600 {
				t.Fatalf("%s: %v %v", peers.PeopleFile, fi, err)
			}
		}
	}

	// Dima starts a Talk; his agent opens with the goal.
	var talk struct {
		ID string `json:"id"`
	}
	if code := callJSON(t, "POST", dBase+"/v1/talks", `{"person":`+strconv.Quote(anaID)+`,"goal":"Plan the pelican launch"}`, &talk); code != 200 || talk.ID == "" {
		t.Fatalf("start: %d %+v%s", code, talk, logs())
	}

	// Ana's agent echoes the goal back: her never-share term holds it.
	held := waitTalkState(t, aBase, talk.ID, func(v talkView) bool { return v.State == "held" }, "Ana's hold", logs)
	if held.Hold != "redaction" || !strings.Contains(held.DraftCaught, "never-share") || strings.Contains(strings.ToLower(held.DraftRedacted), "pelican") || held.StartedBy != "them" {
		t.Fatalf("Ana's hold: %+v", held)
	}
	if v := getTalk(t, dBase, talk.ID); v.countFrom("them") != 0 {
		t.Fatalf("Dima received a held message: %+v", v)
	}
	if code := callJSON(t, "POST", aBase+"/v1/talks/"+talk.ID+"/held/send", `{}`, nil); code != 200 {
		t.Fatalf("send from the hold: %d%s", code, logs())
	}

	// Turns go both ways until Dima's cap: 3 messages each.
	dv := waitTalkState(t, dBase, talk.ID, func(v talkView) bool { return v.State == "held" }, "Dima's cap", logs)
	if dv.Hold != "cap" || dv.Sent != 3 || dv.countFrom("them") != 3 || dv.TheirCost == nil {
		t.Fatalf("Dima at his cap: %+v", dv)
	}
	av := waitTalkState(t, aBase, talk.ID, func(v talkView) bool { return v.Sent == 3 && v.Waiting == 0 }, "Ana's third", logs)
	for _, e := range av.Transcript {
		if e.Side == "me" && strings.Contains(strings.ToLower(e.Envelope.Body), "pelican") {
			t.Fatalf("Ana's side sent the never-share term: %q", e.Envelope.Body)
		}
	}
	for _, e := range av.Transcript {
		if e.Side == "me" && e.Envelope.Kind == "message" {
			if e.How != "from_hold" {
				t.Fatalf("Ana's first message went %q, want from_hold", e.How)
			}
			break
		}
	}

	// Ana's person token on Dima's Caprock: the inbox and nothing else.
	m := personManager(t, aData, root)
	if code := doJSON(t, m, dimaThere.ID, "GET", "/v1/sessions", "", nil); code != http.StatusForbidden {
		t.Fatalf("a person read Dima's sessions: %d", code)
	}
	if code := doJSON(t, m, dimaThere.ID, "GET", "/v1/talks", "", nil); code != http.StatusForbidden {
		t.Fatalf("a person read Dima's talks: %d", code)
	}
	if code := doJSON(t, m, dimaThere.ID, "GET", "/v1/talks/inbox/"+talk.ID, "", nil); code != http.StatusOK {
		t.Fatalf("a person read the delivery state of their talk: %d", code)
	}

	// Ana removes Dima: the link ends both ways.
	if code := callJSON(t, "DELETE", aBase+"/v1/talks/people/"+dimaThere.ID, "", nil); code != 200 {
		t.Fatalf("remove: %d%s", code, logs())
	}
	if code := doJSON(t, m, dimaThere.ID, "POST", "/v1/talks/inbox", `{"envelope":{}}`, nil); code != http.StatusUnauthorized {
		t.Fatalf("after the Remove Ana's token delivered: %d%s", code, logs())
	}
	if v := getTalk(t, aBase, talk.ID); v.State != "ended" || v.EndedBy != "me" {
		t.Fatalf("Ana's talk after her Remove: %+v", v)
	}
	if v := waitTalkState(t, dBase, talk.ID, func(v talkView) bool { return v.State == "ended" }, "Dima's end", logs); v.EndedBy != "them" {
		t.Fatalf("Dima's talk after Ana's Remove: %+v", v)
	}
	getJSONAt(t, dBase+"/v1/talks/people", &people)
	if len(people.People) != 0 {
		t.Fatalf("Dima still lists %+v", people)
	}
	// Dima's token on Ana's side went too: Continue sends nothing anywhere.
	if code := callJSON(t, "POST", dBase+"/v1/talks/"+talk.ID+"/continue", `{}`, nil); code != http.StatusConflict {
		t.Fatalf("continue an ended talk: %d", code)
	}

	// The invitation key is in no log and no file on either side.
	jk := strings.TrimPrefix(inv.Key, "cj1-")
	if strings.Contains(dima.log(), jk) || strings.Contains(ana.log(), jk) {
		t.Fatal("a daemon logged the invitation key")
	}
	for _, dir := range []string{dData, aData} {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil //nolint:nilerr // a file that vanished mid-walk holds nothing
			}
			if raw, err := os.ReadFile(p); err == nil && strings.Contains(string(raw), jk) {
				t.Errorf("%s holds the invitation key", p)
			}
			return nil
		})
	}
	m.Close()
	relay.stop()
	dima.stop(t, true)
	ana.stop(t, true)
}

type talkView struct {
	ID            string   `json:"id"`
	State         string   `json:"state"`
	Hold          string   `json:"hold"`
	EndedBy       string   `json:"ended_by"`
	StartedBy     string   `json:"started_by"`
	Sent          int      `json:"sent"`
	TheirCost     *float64 `json:"their_cost_usd"`
	DraftRedacted string   `json:"draft_redacted"`
	DraftCaught   string   `json:"draft_caught"`
	Waiting       int      `json:"waiting"`
	Transcript    []struct {
		Side     string `json:"side"`
		How      string `json:"how"`
		Envelope struct {
			Kind string `json:"kind"`
			Body string `json:"body"`
		} `json:"envelope"`
	} `json:"transcript"`
}

func (v talkView) countFrom(side string) int {
	n := 0
	for _, e := range v.Transcript {
		if e.Side == side && e.Envelope.Kind == "message" {
			n++
		}
	}
	return n
}

func getTalk(t *testing.T, base, id string) talkView {
	t.Helper()
	var v talkView
	if code := callJSON(t, "GET", base+"/v1/talks/"+id, "", &v); code != 200 {
		return talkView{}
	}
	return v
}

func waitTalkState(t *testing.T, base, id string, ok func(talkView) bool, what string, logs func() string) talkView {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for {
		v := getTalk(t, base, id)
		if ok(v) {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never came: %+v%s", what, v, logs())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func waitInviteOnline(t *testing.T, base string, logs func() string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var st struct {
			RelayStatus string `json:"relay_status"`
		}
		getJSONAt(t, base+"/v1/talks/invite", &st)
		if st.RelayStatus == "online" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the invitation never reached the relay: %+v%s", st, logs())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// personManager is this test holding Ana's person token on Dima's side, as
// her daemon does: a copy of her people.json, her relay key proved.
func personManager(t *testing.T, data, root string) *peers.Manager {
	t.Helper()
	dir := filepath.Join(root, "ana-copy")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(data, peers.PeopleFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, peers.PeopleFile), b, 0o600); err != nil {
		t.Fatal(err)
	}
	set, err := remote.Load(data)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := set.Keys()
	if err != nil {
		t.Fatal(err)
	}
	m, err := peers.Open(peers.Options{Dir: dir, File: peers.PeopleFile, Name: "Ana", Identity: keys.Sign})
	if err != nil {
		t.Fatal(err)
	}
	return m
}
