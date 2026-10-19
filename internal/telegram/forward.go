package telegram

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Forwarding into a session (ADR-081). The owner forwards one or several
// messages to the bot — text, a photo, a link, a file, a voice note — and
// the bot asks once where they go: a session Caprock started, a new chat,
// or nowhere. On a tap they go to the agent as one message, through the
// message queue: typed in now when the session is at its prompt, held until
// its turn ends when it is working.
//
// **One burst, one question.** Telegram sends a multi-forward, and an
// album, as one update per message. They are gathered until the chat has
// been quiet for BurstWait, so three forwards are one picker, not three.
//
// **The owner's words go first.** A comment typed with a forward arrives as
// a plain message just before it; words typed while the burst gathers or
// after the picker is up (until it is answered) are put at the top.
//
// **Rule 7.** Only sessions Caprock started and that are running are
// offered; the host's Forward refuses the rest again.
//
// **Replies stay in Caprock unless asked.** The picker's *Reply here*
// switch, off by default and remembered, sends that turn's answer back.

const (
	// DefaultBurstWait is how long the chat must be quiet before a burst of
	// forwards is asked about.
	DefaultBurstWait = 2 * time.Second
	// pickerMax bounds the sessions offered.
	pickerMax = 6
	// recentFor is how long a quiet session stays on the picker, as the
	// phone's Continue list keeps one.
	recentFor = 48 * time.Hour
	// forwardFileMax is the largest file fetched, as a pasted file is.
	forwardFileMax = 10 << 20
	// forwardTextMax keeps the message under the queue's 16 KiB.
	forwardTextMax = 16<<10 - 512
	// replyOnceFor is how long a forward's turn may take and still have
	// its answer sent back.
	replyOnceFor = 6 * time.Hour
)

// fwdItem is one forwarded message.
type fwdItem struct {
	// origin is the quote's first line: "Forwarded from Alice".
	origin string
	text   string
	// kind is "", "photo", "file", "voice", "audio" or "video"; file what
	// fetches it.
	kind string
	file FileRef
}

// burst is the forwards being gathered.
type burst struct {
	items []fwdItem
	words []string
	// last is the newest message, which a Premium note answers; gen tells a
	// timer that fired late from the one now armed.
	last  *Message
	gen   int
	timer *time.Timer
}

// picker is a posted "Where to?" and what it carries.
type picker struct {
	items    []fwdItem
	words    []string
	sessions []string
	labels   []string
	reply    bool
	at       time.Time
}

// queuedFwd is a forward the queue holds, so its picker can say when it
// went in.
type queuedFwd struct {
	chat    string
	msgID   int64
	session string
	title   string
	reply   bool
}

// forwarded reports a message that is gathered for a forward: a forward of
// anything, or a photo, file, voice note, audio or video sent here.
func forwarded(m *Message) bool {
	return m.ForwardOrigin != nil || len(m.Photo) > 0 || m.Document != nil || m.Voice != nil || m.Audio != nil || m.Video != nil
}

// itemOf reads one message as a forwarded item.
func itemOf(m *Message) fwdItem {
	it := fwdItem{text: strings.TrimSpace(m.Text)}
	if it.text == "" {
		it.text = strings.TrimSpace(m.Caption)
	}
	switch {
	case m.ForwardOrigin != nil && m.ForwardOrigin.Name() != "":
		it.origin = "Forwarded from " + m.ForwardOrigin.Name()
	case m.ForwardOrigin != nil:
		it.origin = "Forwarded message"
	default:
		it.origin = "Sent in Telegram"
	}
	switch {
	case len(m.Photo) > 0:
		big := m.Photo[len(m.Photo)-1]
		it.kind, it.file = "photo", FileRef{FileID: big.FileID, FileName: "photo.jpg", MimeType: "image/jpeg", FileSize: big.FileSize}
	case m.Voice != nil:
		it.kind, it.file = "voice", *m.Voice
		if it.file.FileName == "" {
			it.file.FileName = "voice.ogg"
		}
	case m.Audio != nil:
		it.kind, it.file = "audio", *m.Audio
	case m.Video != nil:
		it.kind, it.file = "video", *m.Video
	case m.Document != nil:
		it.kind, it.file = "file", *m.Document
	}
	return it
}

