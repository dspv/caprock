package event

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestStripBinary(t *testing.T) {
	png := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("p", 6000))) // 6000 bytes decoded
	long := strings.Repeat("text is kept whole ", 5000)
	cases := []struct {
		name, in, want string
		changed        bool
	}{
		{
			name:    "an API image block",
			in:      `{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + png + `"}}]}`,
			want:    `{"content":[{"source":{"data":"[image image/png 6 KB not stored]","media_type":"image/png","type":"base64"},"type":"image"}]}`,
			changed: true,
		},
		{
			name:    "Claude Code's Read of an image",
			in:      `{"tool_response":{"type":"image","file":{"base64":"` + png + `","type":"image/png","originalSize":1}}}`,
			want:    `{"tool_response":{"file":{"base64":"[image image/png 6 KB not stored]","originalSize":1,"type":"image/png"},"type":"image"}}`,
			changed: true,
		},
		{
			name:    "a data URI",
			in:      `{"src":"data:image/jpeg;base64,` + png + `"}`,
			want:    `{"src":"[image image/jpeg 6 KB not stored]"}`,
			changed: true,
		},
		{
			name: "long text beside a base64 field stays whole",
			in:   `{"a":` + quote(long) + `,"b":{"base64":"` + png + `"}}`,
			want: `{"a":` + quote(long) + `,"b":{"base64":"[file 6 KB not stored]"}}`, changed: true,
		},
		{name: "long text alone", in: `{"stdout":` + quote(long) + `,"note":"base64 is a word"}`},
		{name: "a short data field beside a media type", in: `{"type":"image","media_type":"image/png","data":"abc"}`},
		{name: "plain text in a document block", in: `{"type":"document","media_type":"text/plain","data":` + quote(long) + `}`},
		{name: "a marker", in: `{"type":"image","media_type":"image/png","data":"[image image/png 6 KB not stored]"}`},
		{name: "a data URI that is not base64", in: `{"src":"data:text/plain,hello"}`},
		{name: "not JSON", in: `base64 "image" {`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, changed := StripBinary(json.RawMessage(c.in))
			if changed != c.changed {
				t.Fatalf("changed %v, want %v", changed, c.changed)
			}
			want := c.want
			if !c.changed {
				want = c.in
			}
			if string(got) != want {
				t.Fatalf("got  %.300s\nwant %.300s", got, want)
			}
			// A second pass changes nothing.
			if again, ch := StripBinary(got); ch || string(again) != string(got) {
				t.Fatalf("second pass changed it: %.300s", again)
			}
		})
	}
}

// The marker is the one CapToolField writes for the same content.
func TestStripBinaryMarkerMatchesCapToolField(t *testing.T) {
	img := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("q", 700_000)))
	in := `{"type":"base64","media_type":"image/webp","data":"` + img + `"}`
	got, _ := StripBinary(json.RawMessage(in))
	if capped := CapToolField(json.RawMessage(in)); string(got) != string(capped) {
		t.Fatalf("StripBinary %s, CapToolField %s", got, capped)
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
