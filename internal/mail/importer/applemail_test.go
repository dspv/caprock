package importer

import (
	"database/sql"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	_ "modernc.org/sqlite"
)

// --- a tiny bplist + NSKeyedArchiver encoder, test-only -------------------

// bwriter serializes Go values (string, int, int64, bool, []any, map) into a
// bplist00 blob with 2-byte refs, enough to feed the decoder under test.
type bwriter struct {
	objs []any
}

func (w *bwriter) add(v any) int {
	w.objs = append(w.objs, v)
	return len(w.objs) - 1
}

func encodeBplist(root any) []byte {
	w := &bwriter{}
	var collect func(v any) int
	collect = func(v any) int {
		switch t := v.(type) {
		case []any:
			refs := make([]int, len(t))
			for i, e := range t {
				refs[i] = collect(e)
			}
			return w.add(barray(refs))
		case map[string]any:
			keys := make([]int, 0, len(t))
			vals := make([]int, 0, len(t))
			for k, e := range t {
				keys = append(keys, collect(k))
				vals = append(vals, collect(e))
			}
			return w.add(bdict{keys, vals})
		default:
			return w.add(v)
		}
	}
	rootIdx := collect(root)

	// Encode each object, recording its offset.
	var buf []byte
	buf = append(buf, []byte("bplist00")...)
	offsets := make([]int, len(w.objs))
	for i, o := range w.objs {
		offsets[i] = len(buf)
		buf = append(buf, encodeObj(o)...)
	}
	tableStart := len(buf)
	for _, off := range offsets {
		buf = append(buf, byte(off>>24), byte(off>>16), byte(off>>8), byte(off))
	}
	trailer := make([]byte, 32)
	trailer[6] = 4 // offset size
	trailer[7] = 2 // ref size
	binary.BigEndian.PutUint64(trailer[8:], uint64(len(w.objs)))
	binary.BigEndian.PutUint64(trailer[16:], uint64(rootIdx)) // top object index
	binary.BigEndian.PutUint64(trailer[24:], uint64(tableStart))
	return append(buf, trailer...)
}

type barray []int
type bdict struct {
	keys, vals []int
}

func ref2(i int) []byte { return []byte{byte(i >> 8), byte(i)} }

func encodeCount(marker byte, n int) []byte {
	if n < 15 {
		return []byte{marker | byte(n)}
	}
	// 0xf escape + int(8 bytes)
	b := []byte{marker | 0x0f, 0x13}
	var nb [8]byte
	binary.BigEndian.PutUint64(nb[:], uint64(n))
	return append(b, nb[:]...)
}

func encodeObj(o any) []byte {
	switch t := o.(type) {
	case bool:
		if t {
			return []byte{0x09}
		}
		return []byte{0x08}
	case int:
		return encodeInt(int64(t))
	case int64:
		return encodeInt(t)
	case uid:
		return []byte{0x80, byte(t)} // 1-byte uid
	case string:
		b := encodeCount(0x50, len(t))
		return append(b, []byte(t)...)
	case barray:
		b := encodeCount(0xa0, len(t))
		for _, r := range t {
			b = append(b, ref2(r)...)
		}
		return b
	case bdict:
		b := encodeCount(0xd0, len(t.keys))
		for _, r := range t.keys {
			b = append(b, ref2(r)...)
		}
		for _, r := range t.vals {
			b = append(b, ref2(r)...)
		}
		return b
	}
	panic("encodeObj: unsupported type")
}

func encodeInt(n int64) []byte {
	var nb [8]byte
	binary.BigEndian.PutUint64(nb[:], uint64(n))
	return append([]byte{0x13}, nb[:]...)
}

// keyedArchive wraps a scalar as NSKeyedArchiver stores it: $objects[1] is the
// value, $top.root points at it.
func keyedArchive(value any) []byte {
	return encodeBplist(map[string]any{
		"$archiver": "NSKeyedArchiver",
		"$version":  int64(100000),
		"$top":      map[string]any{"root": uid(1)},
		"$objects":  []any{"$null", value},
	})
}

// --- the Accounts4.sqlite fixture -----------------------------------------

