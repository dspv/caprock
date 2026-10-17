package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/dspv/caprock/internal/api"
	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/qr"
	"github.com/dspv/caprock/internal/remote"
	"github.com/dspv/caprock/internal/remote/relaysrv"
)

// Access from anywhere, from a terminal (ADR-058). The dashboard's Settings →
// Use on your phone → Connect a phone does the same; these exist for the machine
// nobody sits at — a Mac mini reached over SSH has no screen to click on.

func remoteCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "remote",
		Short: "Reach this machine from a phone anywhere, through an encrypted relay",
		Long: "Access from anywhere: this machine waits at a relay, and a phone paired with it\n" +
			"reaches the dashboard through a channel encrypted end to end — the relay passes\n" +
			"bytes it cannot read. Off by default; remembered once on.",
		RunE: func(cmd *cobra.Command, _ []string) error { return printRemote(cmd.OutOrStdout()) },
	}
	var relay, app string
	on := &cobra.Command{
		Use:   "on",
		Short: "Turn access from anywhere on (and keep it on across restarts)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := setRemote(true, relay, app); err != nil {
				return err
			}
			return printRemote(cmd.OutOrStdout())
		},
	}
	on.Flags().StringVar(&relay, "relay", "", "relay address, wss://… (default "+remote.DefaultRelay+")")
	on.Flags().StringVar(&app, "app", "", "the phone's page, https://… (default "+remote.DefaultApp+")")
	off := &cobra.Command{
		Use:   "off",
		Short: "Turn access from anywhere off; paired phones stay paired",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := setRemote(false, "", ""); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "access from anywhere is off")
			return nil
		},
	}
	reset := &cobra.Command{
		Use:   "reset",
		Short: "Give this machine new keys; every phone paired through the relay pairs again",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if _, err := runningDaemon(); err == nil {
				return errors.New("stop caprock first (caprock down): it holds the current keys")
			}
			dir, err := config.DataDir()
			if err != nil {
				return err
			}
			if err := remote.Reset(dir); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "new keys on next start; phones paired through the relay must pair again")
			return nil
		},
	}
	c.AddCommand(on, off, reset, relayCmd())
	return c
}

// pairCmd issues a code and draws the QR in the terminal.
func pairCmd() *cobra.Command {
	var computer, noWait bool
	c := &cobra.Command{
		Use:   "pair",
		Short: "Show a pairing code and its QR here, for a phone to scan (or --computer, for another computer)",
		Long: "Issues a one-time code (valid five minutes) and draws the QR a phone scans.\n" +
			"With access from anywhere on, the QR opens the phone's page through the relay;\n" +
			"otherwise it opens this machine's network address.\n\n" +
			"With --computer it prints a link for another computer's Caprock instead\n" +
			"(`caprock machines add '<link>'` there), turning access from anywhere on if it\n" +
			"is off, and waits here to ask whether to allow that computer by name. Over SSH\n" +
			"on a machine with no screen this is the screen; `caprock machines allow <name>`\n" +
			"does the same later.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			rt, err := runningDaemon()
			if err != nil {
				return err
			}
			if computer {
				return pairComputer(cmd, rt, !noWait)
			}
			var got struct {
				Code   string           `json:"code"`
				URL    string           `json:"url"`
				Remote *api.RemoteState `json:"remote"`
			}
			if err := daemonJSON(rt, http.MethodPost, "/v1/pair/code", nil, &got); err != nil {
				return err
			}
			link := ""
			switch {
			case got.Remote != nil && got.Remote.Enabled && got.Remote.Link != "":
				link = got.Remote.Link
			case got.URL != "":
				link = got.URL + "/#/pair?code=" + got.Code
			}
			out := cmd.OutOrStdout()
			if link == "" {
				fmt.Fprintf(out, "code: %s\nNeither access from anywhere (caprock remote on) nor network access is on, so there is no address to scan.\n", got.Code)
				return nil
			}
			if code, err := qr.Encode(link); err == nil {
				fmt.Fprintln(out, code.Terminal(2))
			}
			fmt.Fprintf(out, "code: %s  (valid five minutes, once)\nlink: %s\n", got.Code, link)
			return nil
		},
	}
	c.Flags().BoolVar(&computer, "computer", false, "a link for another computer's Caprock to control this one (ADR-067)")
	c.Flags().BoolVar(&noWait, "no-wait", false, "with --computer: print the link and return; allow later with `caprock machines allow <name>`")
	return c
}

func relayCmd() *cobra.Command {
	var addr string
	c := &cobra.Command{
		Use:   "relay",
		Short: "Run a relay of your own",
		Long: "Serves a relay for phones and machines to meet at. Put it behind TLS (Caddy, a\n" +
			"load balancer) and point machines at it with `caprock remote on --relay wss://…`.\n" +
			"It passes encrypted bytes and keeps nothing.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			log := slog.New(slog.NewTextHandler(os.Stderr, nil))
			srv := &http.Server{Addr: addr, Handler: relaysrv.New(log), ReadHeaderTimeout: 10 * time.Second}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			go func() {
				<-ctx.Done()
				sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = srv.Shutdown(sctx)
			}()
			log.Info("relay listening", "addr", addr)
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				return err
			}
			return nil
		},
	}
	c.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address to listen on")
	return c
}

func setRemote(on bool, relay, app string) error {
	rt, err := runningDaemon()
	if err != nil {
		return err
	}
	var st api.RemoteState
	return daemonJSON(rt, http.MethodPost, "/v1/pair/remote", map[string]any{"on": on, "relay": relay, "app": app}, &st)
}

func printRemote(out io.Writer) error {
	rt, err := runningDaemon()
	if err != nil {
		return err
	}
	var st struct {
		Remote *api.RemoteState `json:"remote"`
	}
	if err := daemonJSON(rt, http.MethodGet, "/v1/pair/state", nil, &st); err != nil {
		return err
	}
	r := st.Remote
	if r == nil {
		return errors.New("this caprock cannot be reached through a relay")
	}
	if !r.Enabled {
		fmt.Fprintln(out, "access from anywhere: off   (caprock remote on)")
		return nil
	}
	fmt.Fprintf(out, "access from anywhere: %s", r.Status)
	if r.Error != "" {
		fmt.Fprintf(out, " — %s", r.Error)
	}
	fmt.Fprintf(out, "\nrelay:  %s\nphone:  %s\nphones connected: %d\npair a phone: caprock pair\n", r.Relay, r.App, r.Phones)
	return nil
}

// daemonJSON calls the local daemon's API and decodes its answer.
func daemonJSON(rt config.Runtime, method, path string, body, into any) error {
	return daemonJSONWait(rt, method, path, body, into, 10*time.Second)
}

// daemonJSONWait is daemonJSON with its own time limit, for a call that waits
// on another computer (pairing through a relay).
func daemonJSONWait(rt config.Runtime, method, path string, body, into any, wait time.Duration) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", rt.Port, path), rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: wait}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(b, &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("caprock answered %s", res.Status)
	}
	if into == nil {
		return nil
	}
	return json.Unmarshal(b, into)
}
