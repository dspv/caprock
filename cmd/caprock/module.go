package main

import (
	"fmt"

	"github.com/dspv/caprock/internal/modules"
	"github.com/spf13/cobra"
)

// moduleCmd installs private modules from a local folder (ADR-075). Hidden:
// it does nothing without an admin key, and nothing here mentions modules to
// anyone who has none.
func moduleCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:    "module",
		Short:  "Install, list or remove private modules",
		Hidden: true,
	}
	cmd.AddCommand(moduleInstallCmd(), moduleListCmd(), moduleRemoveCmd())
	return cmd
}

// adminGrant reads and verifies the stored admin key.
func adminGrant() (string, modules.Grant, error) {
	dir, cfg, err := loadCfg()
	if err != nil {
		return "", modules.Grant{}, err
	}
	if cfg.AdminKey == "" {
		return "", modules.Grant{}, fmt.Errorf("no admin key: store one with `caprock license set <CRA1 key>`")
	}
	g, err := modules.ParseKey(cfg.AdminKey)
	if err != nil {
		return "", modules.Grant{}, fmt.Errorf("the stored admin key is not valid: %w", err)
	}
	return dir, g, nil
}

func moduleInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install <dir>",
		Short: "Copy a built module (module.json + index.html) into Caprock",
		Long: "Copy a built module from a folder on this machine into Caprock's data\n" +
			"directory, replacing an older copy. The admin key must name the module.\n" +
			"Nothing is downloaded.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, g, err := adminGrant()
			if err != nil {
				return err
			}
			m, err := modules.Install(args[0], modules.Root(dir), g)
			if err != nil {
				return err
			}
			v := ""
			if m.Version != "" {
				v = " " + m.Version
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Installed %s%s (%s). It shows in the sidebar the next time the app loads.\n", m.Name, v, m.ID)
			return nil
		},
	}
}

func moduleListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List the installed modules the admin key names",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			dir, g, err := adminGrant()
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			n := 0
			for _, m := range modules.Installed(modules.Root(dir)) {
				if !g.Allows(m.ID) {
					continue
				}
				n++
				fmt.Fprintf(out, "%s\t%s\t%s\n", m.ID, m.Name, m.Version)
			}
			if n == 0 {
				fmt.Fprintln(out, "No modules installed.")
			}
			return nil
		},
	}
}

func moduleRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "remove <id>",
		Short: "Remove an installed module's files (its documents are kept)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, _, err := adminGrant()
			if err != nil {
				return err
			}
			if err := modules.Remove(modules.Root(dir), args[0]); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Removed %s. Its documents stay in Caprock's database.\n", args[0])
			return nil
		},
	}
}