func writeAccounts4(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec(t, db, `CREATE TABLE ZACCOUNTTYPE (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT)`)
	mustExec(t, db, `CREATE TABLE ZACCOUNT (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER TEXT, ZUSERNAME TEXT, ZACCOUNTDESCRIPTION TEXT, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER)`)
	mustExec(t, db, `CREATE TABLE ZACCOUNTPROPERTY (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZKEY TEXT, ZVALUE BLOB)`)

	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (1,'com.apple.account.IMAP')`)
	mustExec(t, db, `INSERT INTO ZACCOUNTTYPE VALUES (2,'com.apple.account.SMTP')`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (10,'IMAP-UUID','greta','Fastmail',1,NULL)`)
	mustExec(t, db, `INSERT INTO ZACCOUNT VALUES (20,'SMTP-UUID','greta','',2,NULL)`)

	prop := func(owner int64, key string, val any) {
		mustExec(t, db, `INSERT INTO ZACCOUNTPROPERTY (ZOWNER, ZKEY, ZVALUE) VALUES (?,?,?)`, owner, key, keyedArchive(val))
	}
	prop(10, "Hostname", "imap.fastmail.com")
	prop(10, "PortNumber", int64(993))
	prop(10, "SSLEnabled", true)
	prop(10, "SSLIsDirect", true)
	prop(10, "IdentityEmailAddress", "greta@fastmail.com")
	prop(10, "IdentityDisplayName", "Greta G")
	prop(10, "SendingAccountIdentifier", "SMTP-UUID")
	prop(20, "Hostname", "smtp.fastmail.com")
	prop(20, "PortNumber", int64(587))
	prop(20, "SSLEnabled", true)
	prop(20, "SSLIsDirect", false) // STARTTLS
}

func appleHome(t *testing.T) (home, accounts4 string) {
	t.Helper()
	home = t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "Library", "Mail"), 0o700); err != nil {
		t.Fatal(err)
	}
	accountsDir := filepath.Join(home, "Library", "Accounts")
	if err := os.MkdirAll(accountsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return home, filepath.Join(accountsDir, "Accounts4.sqlite")
}

func TestAppleMailParsesAccounts4(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Apple Mail import is macOS-only")
	}
	home, accounts4 := appleHome(t)
	writeAccounts4(t, accounts4)

	src := findSource(t, Sources(home), "apple_mail")
	if src.NeedsPermission != "" || src.Error != "" {
		t.Fatalf("unexpected permission/error: %+v", src)
	}
	if len(src.Accounts) != 1 {
		t.Fatalf("want 1 imap account, got %d: %+v", len(src.Accounts), src.Accounts)
	}
	a := src.Accounts[0]
	if a.Email != "greta@fastmail.com" || a.Name != "Greta G" || a.Username != "greta" {
		t.Errorf("identity wrong: %+v", a)
	}
	if a.IMAPHost != "imap.fastmail.com" || a.IMAPPort != 993 || a.IMAPTLS != "tls" {
		t.Errorf("imap wrong: %+v", a)
	}
	if a.SMTPHost != "smtp.fastmail.com" || a.SMTPPort != 587 || a.SMTPTLS != "starttls" {
		t.Errorf("smtp wrong: %+v", a)
	}
	if a.HasPassword {
		t.Error("Apple Mail passwords are never importable")
	}
	if _, ok := src.Password(a.Email); ok {
		t.Error("no Apple Mail password should be present")
	}
}

func TestAppleMailNeedsPermission(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Apple Mail import is macOS-only")
	}
	if os.Geteuid() == 0 {
		t.Skip("root can read a 0000 file; cannot simulate a permission denial")
	}
	home, accounts4 := appleHome(t)
	writeAccounts4(t, accounts4)
	if err := os.Chmod(accounts4, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(accounts4, 0o600) })

	src := findSource(t, Sources(home), "apple_mail")
	if src.NeedsPermission != "full_disk_access" {
		t.Fatalf("want needs_permission full_disk_access, got %+v", src)
	}
}

func TestAppleMailAbsentWhenNoMailDir(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Apple Mail import is macOS-only")
	}
	home := t.TempDir() // no ~/Library/Mail
	for _, s := range Sources(home) {
		if s.Kind == "apple_mail" {
			t.Fatal("Apple Mail should not appear without ~/Library/Mail")
		}
	}
}

// Decoder sanity: a keyed-archive scalar round-trips through parse+unarchive.
func TestBplistKeyedArchiveRoundTrip(t *testing.T) {
	for _, v := range []any{"hello", int64(993), true} {
		got := decodeProp(keyedArchive(v))
		switch want := v.(type) {
		case string:
			if got != want {
				t.Errorf("string: got %v want %v", got, want)
			}
		case int64:
			if got != want {
				t.Errorf("int: got %v want %v", got, want)
			}
		case bool:
			if got != want {
				t.Errorf("bool: got %v want %v", got, want)
			}
		}
	}
}