func (b *Bridge) burstWait() time.Duration {
	if b.BurstWait > 0 {
		return b.BurstWait
	}
	return DefaultBurstWait
}

// collect adds a forwarded message to the burst.
func (b *Bridge) collect(m *Message) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.burst == nil {
		b.burst = &burst{}
	}
	b.burst.items = append(b.burst.items, itemOf(m))
	b.burst.last = m
	b.armLocked()
}

// armLocked (re)starts the quiet timer. Caller holds b.mu.
func (b *Bridge) armLocked() {
	bu := b.burst
	if bu.timer != nil {
		bu.timer.Stop()
	}
	bu.gen++
	gen := bu.gen
	bu.timer = time.AfterFunc(b.burstWait(), func() { b.flush(bu, gen) })
}

// words takes a plain message as the owner's own words for a forward: one
// gathering, or the newest picker still open. With neither, it starts a
// burst of its own, since a comment typed with a forward arrives first; a
// burst that ends with no forward in it is answered as a plain message.
func (b *Bridge) words(ctx context.Context, m *Message, text string) bool {
	if text == "" {
		return false
	}
	b.mu.Lock()
	if b.burst != nil {
		b.burst.words = append(b.burst.words, text)
		b.burst.last = m
		b.armLocked()
		b.mu.Unlock()
		return true
	}
	if p := b.pickers[b.lastPicker]; p != nil && b.now().Sub(p.at) < confirmFor {
		p.words = append(p.words, text)
		id := b.lastPicker
		b.mu.Unlock()
		token, chat := b.Host.Bot()
		c := b.client(token)
		_ = c.EditText(ctx, chat, id, b.pickerText(p), "HTML", pickerMarkup(p))
		_ = c.React(ctx, chat, m.MessageID, "✍")
		return true
	}
	b.burst = &burst{words: []string{text}, last: m}
	b.armLocked()
	b.mu.Unlock()
	return true
}

// flush posts the picker for a burst once the chat is quiet.
func (b *Bridge) flush(bu *burst, gen int) {
	b.mu.Lock()
	if b.burst != bu || bu.gen != gen {
		b.mu.Unlock()
		return
	}
	b.burst = nil
	b.mu.Unlock()
	if len(bu.items) == 0 {
		// Only words, and no forward came: a plain message after all.
		b.hint(bu.last)
		return
	}
	if !b.gate(bu.last) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	list, err := b.Host.Sessions(ctx)
	if err != nil {
		b.Out.Queue(Out{Text: "Could not read the sessions: " + err.Error()})
		return
	}
	p := &picker{items: bu.items, words: bu.words, reply: b.Store.Get().ForwardReply, at: b.now()}
	p.sessions, p.labels = pickSessions(list, b.now())
	b.Out.Queue(Out{Text: b.pickerText(p), ParseMode: "HTML", Markup: pickerMarkup(p), Sent: func(msg Message, err error) {
		if err != nil {
			return
		}
		b.mu.Lock()
		for id, old := range b.pickers {
			if b.now().Sub(old.at) > confirmFor {
				delete(b.pickers, id)
			}
		}
		b.pickers[msg.MessageID] = p
		b.lastPicker = msg.MessageID
		b.mu.Unlock()
	}})
}

