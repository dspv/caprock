package event

import "testing"

// The one arithmetic rule in this package, held by a test because the next
// person to read TokenDelta will see five fields and a sum over four of them.
//
// CacheWrite1h is a *subset* of CacheWrite — the part of the same write billed
// at the 1h-TTL rate — so adding it to the total counts those tokens twice.
// The mistake is attractive: it looks like a field was forgotten. It is not,
// and the cost of getting it wrong is a token figure that is quietly too big
// on every screen that shows one, which is most of them.
func TestTotalDoesNotCountTheOneHourWriteTwice(t *testing.T) {
	// A turn whose entire cache write happens to be at the 1h rate: the
	// strongest version of the case, because a naive sum is off by the whole
	// write rather than by a sliver of it.
	d := TokenDelta{In: 100, Out: 20, CacheRead: 5, CacheWrite: 40, CacheWrite1h: 40}

	if got, want := d.Total(), int64(165); got != want {
		t.Fatalf("Total() = %d, want %d — CacheWrite1h is part of CacheWrite, not extra", got, want)
	}
}

func TestTotal(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   TokenDelta
		want int64
	}{
		{"zero", TokenDelta{}, 0},
		{"input only", TokenDelta{In: 7}, 7},
		{"every field", TokenDelta{In: 1, Out: 2, CacheRead: 4, CacheWrite: 8}, 15},
		{
			// Cache reads dwarf fresh input on a real session — a 99% hit rate
			// is normal here — so the total must be a wide type all the way
			// through. At int32 this case overflows to a negative number.
			name: "a cache-heavy session does not overflow",
			in:   TokenDelta{In: 38_940_000, Out: 27_550_000, CacheRead: 23_950_000_000, CacheWrite: 247_050_000},
			want: 24_263_540_000,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.in.Total(); got != tc.want {
				t.Fatalf("Total() = %d, want %d", got, tc.want)
			}
		})
	}
}

// Kinds and sources are written into SQLite as their string values and read
// back by name in queries, migrations and the UI. Renaming one is a silent
// data migration: old rows keep the old string, new rows get the new one, and
// every count over that kind quietly halves. This pins the wire values.
func TestTheStoredStringsAreTheOnesOnDisk(t *testing.T) {
	for _, tc := range []struct{ got, want string }{
		{string(KindTurnUser), "turn.user"},
		{string(KindTurnAssistant), "turn.assistant"},
		{string(KindToolPre), "tool.pre"},
		{string(KindToolPost), "tool.post"},
		{string(KindSessionEnd), "session.end"},
		{string(KindAgentSpawn), "agent.spawn"},
		{string(KindAgentStop), "agent.stop"},
		{string(KindContextCompact), "context.compact"},
		{string(KindThrottle), "throttle"},
		{string(KindCostTick), "cost.tick"},
		{string(SourceHook), "hook"},
		{string(SourceTranscript), "transcript"},
		{string(SourceOpenCode), "opencode"},
		{string(SourceGemini), "gemini"},
	} {
		if tc.got != tc.want {
			t.Errorf("stored value is %q, want %q — existing rows carry the old string", tc.got, tc.want)
		}
	}
}
