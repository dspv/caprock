package modules

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sign makes a key the way the issuing script does: base64url of the payload
// without padding, and a signature over that text.
func sign(t *testing.T, priv ed25519.PrivateKey, payload string) string {
	t.Helper()
	body := base64.RawURLEncoding.EncodeToString([]byte(payload))
	sig := ed25519.Sign(priv, []byte(body))
	return KeyPrefix + body + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func testKeys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

const goodPayload = `{"v":1,"sub":"someone","role":"admin","modules":["alpha","beta"],"iat":"2026-10-17"}`

func TestEmbeddedPublicKeyIsRawEd25519(t *testing.T) {
	if len(publicKey) != ed25519.PublicKeySize {
		t.Fatalf("embedded key is %d bytes", len(publicKey))
	}
}

func TestParseKey(t *testing.T) {
	pub, priv := testKeys(t)
	key := sign(t, priv, goodPayload)
	g, err := ParseKeyWith("  "+key+"\n", pub)
	if err != nil {
		t.Fatalf("a signed key was refused: %v", err)
	}
	if g.Subject != "someone" || !g.Allows("alpha") || !g.Allows("beta") || g.Allows("gamma") || g.IssuedAt != "2026-10-17" {
		t.Errorf("grant = %+v", g)
	}
}

func TestParseKeyRefuses(t *testing.T) {
	pub, priv := testKeys(t)
	_, other := testKeys(t)
	good := sign(t, priv, goodPayload)
	body, sig, _ := strings.Cut(strings.TrimPrefix(good, KeyPrefix), ".")
	forged := base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(goodPayload, `"beta"`, `"gamma"`, 1)))
	for name, tc := range map[string]struct{ key, why string }{
		"empty":                 {"", "no key"},
		"a premium key":         {"CR-2027-01-01-ABCDEF12", "not an admin key"},
		"no signature":          {KeyPrefix + body, "cut short"},
		"extra part":            {good + ".x", "cut short"},
		"another signer":        {sign(t, other, goodPayload), "does not match"},
		"payload swapped":       {KeyPrefix + forged + "." + sig, "does not match"},
		"signature not base64":  {KeyPrefix + body + ".!!!", "not readable"},
		"not admin":             {sign(t, priv, `{"v":1,"sub":"x","role":"user","modules":["alpha"]}`), "not admin"},
		"future version":        {sign(t, priv, `{"v":2,"sub":"x","role":"admin","modules":["alpha"]}`), "version"},
		"a module id with path": {sign(t, priv, `{"v":1,"sub":"x","role":"admin","modules":["../etc"]}`), "not valid"},
		"payload not JSON":      {sign(t, priv, `not json`), "not readable"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseKeyWith(tc.key, pub)
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.Contains(err.Error(), tc.why) {
				t.Errorf("error %q does not say %q", err, tc.why)
			}
		})
	}
}

// A key signed for a test key pair is not valid for the build.
func TestParseKeyUsesEmbeddedKey(t *testing.T) {
	_, priv := testKeys(t)
	if _, err := ParseKey(sign(t, priv, goodPayload)); err == nil {
		t.Fatal("a key from another signer passed the embedded check")
	}
}

func writeModule(t *testing.T, dir, manifest string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		ManifestFile:    manifest,
		Entry:           "<!doctype html><title>x</title>",
		"assets/app.js": "console.log(1)",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInstallFindRemove(t *testing.T) {
	src, root := t.TempDir(), filepath.Join(t.TempDir(), "modules")
	writeModule(t, src, `{"id":"alpha","name":"Alpha","version":"1"}`)
	g := Grant{Modules: []string{"alpha"}}
	m, err := Install(src, root, g)
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != "alpha" || m.Name != "Alpha" {
		t.Errorf("manifest = %+v", m)
	}
	if _, dir, ok := Find(root, "alpha"); !ok {
		t.Fatal("installed module not found")
	} else if _, err := os.Stat(filepath.Join(dir, "assets/app.js")); err != nil {
		t.Errorf("nested file not copied: %v", err)
	}

	// Reinstalling replaces the whole folder: a file the new build dropped goes.
	if err := os.Remove(filepath.Join(src, "assets/app.js")); err != nil {
		t.Fatal(err)
	}
	writeModule(t, src, `{"id":"alpha","name":"Alpha","version":"2"}`)
	_ = os.Remove(filepath.Join(src, "assets/app.js"))
	if m, err = Install(src, root, g); err != nil || m.Version != "2" {
		t.Fatalf("reinstall: %+v %v", m, err)
	}
	if _, err := os.Stat(filepath.Join(root, "alpha/assets/app.js")); err == nil {
		t.Error("a file the new build dropped is still installed")
	}
	if got := Installed(root); len(got) != 1 || got[0].ID != "alpha" {
		t.Errorf("Installed = %+v (no staging folders may be left)", got)
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Errorf("root holds %d entries, want only the module", len(entries))
	}

	if err := Remove(root, "alpha"); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := Find(root, "alpha"); ok {
		t.Error("removed module still found")
	}
}

func TestInstallRefuses(t *testing.T) {
	root := filepath.Join(t.TempDir(), "modules")
	g := Grant{Modules: []string{"alpha"}}
	for name, tc := range map[string]struct{ manifest, why string }{
		"not in the key": {`{"id":"beta","name":"Beta"}`, "does not name"},
		"bad id":         {`{"id":"../x","name":"X"}`, "not valid"},
		"no name":        {`{"id":"alpha"}`, "name"},
		"not JSON":       {`{`, "not readable"},
	} {
		t.Run(name, func(t *testing.T) {
			src := t.TempDir()
			writeModule(t, src, tc.manifest)
			_, err := Install(src, root, g)
			if err == nil || !strings.Contains(err.Error(), tc.why) {
				t.Errorf("err = %v, want it to say %q", err, tc.why)
			}
		})
	}
	t.Run("no entry page", func(t *testing.T) {
		src := t.TempDir()
		writeModule(t, src, `{"id":"alpha","name":"Alpha"}`)
		_ = os.Remove(filepath.Join(src, Entry))
		if _, err := Install(src, root, g); err == nil || !strings.Contains(err.Error(), Entry) {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("a link inside", func(t *testing.T) {
		src := t.TempDir()
		writeModule(t, src, `{"id":"alpha","name":"Alpha"}`)
		if err := os.Symlink("/etc/hosts", filepath.Join(src, "hosts")); err != nil {
			t.Skip("no symlinks here:", err)
		}
		if _, err := Install(src, root, g); err == nil || !strings.Contains(err.Error(), "links") {
			t.Errorf("err = %v", err)
		}
		if _, _, ok := Find(root, "alpha"); ok {
			t.Error("a refused install left a module behind")
		}
	})
}

func TestInstalledSkipsFolderWithAnotherID(t *testing.T) {
	root := t.TempDir()
	writeModule(t, filepath.Join(root, "alpha"), `{"id":"beta","name":"Beta"}`)
	if got := Installed(root); len(got) != 0 {
		t.Errorf("Installed = %+v", got)
	}
}
