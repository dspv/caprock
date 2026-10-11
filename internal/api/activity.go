package api

import (
	"net/http"
	"time"

	"github.com/dspv/caprock/internal/store"
)

// ActivityResponse is GET /v1/activity: each session's turns and tool calls
// over the last hour in two-minute buckets, oldest first, for the sidebar's
// per-project sparkline. Sessions with nothing in the hour are absent.
type ActivityResponse struct {
	From     int64            `json:"from"`
	BucketMs int64            `json:"bucket_ms"`
	Buckets  int              `json:"buckets"`
	Sessions map[string][]int `json:"sessions"`
}

const (
	activityBucket  = 2 * time.Minute
	activityBuckets = 30
)

func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	bucket := activityBucket.Milliseconds()
	// Aligned to the bucket so a poll a minute later moves whole bars, not
	// a sliding edge that redraws every one.
	end := (time.Now().UnixMilli()/bucket + 1) * bucket
	from := end - bucket*activityBuckets
	got, err := store.ActivityBuckets(r.Context(), s.d.Store.DB(), from, bucket, activityBuckets)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ActivityResponse{From: from, BucketMs: bucket, Buckets: activityBuckets, Sessions: got})
}
