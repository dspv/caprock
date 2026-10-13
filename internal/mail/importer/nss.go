package importer

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/des" //nolint:staticcheck // Thunderbird still writes 3DES login blobs; we must read them.
	"crypto/pbkdf2"
	"crypto/sha1" //nolint:gosec // NSS derives the key wrapping with SHA-1; not our choice.
	"crypto/sha256"
	"database/sql"
	"encoding/asn1"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// errPrimaryPassword means the profile has a primary (master) password set, so
// stored passwords cannot be decrypted without it. Settings still import.
var errPrimaryPassword = errors.New("thunderbird primary password is set")

// nssKey is a profile's decrypted master key, used to decrypt login entries.
type nssKey struct {
	key []byte
}

// --- ASN.1 shapes -----------------------------------------------------------

// pbeEntry is a key4.db PBES2 record (metaData.item2 and nssPrivate.a11).
type pbeEntry struct {
	Algo       pbes2Algo
	CipherText []byte
}
type pbes2Algo struct {
	Algo   asn1.ObjectIdentifier
	Params pbes2Params
}
type pbes2Params struct {
	KDF    kdfAlgo
	Cipher cipherAlgo
}
type kdfAlgo struct {
	Algo   asn1.ObjectIdentifier
	Params pbkdf2Params
}
type pbkdf2Params struct {
	Salt       []byte
	Iterations int
	KeyLength  int     `asn1:"optional"`
	PRF        prfAlgo `asn1:"optional"`
}
type prfAlgo struct {
	Algo asn1.ObjectIdentifier
}
type cipherAlgo struct {
	Algo asn1.ObjectIdentifier
	IV   []byte
}

// loginEntry is a logins.json encrypted value (base64-decoded).
type loginEntry struct {
	KeyID  []byte
	Cipher loginCipher
	CT     []byte
}
type loginCipher struct {
	Algo asn1.ObjectIdentifier
	IV   []byte
}

var (
	oidAES256CBC = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}
	oidDES3      = asn1.ObjectIdentifier{1, 2, 840, 113549, 3, 7}
	// ckaID is NSS's fixed key identifier for the login-encryption key.
	ckaID = []byte{0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}
)

// pkcs7strip removes PKCS#7 padding, tolerating a malformed tail.
func pkcs7strip(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	n := int(b[len(b)-1])
	if n <= 0 || n > len(b) {
		return b
	}
	return b[:len(b)-n]
}

// pbeKey derives the AES key that wraps a key4.db PBES2 record:
// key = PBKDF2-HMAC-SHA256( SHA1(globalSalt||masterPassword), entrySalt, iters, 32 ).
func pbeKey(globalSalt, masterPw, entrySalt []byte, iters int) ([]byte, error) {
	h := sha1.Sum(append(append([]byte{}, globalSalt...), masterPw...))
	return pbkdf2.Key(sha256.New, string(h[:]), entrySalt, iters, 32)
}

// decryptPBES2 unwraps a key4.db record. NSS prepends 0x04 0x0e to the stored
// 14-byte IV to form the 16-byte AES-CBC IV.
func decryptPBES2(der, globalSalt, masterPw []byte) ([]byte, error) {
	var e pbeEntry
	if _, err := asn1.Unmarshal(der, &e); err != nil {
		return nil, err
	}
	p := e.Algo.Params
	key, err := pbeKey(globalSalt, masterPw, p.KDF.Params.Salt, p.KDF.Params.Iterations)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	iv := append([]byte{0x04, 0x0e}, p.Cipher.IV...)
	if len(iv) != block.BlockSize() || len(e.CipherText)%block.BlockSize() != 0 {
		return nil, errors.New("key4.db: bad PBES2 block sizes")
	}
	out := make([]byte, len(e.CipherText))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, e.CipherText)
	return pkcs7strip(out), nil
}

// loadNSSKey opens a profile's key4.db and recovers its login-encryption key.
// An empty masterPassword is the common case (no primary password set).
func loadNSSKey(key4Path, masterPassword string) (*nssKey, error) {
	db, err := sql.Open("sqlite", "file:"+key4Path+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	var globalSalt, item2 []byte
	err = db.QueryRow(`SELECT item1, item2 FROM metadata WHERE id = 'password'`).Scan(&globalSalt, &item2)
	if err != nil {
		return nil, fmt.Errorf("key4.db metadata: %w", err)
	}
	// Validate the password against the 'password-check' sentinel.
	check, err := decryptPBES2(item2, globalSalt, []byte(masterPassword))
	if err != nil || !bytes.HasPrefix(check, []byte("password-check")) {
		return nil, errPrimaryPassword
	}

	rows, err := db.Query(`SELECT a11, a102 FROM nssPrivate WHERE a11 IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("key4.db nssPrivate: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var a11, a102 []byte
		if err := rows.Scan(&a11, &a102); err != nil {
			return nil, err
		}
		if !bytes.Equal(a102, ckaID) {
			continue
		}
		key, err := decryptPBES2(a11, globalSalt, []byte(masterPassword))
		if err != nil {
			return nil, err
		}
		if len(key) < 24 {
			return nil, errors.New("key4.db: master key too short")
		}
		return &nssKey{key: key}, nil
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("key4.db: no login-encryption key")
}

// decrypt recovers a logins.json encrypted value (already base64-decoded).
func (k *nssKey) decrypt(der []byte) (string, error) {
	var e loginEntry
	if _, err := asn1.Unmarshal(der, &e); err != nil {
		return "", err
	}
	switch {
	case e.Cipher.Algo.Equal(oidDES3):
		block, err := des.NewTripleDESCipher(k.key[:24])
		if err != nil {
			return "", err
		}
		if len(e.CT)%block.BlockSize() != 0 || len(e.Cipher.IV) != block.BlockSize() {
			return "", errors.New("logins: bad 3DES block sizes")
		}
		out := make([]byte, len(e.CT))
		cipher.NewCBCDecrypter(block, e.Cipher.IV).CryptBlocks(out, e.CT)
		return string(pkcs7strip(out)), nil
	case e.Cipher.Algo.Equal(oidAES256CBC):
		if len(k.key) < 32 {
			return "", errors.New("logins: AES key too short")
		}
		block, err := aes.NewCipher(k.key[:32])
		if err != nil {
			return "", err
		}
		if len(e.CT)%block.BlockSize() != 0 || len(e.Cipher.IV) != block.BlockSize() {
			return "", errors.New("logins: bad AES block sizes")
		}
		out := make([]byte, len(e.CT))
		cipher.NewCBCDecrypter(block, e.Cipher.IV).CryptBlocks(out, e.CT)
		return string(pkcs7strip(out)), nil
	default:
		return "", fmt.Errorf("logins: unsupported cipher %v", e.Cipher.Algo)
	}
}