// pickSessions chooses the sessions a forward is offered to, as the phone's
// Continue list does: waiting for you, then working, then the rest of what
// runs, newest first in each, quiet ones for two days only, at most
// pickerMax. Only sessions Caprock started and that run (rule 7), and not
// chats, which have their own list.
func pickSessions(list []Live, now time.Time) (ids, labels []string) {
	rank := func(l Live) int {
		switch {
		case l.Waiting:
			return 0
		case l.Working:
			return 1
		}
		return 2
	}
	var keep []Live
	for _, l := range list {
		if !l.Owned || !l.Alive || l.Chat {
			continue
		}
		if rank(l) == 2 && !l.LastAt.IsZero() && now.Sub(l.LastAt) > recentFor {
			continue
		}
		keep = append(keep, l)
	}
	sort.SliceStable(keep, func(i, j int) bool {
		if ri, rj := rank(keep[i]), rank(keep[j]); ri != rj {
			return ri < rj
		}
		return keep[i].LastAt.After(keep[j].LastAt)
	})
	if len(keep) > pickerMax {
		keep = keep[:pickerMax]
	}
	for _, l := range keep {
		state := ago(now.Sub(l.LastAt))
		switch rank(l) {
		case 0:
			state = "waiting"
		case 1:
			state = "working"
		}
		name := l.Title
		if name == "" {
			name = "session"
		}
		ids = append(ids, l.ID)
		labels = append(labels, "● "+clipRunes(name, 34)+" · "+state)
	}
	return ids, labels
}

// ago is a quiet time as a button says it.
func ago(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return strconv.Itoa(int(d/time.Minute)) + "m ago"
	case d < 24*time.Hour:
		return strconv.Itoa(int(d/time.Hour)) + "h ago"
	}
	return strconv.Itoa(int(d/(24*time.Hour))) + "d ago"
}

// summary counts a burst: "3 messages, 1 photo".
func summary(items []fwdItem) string {
	counts := map[string]int{}
	for _, it := range items {
		counts[it.kind]++
	}
	var parts []string
	for _, k := range []struct{ kind, one, many string }{
		{"", "message", "messages"}, {"photo", "photo", "photos"}, {"file", "file", "files"},
		{"voice", "voice message", "voice messages"}, {"audio", "audio", "audio files"}, {"video", "video", "videos"},
	} {
		switch n := counts[k.kind]; {
		case n == 1:
			parts = append(parts, "1 "+k.one)
		case n > 1:
			parts = append(parts, strconv.Itoa(n)+" "+k.many)
		}
	}
	return strings.Join(parts, ", ")
}

func (b *Bridge) pickerText(p *picker) string {
	var s strings.Builder
	s.WriteString("<b>Where to?</b> (" + Escape(summary(p.items)) + ")\n")
	if len(p.sessions) == 0 {
		s.WriteString("No session Caprock started is running. Start a new chat with it, or continue a session in Caprock first.\n")
	}
	if len(p.words) > 0 {
		s.WriteString("Your words go first: <i>" + Escape(clipRunes(strings.Join(p.words, " "), 200)) + "</i>")
	} else {
		s.WriteString("<i>Type a few words before you tap and they go first.</i>")
	}
	return s.String()
}

func pickerMarkup(p *picker) *Markup {
	var rows [][]InlineButton
	for i, l := range p.labels {
		rows = append(rows, []InlineButton{{Text: l, CallbackData: "f:" + strconv.Itoa(i+1)}})
	}
	rows = append(rows, []InlineButton{{Text: "+ New chat", CallbackData: "f:n"}, {Text: "Cancel", CallbackData: "f:x"}})
	reply := "Reply here: off"
	if p.reply {
		reply = "Reply here: on"
	}
	return &Markup{InlineKeyboard: append(rows, []InlineButton{{Text: reply, CallbackData: "f:r"}})}
}

// pickerAt finds a posted picker, waiting a moment for one whose send has
// not been answered yet (as lookup does).
func (b *Bridge) pickerAt(ctx context.Context, msgID int64) *picker {
	for i := 0; ; i++ {
		b.mu.Lock()
		p := b.pickers[msgID]
		b.mu.Unlock()
		if p != nil || i == 20 {
			return p
		}
		if !sleep(ctx, 50*time.Millisecond) {
			return nil
		}
	}
}

// take claims a picker for one answer; nil when another tap had it first.
func (b *Bridge) take(msgID int64) *picker {
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.pickers[msgID]
	delete(b.pickers, msgID)
	return p
}

