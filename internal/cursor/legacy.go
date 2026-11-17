package cursor

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Legacy chats: Cursor's builds of spring 2025 kept a chat's messages inline
// in its composerData row (`conversation`, the same message shape as a
// bubbleId row) and its tool calls in the composer's `capabilities` (type 15,
// `bubbleDataMap`: a JSON string of toolFormerData by message id), with no
// fullConversationHeadersOnly and no bubbleId rows. On the owner's machine
// (2026-11-17) 9 chats from April to June 2025, 4,471 messages, 1,370 tool
// calls linked to a message. The functions below read either format; the
// ingester calls them and never needs to know which it has.

// ChatIDs is a chat's messages in order, in either format.
func ChatIDs(ctx context.Context, db *sql.DB, c Composer) ([]string, error) {
	if !c.Legacy {
		return HeaderIDs(ctx, db, c.ID)
	}
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(json_extract(j.value,'$.bubbleId'),'')
		FROM cursorDiskKV, json_each(cursorDiskKV.value,'$.conversation') j
		WHERE cursorDiskKV.key = ? AND json_valid(cursorDiskKV.value)
		ORDER BY j.key`, "composerData:"+c.ID)
	if err != nil {
		return nil, fmt.Errorf("cursor: read legacy chat order: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id != "" {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// ChatTokens is TokensByTurn for either format.
func ChatTokens(ctx context.Context, db *sql.DB, c Composer, ids []string) ([]TurnTokens, error) {
	if !c.Legacy {
		return TokensByTurn(ctx, db, c.ID, ids)
	}
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(json_extract(j.value,'$.bubbleId'),''), COALESCE(json_extract(j.value,'$.type'),0),
		       COALESCE(json_extract(j.value,'$.modelInfo.modelName'),''),
		       MAX(0, COALESCE(json_extract(j.value,'$.tokenCount.inputTokens'),0)),
		       MAX(0, COALESCE(json_extract(j.value,'$.tokenCount.outputTokens'),0))
		FROM cursorDiskKV, json_each(cursorDiskKV.value,'$.conversation') j
		WHERE cursorDiskKV.key = ? AND json_valid(cursorDiskKV.value)`, "composerData:"+c.ID)
	if err != nil {
		return nil, fmt.Errorf("cursor: read legacy token figures: %w", err)
	}
	defer rows.Close()
	byID := map[string]TurnTokens{}
	for rows.Next() {
		var id, model string
		var typ int
		var tin, tout int64
		if err := rows.Scan(&id, &typ, &model, &tin, &tout); err != nil {
			return nil, err
		}
		byID[id] = TurnTokens{User: typ == 1, Model: model, In: tin, Out: tout}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]TurnTokens, 0, len(ids))
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			out = append(out, t)
		}
	}
	return out, nil
}

// ChatBubbles is Bubbles for either format. A legacy chat's messages carry
// no createdAt, so each is dated by its request's timingInfo, else by the
// next dated message (a prompt is sent just before its reply starts), else
// the previous one, else the chat's creation (datedLegacy).
func ChatBubbles(ctx context.Context, db *sql.DB, c Composer, ids []string) ([]Bubble, error) {
	if !c.Legacy {
		return Bubbles(ctx, db, c.ID, ids)
	}
	key := "composerData:" + c.ID
	tools, err := legacyTools(ctx, db, key)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `
		SELECT j.value FROM cursorDiskKV, json_each(cursorDiskKV.value,'$.conversation') j
		WHERE cursorDiskKV.key = ? AND json_valid(cursorDiskKV.value)
		ORDER BY j.key`, key)
	if err != nil {
		return nil, fmt.Errorf("cursor: read legacy messages: %w", err)
	}
	var all []Bubble
	for rows.Next() {
		var val []byte
		if err := rows.Scan(&val); err != nil {
			_ = rows.Close()
			return nil, err
		}
		var head struct {
			ID string `json:"bubbleId"`
		}
		if json.Unmarshal(val, &head) != nil || head.ID == "" {
			continue
		}
		b, ok := parseBubble(head.ID, val)
		if !ok {
			continue
		}
		if t := tools[head.ID]; t != nil && b.Tool == nil {
			b.setTool(t)
		}
		all = append(all, b)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	datedLegacy(all, c.Created)
	byID := make(map[string]Bubble, len(all))
	for _, b := range all {
		byID[b.ID] = b
	}
	out := make([]Bubble, 0, len(ids))
	for _, id := range ids {
		if b, ok := byID[id]; ok {
			out = append(out, b)
		}
	}
	return out, nil
}

// legacyTools reads a legacy chat's tool calls by message id.
func legacyTools(ctx context.Context, db *sql.DB, key string) (map[string]*rawTool, error) {
	tools := map[string]*rawTool{}
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(json_extract(j.value,'$.data.bubbleDataMap'),'')
		FROM cursorDiskKV, json_each(cursorDiskKV.value,'$.capabilities') j
		WHERE cursorDiskKV.key = ? AND json_valid(cursorDiskKV.value) AND json_extract(j.value,'$.type') = 15`, key)
	if err != nil {
		return nil, fmt.Errorf("cursor: read legacy tool calls: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var m map[string]*rawTool
		if raw == "" || json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		for k, v := range m {
			if v != nil {
				tools[k] = v
			}
		}
	}
	return tools, rows.Err()
}

// datedLegacy gives every message of a legacy chat a time. The whole
// conversation is dated at once, so a message gets the same time on every
// pass however much of the chat that pass reads.
func datedLegacy(all []Bubble, created time.Time) {
	for i := range all {
		if all[i].At.IsZero() && all[i].SentAt > 0 {
			all[i].At = time.UnixMilli(all[i].SentAt)
		}
	}
	next := time.Time{}
	for i := len(all) - 1; i >= 0; i-- {
		if !all[i].At.IsZero() {
			next = all[i].At
		} else if !next.IsZero() {
			all[i].At = next
		}
	}
	prev := created
	for i := range all {
		if all[i].At.IsZero() {
			all[i].At = prev
		}
		prev = all[i].At
	}
}
