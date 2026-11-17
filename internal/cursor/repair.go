package cursor

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/event"
	"github.com/dspv/caprock/internal/store"
)

// stored is one row an earlier pass stored of a chat, with what the repair
// compares.
type stored struct {
	id                int64
	key, kind         string
	ts                int64
	model, payModel   string
	source, useID     string
	ctxTokens         int64
	hasTokens         bool
	tin, tout         int64
	cost              sql.NullFloat64
	cwd               string
	reconciled, usage bool
	tool, payTool     string
	filePath          string
	mode, decision    string
}

// target is what a stored row should say today.
type target struct {
	model, source     string
	ctxUsed, ctxLimit int64
	useID             string
	// tool is the call's name (callName), filePath its tool_input's file
	// (ToolInput), mode its permission_mode and decision the person's
	// answer; "" where the row carries none.
	tool, filePath string
	mode, decision string
}

// repair brings what an earlier version of this reader stored of one chat up
// to this one, before the chat is read again whole (MetaCursorParityRepaired,
// and a chat whose repair failed). Stored rows are frozen by their keys, so
// reading a chat again adds only what is new — its tool results — and would
// never correct a row; this corrects them in place.
//
//   - A turn's model is the one Cursor billed (turnModel), not the one the
//     picker shows now; each prompt and reply row is re-labelled.
//   - A prompt gains Cursor's context reading, and a tool call the
//     `tool_use_id` its result pairs with.
//   - When any turn changes model, the chat's reconciled usage — Cursor's
//     totals, filed per model on a reply or on a row of their own (see
//     Ingester) — is taken back out, rows and rollups both, because it was
//     filed under the old models. The read that follows records it again
//     from Cursor's totals under the right ones, on rows of their own dated
//     the chat's last update, so the chat's total is unchanged and only its
//     split by model moves.
//
// Nothing is deleted but the usage-only rows, which carry no words. The
// usage comes out in one transaction and the labels follow in short ones;
// it is idempotent, so a repair cut short is simply run again, and a second
// run over a repaired chat finds nothing to change.
func (in *Ingester) repair(ctx context.Context, c Composer, bubbles []Bubble, sessionModel, cwd string) error {
	if in.rec == nil || in.rec.Store == nil {
		return nil
	}
	want := map[string]target{}
	turn, source := turnModel(c, "")
	for i, b := range bubbles {
		if b.User {
			turn, source = turnModel(c, b.Model)
		}
		switch {
		case b.User:
			want["cu-user:"+b.ID] = target{model: turn, source: source, ctxUsed: b.ContextUsed, ctxLimit: b.ContextLimit,
				mode: chatMode(c.Mode)}
			// The turn's end carries its model too (turnSpan.stop).
			want["cu-stop:"+c.ID+":"+b.ID] = target{model: turn}
			if i == 0 {
				want["cu-overhead:"+c.ID] = target{model: turn}
			}
		case b.Tool != nil:
			name := callName(b.Tool)
			fp, _ := ToolInput(b.Tool.Name, b.Tool.Args, cwd)["file_path"].(string)
			want["cu-tool:"+b.ID] = target{model: turn, useID: useID(b), tool: name, filePath: fp, mode: callMode(b.Tool)}
			want["cu-post:"+b.ID] = target{model: turn, tool: name, filePath: fp, decision: b.Tool.Decision}
		default:
			w := target{model: turn, source: source}
			if i == len(bubbles)-1 && (c.Status == "completed" || c.Status == "aborted") {
				w.ctxUsed, w.ctxLimit = c.ContextUsed, c.ContextLimit // as chat() puts it
			}
			want["cu-msg:"+b.ID] = w
		}
	}
	rows, project, err := in.storedRows(ctx, c.ID)
	if err != nil || len(rows) == 0 {
		return err
	}
	relabel := false
	for _, r := range rows {
		w, ok := want[r.key]
		if !ok {
			continue
		}
		if (r.kind == string(event.KindTurnUser) || r.kind == string(event.KindTurnAssistant)) &&
			(r.payModel != w.model || r.kind == string(event.KindTurnAssistant) && r.model != w.model) {
			relabel = true
		}
	}
	loc := in.rec.Location
	if loc == nil {
		loc = time.Local
	}
	// The usage comes out in one transaction, so no pass ever reconciles
	// against half of it. A write first, so the transaction takes the write
	// lock now rather than failing to upgrade a read once another writer has
	// committed.
	err = in.rec.Store.WithTx(ctx, func(q store.Querier) error {
		if sessionModel != "" {
			if _, err := q.ExecContext(ctx, `UPDATE sessions SET model = ? WHERE session_id = ?`, sessionModel, c.ID); err != nil {
				return err
			}
		}
		if !relabel {
			return nil
		}
		for _, r := range rows {
			if !r.reconciled {
				continue
			}
			if err := unrecord(ctx, q, c.ID, project, r, loc); err != nil {
				return err
			}
			if r.usage {
				if _, err := q.ExecContext(ctx, `DELETE FROM event_tldr WHERE event_id = ?`, r.id); err != nil {
					return err
				}
				if _, err := q.ExecContext(ctx, `DELETE FROM events WHERE id = ?`, r.id); err != nil {
					return err
				}
				continue
			}
			if _, err := q.ExecContext(ctx, `UPDATE events SET payload = json_remove(`+store.ZPayload+`, '$.requests', '$.cost_basis'),
				tokens_in = NULL, tokens_out = NULL, cost_usd = NULL WHERE id = ?`, r.id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	// The labels go in short transactions: a long chat is thousands of
	// rows, and the hook plane and the other readers write beside this.
	// Each change is complete on its own, and a repair cut short is run
	// again whole (redo).
	var todo []func(store.Querier) error
	for _, r := range rows {
		if relabel && r.usage {
			continue // deleted above
		}
		w, ok := want[r.key]
		if !ok {
			continue
		}
		todo = append(todo, func(q store.Querier) error {
			if err := fix(ctx, q, r, w); err != nil {
				return err
			}
			return movePath(ctx, q, c.ID, r, w)
		})
	}
	for len(todo) > 0 {
		n := min(len(todo), repairBatch)
		batch := todo[:n]
		todo = todo[n:]
		if err := in.rec.Store.WithTx(ctx, func(q store.Querier) error {
			for _, f := range batch {
				if err := f(q); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

// repairBatch is how many rows one of the repair's transactions corrects.
const repairBatch = 300

// fix writes what one row should say, where it says something else: the
// model column (every row of a turn, as the recorder files it), and in the
// payload the model and where it was read, the context reading, and a
// call's tool_use_id.
func fix(ctx context.Context, q store.Querier, r stored, w target) error {
	expr := store.ZPayload
	var args []any
	switch {
	case strings.HasPrefix(r.key, "cu-tool:"), strings.HasPrefix(r.key, "cu-post:"):
		if w.useID != "" && r.useID != w.useID {
			expr = `json_set(` + expr + `, '$.tool_use_id', ?)`
			args = append(args, w.useID)
		}
		if w.tool != "" && r.payTool != w.tool {
			expr = `json_set(` + expr + `, '$.tool_name', ?)`
			args = append(args, w.tool)
		}
		if w.filePath != "" && r.filePath != "" && r.filePath != w.filePath {
			expr = `json_set(` + expr + `, '$.tool_input.file_path', ?)`
			args = append(args, w.filePath)
		}
		if w.mode != "" && r.mode != w.mode {
			expr = `json_set(` + expr + `, '$.permission_mode', ?)`
			args = append(args, w.mode)
		}
		if w.decision != "" && r.decision != w.decision {
			expr = `json_set(` + expr + `, '$.user_decision', ?)`
			args = append(args, w.decision)
		}
	case strings.HasPrefix(r.key, "cu-overhead:"), strings.HasPrefix(r.key, "cu-stop:"):
		if r.payModel != w.model {
			expr = `json_set(` + expr + `, '$.model', ?)`
			args = append(args, w.model)
		}
	default:
		if r.payModel != w.model || r.source != w.source {
			expr = `json_set(` + expr + `, '$.model', ?, '$.model_source', ?)`
			args = append(args, w.model, w.source)
		}
		if w.mode != "" && r.mode != w.mode {
			expr = `json_set(` + expr + `, '$.permission_mode', ?)`
			args = append(args, w.mode)
		}
		if w.ctxUsed > 0 && r.ctxTokens != w.ctxUsed {
			expr = `json_set(` + expr + `, '$.context_tokens', ?)`
			args = append(args, w.ctxUsed)
			if w.ctxLimit > 0 {
				expr = `json_set(` + expr + `, '$.context_window', ?)`
				args = append(args, w.ctxLimit)
			}
		}
	}
	modelChanged := r.model != w.model
	toolChanged := w.tool != "" && r.tool != w.tool
	if !modelChanged && !toolChanged && len(args) == 0 {
		return nil
	}
	var model any
	if w.model != "" {
		model = w.model
	}
	tool := r.tool
	if toolChanged {
		tool = w.tool
	}
	var toolCol any
	if tool != "" {
		toolCol = tool
	}
	if len(args) == 0 {
		_, err := q.ExecContext(ctx, `UPDATE events SET model = ?, tool = ? WHERE id = ?`, model, toolCol, r.id)
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE events SET payload = `+expr+`, model = ?, tool = ? WHERE id = ?`, append(args, model, toolCol, r.id)...)
	return err
}

// unrecord takes a row's usage back out of the session's and the day's
// totals.
func unrecord(ctx context.Context, q store.Querier, chat, project string, r stored, loc *time.Location) error {
	return store.UnrecordTurnUsage(ctx, q, store.UnrecordedTurn{
		SessionID: chat, Project: project, Cwd: r.cwd,
		Day:   time.UnixMilli(r.ts).In(loc).Format("2006-01-02"),
		Model: r.model, TokensIn: r.tin, TokensOut: r.tout, CostUSD: r.cost.Float64,
		Turn: r.usage,
	})
}

// storedRows reads the rows this reader keyed for a chat (the hook plane's
// are left alone), and the session's project.
func (in *Ingester) storedRows(ctx context.Context, chat string) ([]stored, string, error) {
	db := in.rec.Store.DB()
	var project string
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(project,'') FROM sessions WHERE session_id = ?`, chat).Scan(&project); err != nil {
		if err == sql.ErrNoRows {
			return nil, "", nil
		}
		return nil, "", err
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id, key, kind, ts, COALESCE(model,''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.model'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.model_source'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.tool_use_id'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.context_tokens'),0),
		       tokens_in IS NOT NULL, COALESCE(tokens_in,0), COALESCE(tokens_out,0), cost_usd,
		       COALESCE(json_extract(`+store.ZPayload+`,'$.cwd'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.usage_only'),0),
		       COALESCE(tool,''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.tool_name'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.tool_input.file_path'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.permission_mode'),''),
		       COALESCE(json_extract(`+store.ZPayload+`,'$.user_decision'),'')
		  FROM events
		 WHERE sid = (SELECT sid FROM sessions WHERE session_id = ?) AND source = ?
		   AND key >= 'cu-' AND key < 'cu.' AND key NOT LIKE 'cu-hook-%'`, chat, string(event.SourceCursor))
	if err != nil {
		return nil, "", fmt.Errorf("read stored cursor rows: %w", err)
	}
	defer rows.Close()
	var out []stored
	for rows.Next() {
		var r stored
		var usage int
		if err := rows.Scan(&r.id, &r.key, &r.kind, &r.ts, &r.model, &r.payModel, &r.source, &r.useID, &r.ctxTokens,
			&r.hasTokens, &r.tin, &r.tout, &r.cost, &r.cwd, &usage, &r.tool, &r.payTool, &r.filePath, &r.mode, &r.decision); err != nil {
			return nil, "", err
		}
		r.usage = usage != 0 || strings.HasPrefix(r.key, "cu-usage:")
		r.reconciled = r.kind == string(event.KindTurnAssistant) && (r.usage || r.hasTokens || r.cost.Valid)
		out = append(out, r)
	}
	return out, project, rows.Err()
}

// movePath keeps the session's touched files (session_files, and the
// files_touched count beside it) in step with a call whose file or name
// the repair corrected: the path the earlier reader filed it under —
// "…/kgpu/kgpu/src" for "kgpu/src" read in …/kgpu — goes, the right one
// comes, as the recorder would have filed it (rollup.touchedPath).
func movePath(ctx context.Context, q store.Querier, chat string, r stored, w target) error {
	if !strings.HasPrefix(r.key, "cu-tool:") || w.filePath == "" {
		return nil
	}
	switch w.tool {
	case "Edit", "Write", "MultiEdit":
	default:
		return nil
	}
	moved := r.filePath != "" && r.filePath != w.filePath
	renamed := w.tool != r.tool
	if !moved && !renamed {
		return nil
	}
	delta := int64(0)
	if moved {
		res, err := q.ExecContext(ctx, `DELETE FROM session_files WHERE session_id = ? AND path = ?`, chat, r.filePath)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		delta -= n
	}
	isNew, err := store.TouchFile(ctx, q, chat, w.filePath, r.ts)
	if err != nil {
		return err
	}
	if isNew {
		delta++
	}
	if delta == 0 {
		return nil
	}
	_, err = q.ExecContext(ctx, `UPDATE session_stats SET files_touched = MAX(0, files_touched + ?) WHERE session_id = ?`, delta, chat)
	return err
}
