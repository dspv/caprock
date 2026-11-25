package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// ErrNotPrompt is PromptText's answer for an id that is no prompt.
var ErrNotPrompt = errors.New("not a prompt")

// PromptText is the words of one prompt (a `turn.user` event) as the chat
// shows them: its `prompt`, or `text` where a harness keeps it there.
// ErrNotPrompt when the id is missing or of another kind.
func PromptText(ctx context.Context, q Querier, id int64) (string, error) {
	var payload []byte
	err := q.QueryRowContext(ctx, `SELECT `+ZPayload+` FROM events WHERE id = ? AND kind = 'turn.user'`, id).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotPrompt
	}
	if err != nil {
		return "", err
	}
	var p struct {
		Prompt *string `json:"prompt"`
		Text   string  `json:"text"`
	}
	// A payload that is not this shape names no file: no words.
	_ = json.Unmarshal(payload, &p)
	if p.Prompt != nil {
		return *p.Prompt, nil
	}
	return p.Text, nil
}
