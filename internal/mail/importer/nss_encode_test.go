package importer

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/des" //nolint:staticcheck // the test writes the 3DES blobs the decoder must read.
	"encoding/asn1"
	"testing"
)

// These helpers write the key4.db / logins.json crypto so the tests can
// round-trip the decoder against values it encrypted itself. They mirror
// Thunderbird's on-disk format (NSS PBES2 wrapping + 3DES/AES login entries).

func pkcs7pad(b []byte, block int) []byte {
	n := block - len(b)%block
	return append(append([]byte{}, b...), bytes.Repeat([]byte{byte(n)}, n)...)
}

// encodePBES2 produces a key4.db record: AES-256-CBC(plain) wrapped as PBES2.
func encodePBES2(t *testing.T, plain, globalSalt, masterPw, entrySalt, iv14 []byte, iters int) []byte {
	t.Helper()
	key, err := pbeKey(globalSalt, masterPw, entrySalt, iters)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	iv := append([]byte{0x04, 0x0e}, iv14...)
	p := pkcs7pad(plain, 16)
	ct := make([]byte, len(p))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, p)
	der, err := asn1.Marshal(pbeEntry{
		Algo: pbes2Algo{Algo: oidPBES2, Params: pbes2Params{
			KDF:    kdfAlgo{Algo: oidPBKDF2, Params: pbkdf2Params{Salt: entrySalt, Iterations: iters, KeyLength: 32, PRF: prfAlgo{Algo: oidHMACSHA256}}},
			Cipher: cipherAlgo{Algo: oidAES256CBC, IV: iv14},
		}},
		CipherText: ct,
	})
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func encodeLogin3DES(t *testing.T, plain, masterKey, iv8 []byte) []byte {
	t.Helper()
	block, err := des.NewTripleDESCipher(masterKey[:24])
	if err != nil {
		t.Fatal(err)
	}
	p := pkcs7pad(plain, 8)
	ct := make([]byte, len(p))
	cipher.NewCBCEncrypter(block, iv8).CryptBlocks(ct, p)
	der, err := asn1.Marshal(loginEntry{KeyID: ckaID, Cipher: loginCipher{Algo: oidDES3, IV: iv8}, CT: ct})
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func encodeLoginAES(t *testing.T, plain, masterKey, iv16 []byte) []byte {
	t.Helper()
	block, _ := aes.NewCipher(masterKey[:32])
	p := pkcs7pad(plain, 16)
	ct := make([]byte, len(p))
	cipher.NewCBCEncrypter(block, iv16).CryptBlocks(ct, p)
	der, err := asn1.Marshal(loginEntry{KeyID: ckaID, Cipher: loginCipher{Algo: oidAES256CBC, IV: iv16}, CT: ct})
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// oid helpers shared only by the encoders.
var (
	oidPBES2      = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 13}
	oidPBKDF2     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 12}
	oidHMACSHA256 = asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 9}
)
