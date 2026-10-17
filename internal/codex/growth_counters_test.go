package codex

import "testing"

// benchCounters is the importer's work before the timed passes.
func benchCounters(in *Ingester) Work { return in.Work() }

// reportCounters reports the work per timed pass: bytes read, records decoded,
// records offered to the store and how many of those it already held.
func reportCounters(b *testing.B, in *Ingester, start Work) {
	w := in.Work()
	n := float64(b.N)
	b.ReportMetric(float64(w.BytesRead-start.BytesRead)/n, "read-B/op")
	b.ReportMetric(float64(w.Records-start.Records)/n, "decoded/op")
	b.ReportMetric(float64(w.Offered-start.Offered)/n, "offered/op")
	b.ReportMetric(float64((w.Offered-w.Stored)-(start.Offered-start.Stored))/n, "dup/op")
}
