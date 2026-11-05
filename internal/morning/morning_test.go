package morning

import (
	"strings"
	"testing"
	"time"
)

var thursday = time.Date(2026, 11, 5, 8, 0, 0, 0, time.UTC)

func fixture() Summary {
	return Summary{
		Now: thursday,
		Mail: &Mail{Important: 7, Total: 41, Items: []MailItem{
			{Sender: "Anna Lee", Subject: "Contract for review"},
			{Sender: "GitHub <noreply>", Subject: "Re: release & notes"},
			{Sender: "", Subject: ""},
			{Sender: "Bob", Subject: "Lunch?"},
			{Sender: "Chloé", Subject: "Invoice 2026-11"},
			{Sender: "Dan", Subject: "Not shown: past the fifth"},
		}},
		Projects: []Project{
			{Name: "caprock", Finished: 4, AtLimit: 1, Errored: 1},
			{Name: "site", Finished: 1},
		},
		Waiting: []Waiting{
			{Project: "caprock", Title: "Fix the cache test", Reason: "permission"},
			{Project: "site", Title: "", Reason: "asks"},
		},
		Approvals: 2,
	}
}

func TestMessageGolden(t *testing.T) {
	got := Message(fixture())
	want := strings.Join([]string{
		"<b>Good morning · Thursday</b>",
		"",
		"<b>Mail</b> — 7 important of 41 new",
		"• Anna Lee: Contract for review",
		"• GitHub &lt;noreply&gt;: Re: release &amp; notes",
		"• (no sender): (no subject)",
		"• Bob: Lunch?",
		"• Chloé: Invoice 2026-11",
		"+2 more",
		"",
		"<b>Agents overnight</b>",
		"• caprock — 4 sessions finished, 1 at a usage limit, 1 exited with an error",
		"• site — 1 session finished",
		"",
		"<b>Waiting for you</b>",
		"• caprock · Fix the cache test — approval",
		"• site — asks you something",
		"• 2 tasks wait for your approval",
	}, "\n")
	if got != want {
		t.Fatalf("message:\n%s\n--- want ---\n%s", got, want)
	}
}

func TestMessageLeavesOutEmptySections(t *testing.T) {
	got := Message(Summary{Now: thursday, Projects: []Project{{Name: "caprock", Finished: 2}}})
	if strings.Contains(got, "Mail") || strings.Contains(got, "Waiting") {
		t.Fatalf("empty sections shown:\n%s", got)
	}
	// Mail with nothing new is left out too, as is nil mail (triage off).
	got = Message(Summary{Now: thursday, Mail: &Mail{}, Approvals: 1})
	if strings.Contains(got, "Mail") || !strings.Contains(got, "1 task waits for your approval") {
		t.Fatalf("got:\n%s", got)
	}
	if got := Message(Summary{Now: thursday}); got != "<b>Good morning · Thursday</b>\n\nNothing new since the last summary." {
		t.Fatalf("empty summary: %q", got)
	}
}

func TestMessageCapsLists(t *testing.T) {
	s := Summary{Now: thursday}
	for i := 0; i < ProjectsMax+3; i++ {
		s.Projects = append(s.Projects, Project{Name: "p", Finished: 1})
	}
	for i := 0; i < WaitingMax+1; i++ {
		s.Waiting = append(s.Waiting, Waiting{Project: "w", Reason: "question"})
	}
	got := Message(s)
	if !strings.Contains(got, "+3 more projects") || !strings.Contains(got, "+1 more session") {
		t.Fatalf("got:\n%s", got)
	}
	if n := strings.Count(got, "• p —"); n != ProjectsMax {
		t.Fatalf("%d projects listed", n)
	}
}

func TestButtons(t *testing.T) {
	if b := Buttons(fixture(), ""); b != nil {
		t.Fatalf("no phone, buttons %v", b)
	}
	b := Buttons(fixture(), "https://m.caprock.dev/")
	if len(b) != 3 || b[0].URL != "https://m.caprock.dev/#/mail" || b[1].Text != "Answer agents" || b[2].URL != "https://m.caprock.dev/#/history" {
		t.Fatalf("buttons %+v", b)
	}
	s := fixture()
	s.Mail = nil
	if b := Buttons(s, "https://m.caprock.dev"); len(b) != 2 || b[0].Text != "Answer agents" {
		t.Fatalf("no mail section, buttons %+v", b)
	}
}

func at(h, m int) time.Time { return time.Date(2026, 11, 5, h, m, 0, 0, time.Local) }

func TestDueOffByDefaultAndOncePerDay(t *testing.T) {
	if Due(false, at(8, 5), "", "") {
		t.Fatal("sent while off")
	}
	if !Due(true, at(8, 0), "", "") {
		t.Fatal("not sent at the set time")
	}
	if Due(true, at(8, 5), "", "2026-11-05") {
		t.Fatal("sent twice in one day")
	}
	if !Due(true, at(8, 5), "", "2026-11-04") {
		t.Fatal("yesterday's marker held today's back")
	}
}

func TestDueAsleepAtEight(t *testing.T) {
	// Asleep at 08:00, awake at 10:40: sent that morning.
	if !Due(true, at(10, 40), "08:00", "2026-11-04") {
		t.Fatal("not sent on waking the same morning")
	}
	// Opened after noon: nothing that day.
	if Due(true, at(12, 0), "08:00", "2026-11-04") || Due(true, at(15, 0), "08:00", "") {
		t.Fatal("sent after noon")
	}
	// Before the set time: not yet.
	if Due(true, at(7, 59), "08:00", "") {
		t.Fatal("sent early")
	}
}

func TestDueAfternoonTime(t *testing.T) {
	if !Due(true, at(14, 30), "13:00", "") || Due(true, at(17, 1), "13:00", "") {
		t.Fatal("an afternoon time has a four-hour window")
	}
	if !Due(true, at(23, 59), "22:00", "") {
		t.Fatal("a late time runs to midnight")
	}
}

func TestParseAndNormalizeAt(t *testing.T) {
	for in, want := range map[string]string{"08:00": "08:00", "7:30": DefaultAt, "24:00": DefaultAt, "": DefaultAt, "23:59": "23:59", "ab:cd": DefaultAt} {
		if got := NormalizeAt(in); got != want {
			t.Errorf("NormalizeAt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSince(t *testing.T) {
	now := at(8, 0)
	if got := Since(now, 0); !got.Equal(now.Add(-24 * time.Hour)) {
		t.Fatalf("never sent: %v", got)
	}
	last := now.Add(-23 * time.Hour)
	if got := Since(now, last.UnixMilli()); !got.Equal(last) {
		t.Fatalf("since last: %v", got)
	}
	if got := Since(now, now.Add(-30*24*time.Hour).UnixMilli()); !got.Equal(now.Add(-24 * time.Hour)) {
		t.Fatalf("a month back is a day back: %v", got)
	}
}
