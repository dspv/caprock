package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime/metrics"
	"time"

	"modernc.org/libc"
)

// PprofEnv names the opt-in profiling listener. Unset (the default) means no
// listener at all. Set to a loopback address — "127.0.0.1:6061" — it serves
// Go's net/http/pprof handlers there, on a listener of its own, never on the
// API port: that port can be reachable from a paired phone, and a profile
// carries memory contents. Anything that is not a loopback address is refused
// and logged, so a typo cannot open it to the network.
const PprofEnv = "CAPROCK_PPROF"

// startPprof starts the profiling listener when PprofEnv asks for one. It is
// a developer's tool for measuring the daemon on a real database (release
// binaries are stripped, so `sample` cannot name a Go frame), documented in
// 10-infrastructure.md § Profiling the daemon.
func startPprof(ctx context.Context, log *slog.Logger) {
	addr := os.Getenv(PprofEnv)
	if addr == "" {
		return
	}
	if !loopbackAddr(addr) {
		log.Warn("profiling listener refused: not a loopback address", "component", "daemon", "env", PprofEnv, "addr", addr)
		return
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Warn("profiling listener could not start", "component", "daemon", "addr", addr, "err", err)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/debug/caprock/mem", memHandler)
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Warn("profiling listener stopped", "component", "daemon", "err", err)
		}
	}()
	log.Info("profiling listener on (developer use)", "component", "daemon", "addr", ln.Addr().String())
}

// loopbackAddr reports whether addr is host:port with a loopback IP host.
// "localhost" is refused on purpose: it is a name, and a hosts file can point
// it anywhere.
func loopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// memMetrics are the runtime/metrics memHandler reports, in bytes.
var memMetrics = []string{
	"/memory/classes/total:bytes",
	"/memory/classes/heap/objects:bytes",
	"/memory/classes/heap/unused:bytes",
	"/memory/classes/heap/free:bytes",
	"/memory/classes/heap/released:bytes",
	"/memory/classes/heap/stacks:bytes",
	"/gc/gomemlimit:bytes",
}

// memHandler splits the daemon's memory for a developer measuring it
// (10-infrastructure.md § Profiling the daemon): what the Go runtime holds,
// from runtime/metrics, and what SQLite holds. SQLite does not allocate on
// the Go heap: the driver's C library (modernc.org/libc) maps memory of its
// own, which a heap profile never shows and the process footprint does.
// libc counts it only in a build with `-tags memory.counters`; in any other
// build sqlite_bytes is 0, which says "not counted", not "none".
func memHandler(w http.ResponseWriter, _ *http.Request) {
	samples := make([]metrics.Sample, len(memMetrics))
	for i, name := range memMetrics {
		samples[i].Name = name
	}
	metrics.Read(samples)
	out := map[string]any{}
	for _, s := range samples {
		if s.Value.Kind() == metrics.KindUint64 {
			out[s.Name] = s.Value.Uint64()
		}
	}
	st := libc.MemStat()
	out["sqlite_bytes"] = st.Bytes
	out["sqlite_allocs"] = st.Allocs
	out["sqlite_mmaps"] = st.Mmaps
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}
