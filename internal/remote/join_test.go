package remote_test

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/dspv/caprock/internal/remote"
)

func TestAJoinKeyRoundTrips(t *testing.T) {
	for _, relay := range []string{remote.DefaultRelay, "wss://relay.example.org", "ws://127.0.0.1:8787"} {
		_, jk, err := remote.MakeJoinKey(relay)
		if err != nil {
			t.Fatal(err)
		}
		s := jk.String()
		if !strings.HasPrefix(s, remote.JoinKeyPrefix) {
			t.Fatalf("%q has no prefix", s)
		}
		if relay == remote.DefaultRelay && len(s) != 112 {
			t.Fatalf("a hosted relay's key is %d characters, want 112: %s", len(s), s)
		}
		// As pasted: alone, as the whole command, quoted, wrapped by a terminal.
		for _, in := range []string{s, "caprock join " + s, "'" + s + "'", "  " + s[:50] + "\n" + s[50:] + "\n"} {
			got, err := remote.ParseJoinKey(in)
			if err != nil {
				t.Fatalf("%q: %v", in, err)
			}
			if got.Relay != relay || got.HostID != jk.HostID || got.Key != jk.Key || !bytes.Equal(got.Secret, jk.Secret) {
				t.Fatalf("%q read as %+v, want %+v", in, got, jk)
			}
		}
	}
}

func TestNotAJoinKey(t *testing.T) {
	_, jk, _ := remote.MakeJoinKey(remote.DefaultRelay)
	s := jk.String()
	for _, in := range []string{"", "hello", "https://m.caprock.dev/#/pair?r=wss://x&h=y&k=z&c=123456", remote.JoinKeyPrefix + "AAAA", s[:60]} {
		if _, err := remote.ParseJoinKey(in); !errors.Is(err, remote.ErrNotJoinKey) {
			t.Fatalf("%q: err = %v, want ErrNotJoinKey", in, err)
		}
	}
	// A relay in the clear off this machine is refused, as in a pairing link.
	if _, _, err := remote.MakeJoinKey("ws://relay.example.org"); err == nil {
		t.Fatal("made a key for a ws:// relay off this machine")
	}
}
