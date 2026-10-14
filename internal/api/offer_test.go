package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
)

// stubSite stands in for caprock.dev and records every body it receives.
// Tests never reach the real site: CAPROCK_OFFER_URL points here.
func stubSite(t *testing.T, status int) func() []map[string]any {
	t.Helper()
	var got []map[string]any
	var mu sync.Mutex
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		got = append(got, m)
		mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(site.Close)
	t.Setenv("CAPROCK_OFFER_URL", site.URL)
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), got...)
	}
}

func (e *env) offer(t *testing.T, body string) int {
	t.Helper()
	r, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/v1/offer", bytes.NewReader([]byte(body)))
	r.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// What reaches the site is exactly the offer, its answers and the email when
// given — a field the dashboard adds is not forwarded, not even a version.
func TestOfferForwardsExactlyTheAnswers(t *testing.T) {
	e := newEnv(t)
	got := stubSite(t, http.StatusOK)

	if code := e.offer(t, `{"offer":"youtube","answers":{"q1":"8-12","q2":"over-70"},"email":" a@b.co ","machine":"x","sessions":12,"version":"9"}`); code != http.StatusOK {
		t.Fatalf("offer: %d", code)
	}
	if code := e.offer(t, `{"offer":"local-models","answers":{"q1":"coding","q2":"mac-24-64"}}`); code != http.StatusOK {
		t.Fatalf("offer without email: %d", code)
	}
	bodies := got()
	if len(bodies) != 2 {
		t.Fatalf("site got %d bodies, want 2", len(bodies))
	}
	want := []map[string]any{
		{"offer": "youtube", "answers": map[string]any{"q1": "8-12", "q2": "over-70"}, "email": "a@b.co"},
		{"offer": "local-models", "answers": map[string]any{"q1": "coding", "q2": "mac-24-64"}},
	}
	for i := range want {
		if !reflect.DeepEqual(bodies[i], want[i]) {
			t.Errorf("site got %v, want exactly %v", bodies[i], want[i])
		}
	}
}

// Anything outside an offer's questions and answers, or a malformed email,
// is refused here and never reaches the site.
func TestOfferRefusesWhatIsNotAnAnswer(t *testing.T) {
	e := newEnv(t)
	got := stubSite(t, http.StatusOK)
	for _, body := range []string{
		``,
		`{}`,
		`{"offer":"other","answers":{"q1":"yes","q2":"no"}}`,
		`{"offer":"ads","answers":{"q1":"1-4","q2":"under-30"}}`,
		`{"offer":"ads","answers":{"q1":"under-4"}}`,
		`{"offer":"ads","answers":{"q1":"under-4","q2":"under-30","q3":"x"}}`,
		`{"offer":"ads","answers":{"q1":"yes","q2":"no"}}`,
		`{"offer":"second-brain","answers":{"q1":"yes","q2":"no"}}`,
		`{"offer":"local-models","answers":{"q1":"coding","q2":"mac-128"}}`,
		`{"offer":"ads","answers":{"q1":"under-4","q2":"under-30"},"email":"not an address"}`,
		`{"offer":"ads","answers":{"q1":"under-4","q2":"under-30"},"email":"Name <a@b.co>"}`,
		`{"offer":"ads","answers":{"q1":"under-4","q2":"under-30"},"email":"a@localhost"}`,
	} {
		if code := e.offer(t, body); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", body, code)
		}
	}
	if n := len(got()); n != 0 {
		t.Fatalf("site got %d bodies, want none", n)
	}
}

// A site that refuses is reported as a failure, so the card can say so and
// keep the answers for another try.
func TestOfferReportsARefusal(t *testing.T) {
	e := newEnv(t)
	stubSite(t, http.StatusTooManyRequests)
	if code := e.offer(t, `{"offer":"ads","answers":{"q1":"under-4","q2":"under-30"}}`); code != http.StatusBadGateway {
		t.Fatalf("offer: %d, want 502", code)
	}
}
