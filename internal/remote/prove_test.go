package remote_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/dspv/caprock/internal/remote"
)

func echoPeer(t *testing.T, c *remote.Client, hdr map[string]string) string {
	t.Helper()
	_, _, body := get(t, c, "GET", "/v1/echo", hdr, "")
	var got map[string]string
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	return got["peer"]
}

// A computer given its own key proves it on every channel, and the target
// marks each request it replays with that key, which nothing else can write.
func TestAComputerProvesItsKeyOnTheChannel(t *testing.T) {
	r := newRig(t)
	_, id, _ := ed25519.GenerateKey(rand.Reader)
	c, err := remote.NewClient(remote.ClientOptions{Target: r.target(), Identity: id})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	want := remote.HostID(id.Public().(ed25519.PublicKey))
	if got := echoPeer(t, c, nil); got != want {
		t.Fatalf("peer = %q, want the client's key %q", got, want)
	}
	// A header the caller sets is not carried (requestHeaders) and would not
	// verify if it were.
	if got := echoPeer(t, c, map[string]string{remote.PeerHeader: "forged.mac"}); got != want {
		t.Fatalf("a caller's header changed the peer to %q", got)
	}
	// A WebSocket is marked too.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, err := c.OpenWS(ctx, "/v1/peer-ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	_, msg, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(msg) != "peer="+want {
		t.Fatalf("socket said %q, want peer=%s", msg, want)
	}
}

// Without a key — a phone, or a computer from before — nothing is marked.
func TestAChannelWithoutAProofCarriesNoKey(t *testing.T) {
	c := newRig(t).client(t, 0)
	if got := echoPeer(t, c, nil); got != "" {
		t.Fatalf("peer = %q with no proof sent", got)
	}
}

// A header made outside this process's Host does not verify.
func TestAPeerHeaderNotWrittenHereIsIgnored(t *testing.T) {
	req := httptest.NewRequest("GET", "/v1/x", nil)
	for _, v := range []string{"", "abc", "abc.", ".mac", "abc.def"} {
		req.Header.Set(remote.PeerHeader, v)
		if k := remote.PeerKey(req); k != "" {
			t.Fatalf("%q read as key %q", v, k)
		}
	}
}
