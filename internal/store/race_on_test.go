//go:build race

package store

// raceOn: the race detector slows SQLite-heavy code five to ten times, so a
// test that times a query against a budget means nothing under it.
const raceOn = true
