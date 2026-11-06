package store

import (
	"context"
	"database/sql"
	"errors"
	"math/rand/v2"
	"time"
)

// CompressAge is how old a tool row must be before it is compressed: a live
// session's newest calls stay plain, and the job never competes with the
// write path for them.
const CompressAge = 24 * time.Hour

// compressSample is how many plain tool payloads the storage measurement
// compresses in memory to estimate the saving: a few megabytes, tens of
// milliseconds.
const compressSample = 2000

func isToolKind(kind []byte) bool {
	return string(kind) == "tool.pre" || string(kind) == "tool.post"
}

// sampleCompression compresses up to compressSample plain tool payloads older
// than cutoffMs, picked by random id, and fills the sample figures and the
// estimate in zc. Nothing is written.
func sampleCompression(ctx context.Context, db *sql.DB, cutoffMs int64, zc *ToolCompression) error {
	var lo, hi sql.NullInt64
	// Two subqueries: each is one step down the rowid b-tree, where
	// MIN and MAX in one SELECT read every row.
	if err := db.QueryRowContext(ctx, `SELECT (SELECT MIN(id) FROM events), (SELECT MAX(id) FROM events)`).Scan(&lo, &hi); err != nil {
		return err
	}
	if !lo.Valid || hi.Int64 <= lo.Int64 {
		return nil
	}
	// A fixed seed: the same database gives the same estimate, so the figure
	// does not wander between two measurements of an unchanged file.
	r := rand.New(rand.NewPCG(1, 2))
	tries := 0
	seen := map[int64]bool{}
	for zc.SampleRows < compressSample && tries < compressSample*20 && ctx.Err() == nil {
		tries++
		id := lo.Int64 + r.Int64N(hi.Int64-lo.Int64+1)
		if seen[id] {
			continue
		}
		seen[id] = true
		var p []byte
		err := db.QueryRowContext(ctx, `
			SELECT payload FROM events
			 WHERE id = ? AND kind IN ('tool.pre', 'tool.post') AND typeof(payload) = 'text' AND ts < ?`,
			id, cutoffMs).Scan(&p)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		zc.SampleRows++
		zc.SamplePlain += int64(len(p))
		if z, ok := CompressPayload(p); ok {
			zc.SampleStored += int64(len(z))
		} else {
			zc.SampleStored += int64(len(p))
		}
	}
	if zc.SamplePlain > 0 {
		zc.EstSavingBytes = int64(float64(zc.EligibleBytes) * (1 - float64(zc.SampleStored)/float64(zc.SamplePlain)))
	}
	return ctx.Err()
}
