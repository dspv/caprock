// Command looprelay is the relay (internal/remote/relaysrv) on a loopback
// port, for the browser end-to-end tests that link two sandboxed daemons
// (ui/e2e/talks-stand.ts): never the hosted relay, never another interface.
//
//	looprelay -addr 127.0.0.1:0 -out relay.addr
//
// It writes the address it listens on to -out once it listens, and stops on
// SIGTERM or when its standard input closes.
package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dspv/caprock/internal/remote/relaysrv"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "loopback address to listen on")
	out := flag.String("out", "", "file to write the address to")
	flag.Parse()
	if host, _, err := net.SplitHostPort(*addr); err != nil || (host != "127.0.0.1" && host != "::1" && !strings.EqualFold(host, "localhost")) {
		fmt.Fprintln(os.Stderr, "looprelay: loopback addresses only")
		os.Exit(2)
	}
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "looprelay:", err)
		os.Exit(1)
	}
	if *out != "" {
		if err := os.WriteFile(*out, []byte(ln.Addr().String()), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "looprelay:", err)
			os.Exit(1)
		}
	}
	srv := &http.Server{Handler: relaysrv.New(nil), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	gone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(gone) }()
	select {
	case <-stop:
	case <-gone:
	}
	_ = srv.Close()
}
