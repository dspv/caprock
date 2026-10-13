package remote

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/remote/noise-vector.json")

// noiseVector pins one NK handshake and two transport messages each way. The
// TypeScript side (ui/src/remote/noise.test.ts) reads the same file and must
// produce the same bytes, so the two halves of the channel cannot drift apart
// without a test going red on both sides.
type noiseVector struct {
	Protocol        string   `json:"protocol"`
	Prologue        string   `json:"prologue"`
	ResponderStatic string   `json:"responder_static"`
	ResponderPublic string   `json:"responder_public"`
	InitiatorEph    string   `json:"initiator_ephemeral"`
	ResponderEph    string   `json:"responder_ephemeral"`
	Payload1        string   `json:"payload1"`
	Payload2        string   `json:"payload2"`
	Message1        string   `json:"message1"`
	Message2        string   `json:"message2"`
	InitiatorSends  []string `json:"initiator_sends"`
	InitiatorCipher []string `json:"initiator_ciphertexts"`
	ResponderSends  []string `json:"responder_sends"`
	ResponderCipher []string `json:"responder_ciphertexts"`
}

func fixedKey(t *testing.T, fill byte) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{fill}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestNoiseVector(t *testing.T) {
	static, ie, re := fixedKey(t, 0x11), fixedKey(t, 0x22), fixedKey(t, 0x33)
	p1, p2 := []byte(`{"v":1}`), []byte(`{"v":1,"version":"test","name":"mini"}`)
	init, m1, err := Initiate(static.PublicKey().Bytes(), p1, ie)
	if err != nil {
		t.Fatal(err)
	}
	m2, got1, rsess, err := Respond(static, m1, p2, re)
	if err != nil {
		t.Fatal(err)
	}
	got2, isess, err := init.Finish(m2)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got1, p1) || !bytes.Equal(got2, p2) {
		t.Fatal("payloads did not survive the handshake")
	}
	v := noiseVector{
		Protocol: protocolName, Prologue: prologue,
		ResponderStatic: hex.EncodeToString(static.Bytes()), ResponderPublic: hex.EncodeToString(static.PublicKey().Bytes()),
		InitiatorEph: hex.EncodeToString(ie.Bytes()), ResponderEph: hex.EncodeToString(re.Bytes()),
		Payload1: hex.EncodeToString(p1), Payload2: hex.EncodeToString(p2),
		Message1: hex.EncodeToString(m1), Message2: hex.EncodeToString(m2),
	}
	for _, s := range []string{"first from the phone", "second from the phone"} {
		ct, _ := isess.Encrypt([]byte(s))
		pt, err := rsess.Decrypt(ct)
		if err != nil || string(pt) != s {
			t.Fatalf("phone→daemon %q: %v", s, err)
		}
		v.InitiatorSends = append(v.InitiatorSends, hex.EncodeToString([]byte(s)))
		v.InitiatorCipher = append(v.InitiatorCipher, hex.EncodeToString(ct))
	}
	for _, s := range []string{"first from the daemon", "second from the daemon"} {
		ct, _ := rsess.Encrypt([]byte(s))
		pt, err := isess.Decrypt(ct)
		if err != nil || string(pt) != s {
			t.Fatalf("daemon→phone %q: %v", s, err)
		}
		v.ResponderSends = append(v.ResponderSends, hex.EncodeToString([]byte(s)))
		v.ResponderCipher = append(v.ResponderCipher, hex.EncodeToString(ct))
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	b = append(b, '\n')
	path := filepath.Join("..", "..", "testdata", "remote", "noise-vector.json")
	if *update {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update to write it)", err)
	}
	if !bytes.Equal(want, b) {
		t.Fatal("the handshake no longer produces the pinned bytes; if that is intended, rerun with -update and make the TypeScript side match")
	}
}
