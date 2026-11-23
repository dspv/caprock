package agents

import "github.com/dspv/caprock/internal/codex"

// refusalTail is how much of the previous output is kept so a refusal split
// across two reads is still seen.
const refusalTail = 1 << 10

// refusalScanFor is how much of a session's output is looked at: the
// refusal comes on the first turn, so a long session is not scanned forever.
const refusalScanFor = 4 << 20

// refusalWatch is one Codex session's watch for "The '<model>' model is not
// supported when using Codex with a ChatGPT account" (model_not_found):
// Codex keeps no error in its transcript, so its screen is the only place it
// shows. Seen once, the model is remembered (codex.NoteRefused) and the New
// agent dialog lists it last, marked, never as the default.
type refusalWatch struct {
	tail    []byte
	scanned int
	done    bool
}

// watchRefusal looks at one chunk of a Codex session's output. Only pump
// calls it, so its state needs no lock.
func (a *Agent) watchRefusal(chunk []byte) {
	w := &a.refusal
	if a.Kind != "codex" || w.done {
		return
	}
	w.scanned += len(chunk)
	if w.scanned > refusalScanFor {
		w.done, w.tail = true, nil
		return
	}
	buf := make([]byte, 0, len(w.tail)+len(chunk))
	buf = append(append(buf, w.tail...), chunk...)
	fallback := ""
	if a.retry != nil {
		fallback = a.retry.Model
	}
	if m := codex.RefusedModel(buf, fallback); m != "" {
		codex.NoteRefused(m)
		w.done, w.tail = true, nil
		return
	}
	if len(buf) > refusalTail {
		buf = buf[len(buf)-refusalTail:]
	}
	w.tail = buf
}
