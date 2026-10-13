package engine

import (
	"testing"
)

func TestParseHeaderSurvivesWhatServersAndSendersGetWrong(t *testing.T) {
	raw := "From: =?ISO-8859-1?Q?Jos=E9_Garc=EDa?= <jose@example.es>\r\n" +
		"To: \"Ana, Sales\" <ana@example.com>, bo@example.com\r\n" +
		"Cc: broken <<c@example.com>, d@example.com\r\n" +
		"Subject: =?UTF-8?B?w4l0w6kg8J+Mng==?=\r\n" +
		"Message-ID: <a\"b\"c@icloud.example>\r\n" +
		"In-Reply-To: <root@x>\r\n" +
		"References: <root@x>\r\n <mid@x>\r\n" +
		"Date: Tue, 13 Oct 2026 10:00:00 +0200\r\n"
	hi := parseHeader([]byte(raw))
	if hi.From.Name != "José García" || hi.From.Addr != "jose@example.es" {
		t.Errorf("from = %+v", hi.From)
	}
	if len(hi.To) != 2 || hi.To[0].Name != "Ana, Sales" || hi.To[1].Addr != "bo@example.com" {
		t.Errorf("to = %+v", hi.To)
	}
	if len(hi.Cc) != 2 || hi.Cc[0].Addr != "c@example.com" || hi.Cc[1].Addr != "d@example.com" {
		t.Errorf("malformed cc recovered = %+v", hi.Cc)
	}
	if hi.Subject != "Été 🌞" {
		t.Errorf("subject = %q", hi.Subject)
	}
	if hi.MessageID != `a"b"c@icloud.example` {
		t.Errorf("message-id with quotes = %q", hi.MessageID)
	}
	if hi.InReplyTo != "root@x" || len(hi.Refs) != 2 || hi.Refs[0] != "root@x" {
		t.Errorf("threading = %q %v", hi.InReplyTo, hi.Refs)
	}
	if hi.Date.Unix() != 1791878400 {
		t.Errorf("date = %v", hi.Date)
	}
	if got := parseHeader([]byte("garbage without colon\r\n")); got.Subject != "" {
		t.Errorf("garbage: %+v", got)
	}
}