// forwardPress answers a button under a picker: a session's number, n (a
// new chat; nb and nd after the Bypass question), x (Cancel), r (Reply
// here).
func (b *Bridge) forwardPress(ctx context.Context, c *Client, chat string, msgID int64, arg string, toast func(string), premium func() bool) {
	p := b.pickerAt(ctx, msgID)
	if p == nil || b.now().Sub(p.at) > confirmFor {
		b.take(msgID)
		toast("That question has expired. Forward the messages again.")
		_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{{{Text: "Expired", CallbackData: "-"}}}})
		return
	}
	edit := func(text string) { _ = c.EditText(ctx, chat, msgID, text, "HTML", nil) }
	switch arg {
	case "x":
		b.take(msgID)
		toast("")
		edit("Cancelled — nothing was sent.")
	case "r":
		b.mu.Lock()
		p.reply = !p.reply
		on := p.reply
		b.mu.Unlock()
		_ = b.Store.Update(func(st *State) { st.ForwardReply = on })
		if on {
			toast("The answer will come here.")
		} else {
			toast("The answer stays in Caprock.")
		}
		_ = c.EditMarkup(ctx, chat, msgID, pickerMarkup(p))
	case "n", "nb", "nd":
		if !premium() {
			return
		}
		mode := b.Host.SpawnMode()
		if arg == "n" && mode == "bypassPermissions" {
			toast("")
			_ = c.EditMarkup(ctx, chat, msgID, &Markup{InlineKeyboard: [][]InlineButton{
				{{Text: "Start in Bypass", CallbackData: "f:nb"}, {Text: "Ask first instead", CallbackData: "f:nd"}},
				{{Text: "Cancel", CallbackData: "f:x"}},
			}})
			return
		}
		switch arg {
		case "nb":
			mode = "bypassPermissions"
		case "nd":
			mode = "default"
		}
		if b.take(msgID) == nil {
			toast("")
			return
		}
		toast("")
		edit("Starting a new chat…")
		go b.startChat(context.WithoutCancel(ctx), c, chat, msgID, p, mode)
	default:
		if !premium() {
			return
		}
		n, err := strconv.Atoi(arg)
		if err != nil || n < 1 || n > len(p.sessions) {
			toast("That list is out of date. Forward the messages again.")
			return
		}
		id := p.sessions[n-1]
		s, ok := b.Host.Session(ctx, id)
		if !ok || !s.Owned || !s.Alive {
			toast("That session is no longer running. Pick another.")
			return
		}
		if b.take(msgID) == nil {
			toast("")
			return
		}
		toast("")
		title := s.Title
		if title == "" {
			title = "the session"
		}
		edit("Sending to <b>" + Escape(title) + "</b>…")
		go b.send(context.WithoutCancel(ctx), c, chat, msgID, p, id, title)
	}
}

// send puts the forward into a session and says how it went.
func (b *Bridge) send(ctx context.Context, c *Client, chat string, msgID int64, p *picker, id, title string) {
	edit := func(text string) { _ = c.EditText(ctx, chat, msgID, text, "HTML", nil) }
	text := b.compose(ctx, c, p)
	queued, err := b.Host.Forward(ctx, id, text)
	if err != nil {
		edit("Could not send it to <b>" + Escape(title) + "</b>: " + Escape(err.Error()))
		return
	}
	if queued == 0 {
		edit("✓ Sent to <b>" + Escape(title) + "</b>")
		if p.reply {
			b.ReplyOnce(id)
		}
		return
	}
	b.mu.Lock()
	b.queuedFwd[queued] = queuedFwd{chat: chat, msgID: msgID, session: id, title: title, reply: p.reply}
	b.mu.Unlock()
	edit("⏳ <b>" + Escape(title) + "</b> is busy — will send when it finishes")
}

// startChat starts a new chat with the forward as its first message.
func (b *Bridge) startChat(ctx context.Context, c *Client, chat string, msgID int64, p *picker, mode string) {
	edit := func(text string) { _ = c.EditText(ctx, chat, msgID, text, "HTML", nil) }
	text := b.compose(ctx, c, p)
	id, err := b.Host.StartChat(ctx, text, mode)
	if err != nil {
		edit("Could not start a chat: " + Escape(err.Error()))
		return
	}
	edit("✓ Started a new chat with it. It is in Chats, on your phone and your computer.")
	if p.reply {
		b.ReplyOnce(id)
	}
}

