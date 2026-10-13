package remote

// The phone's protocol, inside the Noise channel. Every transport message is
// one frame: a kind byte, a four-byte stream id the phone chose, and a body.
// Streams are HTTP requests and WebSockets onto this daemon's own API, so the
// phone's dashboard runs unchanged: its fetch() and WebSocket calls are
// carried, not rewritten (ui/src/remote/transport.ts).
//
//	phone → daemon
//	  KindReq      {"m","p","h"}       an HTTP request's head
//	  KindReqBody  bytes               part of its body
//	  KindReqEnd                       the body is complete; send it
//	  KindWSOpen   {"p","proto"}       open a WebSocket at path p
//	  KindCancel                       abandon the stream
//	daemon → phone
//	  KindRes      {"s","h"}           the response's status and headers
//	  KindResBody  bytes               part of its body
//	  KindResEnd                       the body is complete
//	  KindWSOpened {"proto"}           the socket is open
//	both ways, on a WebSocket stream
//	  KindWSPart   bytes               a message continues in the next frame
//	  KindWSText   bytes               the last part of a text message
//	  KindWSBinary bytes               the last part of a binary message
//	  KindWSClose  {"code","reason"}   the socket closed
//
// The first message each way is the Noise handshake; its payloads are a
// Hello from the phone and a Welcome from the daemon.
const (
	KindReq      byte = 0x01
	KindReqBody  byte = 0x02
	KindReqEnd   byte = 0x03
	KindRes      byte = 0x04
	KindResBody  byte = 0x05
	KindResEnd   byte = 0x06
	KindWSOpen   byte = 0x07
	KindWSOpened byte = 0x08
	KindWSText   byte = 0x09
	KindWSBinary byte = 0x0a
	KindWSClose  byte = 0x0b
	KindCancel   byte = 0x0c
	KindWSPart   byte = 0x0d

	// ProtocolVersion is the frame protocol above. A phone speaking a newer
	// one is told so in the Welcome rather than half-working.
	ProtocolVersion = 1

	// chunk is the most body one frame carries: room for the five-byte header
	// under MaxPlaintext, rounded down.
	chunk = 60 << 10
	// maxRequestBody bounds what a phone may upload in one request. A photo
	// for a session is the largest thing the dashboard sends.
	maxRequestBody = 32 << 20
	// maxWSMessage bounds one reassembled WebSocket message from the phone.
	maxWSMessage = 4 << 20
	// maxStreams bounds what one phone keeps open at once.
	maxStreams = 64
)

// Hello is the phone's handshake payload.
type Hello struct {
	V int `json:"v"`
}

// Welcome is the daemon's.
type Welcome struct {
	V       int    `json:"v"`
	Version string `json:"version"`
	Name    string `json:"name"`
}

type reqHead struct {
	Method  string            `json:"m"`
	Path    string            `json:"p"`
	Headers map[string]string `json:"h,omitempty"`
}

type resHead struct {
	Status  int               `json:"s"`
	Headers map[string]string `json:"h,omitempty"`
}

type wsOpen struct {
	Path      string   `json:"p"`
	Protocols []string `json:"proto,omitempty"`
}

type wsOpened struct {
	Protocol string `json:"proto,omitempty"`
}

type wsClose struct {
	Code   int    `json:"code"`
	Reason string `json:"reason,omitempty"`
}

// Request headers a phone may set. Everything a browser adds on its own —
// Origin, Sec-Fetch-*, cookies — is dropped: inside the channel there is no
// other site to defend against, and passing them on would only make the
// daemon's cross-site checks judge the phone's page instead of the phone.
var requestHeaders = map[string]bool{
	"Accept":            true,
	"Accept-Language":   true,
	"Cache-Control":     true,
	"Content-Type":      true,
	"If-Modified-Since": true,
	"If-None-Match":     true,
	"Range":             true,
	"X-Caprock-Device":  true,
}

// Response headers that describe a hop rather than the response.
var hopHeaders = map[string]bool{
	"Connection":        true,
	"Content-Length":    true,
	"Keep-Alive":        true,
	"Set-Cookie":        true,
	"Transfer-Encoding": true,
	"Upgrade":           true,
}
