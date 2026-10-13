package importer

import (
	"os"
	"testing"
)

// TestRealSanity is a manual, opt-in check against the real home. It prints
// only host + account count + whether a password decrypted (bool/length),
// never a username or password, and never logs in anywhere. Run with
// CAPROCK_IMPORT_SANITY=1.
func TestRealSanity(t *testing.T) {
	if os.Getenv("CAPROCK_IMPORT_SANITY") != "1" {
		t.Skip("set CAPROCK_IMPORT_SANITY=1 to run the real-home sanity check")
	}
	for _, s := range Sources(os.Getenv("HOME")) {
		t.Logf("source=%s label=%q accounts=%d needs_permission=%q error=%q",
			s.Kind, s.Label, len(s.Accounts), s.NeedsPermission, s.Error)
		for _, a := range s.Accounts {
			pw, ok := s.Password(a.Email)
			t.Logf("  imap_host=%s imap_port=%d imap_tls=%s smtp_host=%s smtp_port=%d has_password=%v pw_decrypted=%v pw_len=%d",
				a.IMAPHost, a.IMAPPort, a.IMAPTLS, a.SMTPHost, a.SMTPPort, a.HasPassword, ok, len(pw))
		}
	}
}
