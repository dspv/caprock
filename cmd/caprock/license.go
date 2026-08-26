package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/dspv/caprock/internal/config"
	"github.com/dspv/caprock/internal/license"
	"github.com/spf13/cobra"
)

// licenseCmd manages the paid key from the terminal.
//
// The dashboard can already paste a key, so this is not about parity. It is
// about the cases a Stripe webhook does not cover: a customer who paid another
// way, a refund reissued, a friend, a conference. Until this existed the only
// thing that could mint a key was the webhook — a business with no manual
// override is one that fails its first unusual customer.
func licenseCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "license",
		Short: "Show, set, or clear the licence key",
		Long: "Show the licence Caprock is using, paste a new one, or clear it.\n\n" +
			"The key carries its own expiry and is checked on this machine.\n" +
			"Caprock makes no request to verify it, now or ever.",
		RunE: func(cmd *cobra.Command, _ []string) error { return showLicense(cmd) },
	}
	cmd.AddCommand(licenseSetCmd(), licenseClearCmd(), licenseIssueCmd())
	return cmd
}

func loadCfg() (string, config.Config, error) {
	dir, err := config.EnsureDataDir()
	if err != nil {
		return "", config.Config{}, err
	}
	cfg, err := config.Load(dir)
	return dir, cfg, err
}

func showLicense(cmd *cobra.Command) error {
	_, cfg, err := loadCfg()
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	s := license.Parse(cfg.LicenseKey, time.Now())
	switch {
	case cfg.LicenseKey == "":
		fmt.Fprintln(out, "No licence key. Everything Caprock does today is free and stays free.")
		fmt.Fprintln(out, "Premium: https://caprock.dev/premium/")
	case s.Active && s.InGrace:
		fmt.Fprintf(out, "%s\n%s\n", cfg.LicenseKey, s.Reason)
	case s.Active:
		fmt.Fprintf(out, "%s\nactive", cfg.LicenseKey)
		if s.ExpiresAt != nil {
			fmt.Fprintf(out, " until %s", s.ExpiresAt.Format("2006-01-02"))
		}
		fmt.Fprintln(out)
	default:
		fmt.Fprintf(out, "%s\nnot active: %s\n", cfg.LicenseKey, s.Reason)
	}
	return nil
}

func licenseSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <key>",
		Short: "Store a licence key",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, cfg, err := loadCfg()
			if err != nil {
				return err
			}
			key := strings.TrimSpace(args[0])
			// Refuse a key that does not work rather than storing it and
			// leaving someone to wonder why nothing happened. Their next move
			// is to email about it, and "invalid" is not an answer.
			if s := license.Parse(key, time.Now()); !s.Active {
				return fmt.Errorf("that key is not active: %s", s.Reason)
			}
			cfg.LicenseKey = key
			if err := config.Save(dir, cfg); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Saved. Restart the daemon (caprock down && caprock up) to pick it up.")
			return nil
		},
	}
}

func licenseClearCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clear",
		Short: "Remove the licence key",
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, cfg, err := loadCfg()
			if err != nil {
				return err
			}
			cfg.LicenseKey = ""
			if err := config.Save(dir, cfg); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), "Cleared. The free product is unaffected.")
			return nil
		},
	}
}

func licenseIssueCmd() *cobra.Command {
	var days int
	var lifetime bool
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "issue",
		Short: "Mint a key (for whoever runs the business)",
		Long: "Mint a licence key with an expiry.\n\n" +
			"For the cases Stripe does not cover: someone who paid another way,\n" +
			"a refund reissued, a friend, a conference. The key is not recorded\n" +
			"anywhere — copy it before you close the terminal.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if lifetime {
				days = 365 * 50
			}
			if days <= 0 {
				return fmt.Errorf("--days must be positive (or pass --lifetime)")
			}
			// The date names the last day covered, so a 35-day key issued today
			// covers today plus 34 more.
			until := time.Now().AddDate(0, 0, days-1)
			key := license.Issue(until, license.RandomSuffix)
			if asJSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(map[string]string{
					"key":   key,
					"until": until.Format("2006-01-02"),
				})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s\ncovers through %s\n", key, until.Format("2006-01-02"))
			return nil
		},
	}
	cmd.Flags().IntVar(&days, "days", 0, "how many days the key covers")
	cmd.Flags().BoolVar(&lifetime, "lifetime", false, "a key that outlives the question")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print as JSON")
	cmd.SetOut(os.Stdout)
	return cmd
}