// QueuedSent is the message queue typing a held forward in: its picker says
// it went.
func (b *Bridge) QueuedSent(queued int64) {
	b.mu.Lock()
	q, ok := b.queuedFwd[queued]
	delete(b.queuedFwd, queued)
	b.mu.Unlock()
	if !ok {
		return
	}
	if q.reply {
		b.ReplyOnce(q.session)
	}
	token, _ := b.Host.Bot()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = b.client(token).EditText(ctx, q.chat, q.msgID, "✓ Sent to <b>"+Escape(q.title)+"</b>", "HTML", nil)
}

// ReplyOnce asks for a session's next answer in Telegram: the turn a
// forward started, with Reply here on.
func (b *Bridge) ReplyOnce(id string) {
	b.mu.Lock()
	if b.replyOnce == nil {
		b.replyOnce = map[string]replyAsk{}
	}
	b.replyOnce[id] = replyAsk{at: b.now()}
	b.mu.Unlock()
}

// replyAsk is an answer asked for, and whether its turn has ended.
type replyAsk struct {
	at    time.Time
	taken bool
}

// repliedHold is how long after a forward's answer went to Telegram the
// rules' own finished alert about the same turn is held back.
const repliedHold = 10 * time.Minute

// TakeReplyOnce reports, once, that a session's answer was asked for.
func (b *Bridge) TakeReplyOnce(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok := b.replyOnce[id]
	if !ok || r.taken || b.now().Sub(r.at) >= replyOnceFor {
		return false
	}
	b.replyOnce[id] = replyAsk{at: b.now(), taken: true}
	return true
}

// Replying reports a session whose answer goes to Telegram for a forward,
// or just went: the rules' finished alert about it would say it twice.
func (b *Bridge) Replying(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok := b.replyOnce[id]
	switch {
	case !ok:
		return false
	case r.taken:
		return b.now().Sub(r.at) < repliedHold
	}
	return b.now().Sub(r.at) < replyOnceFor
}

// compose is the one message the agent gets: the owner's words, then each
// item as a quote with where it came from, a photo or file as its saved
// path (quoted, as the phone writes one), a voice note marked as not
// transcribed.
func (b *Bridge) compose(ctx context.Context, c *Client, p *picker) string {
	var parts []string
	if w := strings.TrimSpace(strings.Join(p.words, "\n")); w != "" {
		parts = append(parts, w)
	}
	for _, it := range p.items {
		lines := []string{it.origin}
		if it.text != "" {
			lines = append(lines, strings.Split(it.text, "\n")...)
		}
		if it.kind != "" {
			lines = append(lines, b.fileLine(ctx, c, it))
		}
		for i, l := range lines {
			lines[i] = "> " + l
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return clipBytes(strings.Join(parts, "\n\n"), forwardTextMax)
}

// fileLine fetches an item's file into the paste folder and names it.
func (b *Bridge) fileLine(ctx context.Context, c *Client, it fwdItem) string {
	what := map[string]string{"photo": "Photo", "file": "File", "voice": "Voice message (not transcribed)", "audio": "Audio", "video": "Video"}[it.kind]
	if it.kind == "file" && it.file.FileName != "" {
		what = "File " + it.file.FileName
	}
	if it.file.FileSize > forwardFileMax {
		return what + " (not fetched: larger than 10 MB)"
	}
	data, err := c.Download(ctx, it.file.FileID, forwardFileMax)
	switch {
	case TooLarge(err):
		return what + " (not fetched: larger than 10 MB)"
	case err != nil:
		b.Log.Info("telegram: a forwarded file could not be fetched", "component", "telegram", "err", err)
		return what + " (could not be fetched from Telegram)"
	}
	name := it.file.FileName
	if name == "" {
		name = it.kind
	}
	path, err := b.Host.SaveFile(name, it.file.MimeType, data)
	if err != nil {
		return what + " (not saved: " + err.Error() + ")"
	}
	return what + ": " + quotePath(path)
}

// quotePath quotes a path as the phone writes one into a message.
func quotePath(p string) string { return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"` }

// clipBytes cuts s to at most n bytes on a rune boundary, marking the cut.
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n - len("…")
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}
