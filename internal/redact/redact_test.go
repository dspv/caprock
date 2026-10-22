package redact

import (
	"strings"
	"testing"
)

// Every value below is fake: test cards, a made-up key, the IBAN from the
// ECBS examples. None of them works anywhere.

func TestTextRedactsWhatItShould(t *testing.T) {
	cases := []struct {
		name, in, kind, gone string
	}{
		{"anthropic key", "the key is sk-ant-api03-AbCdEf0123456789xyzXYZ_abcdEFGH", KindAPIKey, "sk-ant-api03"},
		{"openai project key", "export OPENAI_API_KEY=sk-proj-9fK2mQ7xL0pR4tY8wZ1vB3nH", KindAPIKey, "sk-proj-9fK2"},
		{"stripe", "use sk_" + "test_FAKEfake0123456789abcd for the sandbox", KindAPIKey, "FAKEfake0123"},
		{"aws", "access key AKIAQ3EGUKZ7FAKEFAKE in the table", KindAPIKey, "AKIAQ3EGUKZ7"},
		{"google", "AIzaSyD-FAKEfake0123456789abcdefghijklm is the maps key", KindAPIKey, "AIzaSyD"},
		{"github classic", "push with ghp_FAKE0123456789abcdefghijklmnopqrstuv", KindToken, "ghp_FAKE"},
		{"github fine-grained", "github_pat_11FAKE0000_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH", KindToken, "github_pat_11"},
		{"slack", "xoxb-1234567890-0987654321-FAKEfakeFAKE", KindToken, "xoxb-12345"},
		{"telegram bot", "bot token 1234567890:AAFakeFakeFakeFakeFakeFakeFakeFake1 works", KindToken, "AAFakeFake"},
		{"jwt", "Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", KindToken, "eyJhbGci"},
		{"bearer", "curl -H 'Authorization: Bearer abc123DEF456ghi789JKL012mno'", KindToken, "abc123DEF456"},
		{"pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake\nfakefake==\n-----END RSA PRIVATE KEY-----", KindPrivateKey, "MIIEow"},
		{"pem cut by a clip", "key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA", KindPrivateKey, "b3BlbnNz"},
		{"visa spaced", "card 4242 4242 4242 4242 exp 12/30", KindCard, "4242 4242"},
		{"visa dashed", "card 4242-4242-4242-4242", KindCard, "4242-4242"},
		{"mastercard run together", "paid with 5555555555554444 yesterday", KindCard, "5555555555554444"},
		{"amex", "amex 3782 822463 10005", KindCard, "3782 822463"},
		{"mir", "card 2200 0000 0000 0004", KindCard, "2200 0000"},
		{"iban grouped", "IBAN: DE89 3704 0044 0532 0130 00 for the transfer", KindIBAN, "3704 0044"},
		{"iban run together", "send to GB82WEST12345698765432 today", KindIBAN, "GB82WEST"},
		{"password colon", "password: hunter2!", KindPassword, "hunter2"},
		{"password equals", "DB_PASSWORD=Sup3rS3cret", KindPassword, "Sup3rS3cret"},
		{"password is", "the wifi password is tr0ub4dor&3", KindPassword, "tr0ub4dor"},
		{"password in backquotes", "login `demo@example.com`, password `correct9horse`", KindPassword, "correct9horse"},
		{"pin-like password", "pwd: 482913", KindPassword, "482913"},
		{"russian password label", "пароль: Qwerty123", KindPassword, "Qwerty123"},
		{"labelled hex secret", "webhook secret: 3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e", KindSecret, "3f9a1c7e"},
		{"labelled api key", "Dev.to API key: `Ab3dEf6hIj9kLm2nOp5qRs8t`", KindSecret, "Ab3dEf6h"},
		{"labelled token", "token=Zm9vYmFyYmF6cXV4MTIzNDU2", KindSecret, "Zm9vYmFy"},
		{"account number", "account number: 12345678", KindBankAccount, "12345678"},
		{"routing number", "routing # 021000021", KindBankAccount, "021000021"},
		{"sort code", "sort code 12-34-56, acct 31926819", KindBankAccount, "31926819"},
		{"russian settlement account", "р/с 40817810099910004312", KindBankAccount, "40817810099910004312"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, counts := Text(c.in)
			if strings.Contains(out, c.gone) {
				t.Fatalf("%q still holds %q: %q", c.in, c.gone, out)
			}
			if !strings.Contains(out, Placeholder(c.kind)) || counts[c.kind] == 0 {
				t.Fatalf("%q: want a %q placeholder, got %q (%v)", c.in, c.kind, out, counts)
			}
		})
	}
}

func TestTextLeavesOrdinaryTextAlone(t *testing.T) {
	keep := []string{
		"Commit 3ce9d978a1b2c3d4e5f60718293a4b5c6d7e8f90 rebuilt the dashboard",
		"short sha 8ce675d0 and 14ba7c75",
		"session 0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a ended",
		"released v0.149.0 after 0.148.2; go 1.26.0",
		"costs $30/year or $100 once; 1,234,567 tokens at $3.75 per million",
		"started at 1729600000000 ms (unix), pid 48213",
		"order 1234567812345678 failed Luhn",                     // 16 digits, Luhn fails
		"4242 4242 4242 4241 is one digit off",                   // Luhn fails
		"phone +1 415 555 2671, fax 020 7946 0958",               // too short for a card
		"GB00WEST12345698765432 has a bad checksum",              // IBAN mod 97 fails
		"DE89 is a check digit pair, nothing more",               // too short
		"the password field is required",                         // a word, not a value
		"password: required",                                     // placeholder
		"password=${DB_PASSWORD} from the env",                   // a variable
		"PASSWORD: <your-password>",                              // a placeholder
		"password: process.env.DB_PASSWORD",                      // code
		"aws ecr get-login-password --region us-east-1",          // a command
		"authenticate(form['login'], password=pwd_hash)",         // an identifier
		"password-protected PDFs and password reset links",       // prose
		"app password: https://appleid.apple.com/account/manage", // a URL
		"pwd: /Users/me/dev/caprock",                             // a path
		"token: 1500 per read, tokens_in 24000",                  // counts
		"api key: OPENAI_API_KEY_V2",                             // an env var's name
		"secret: stripe-webhook-secret-v2",                       // a name
		"api_key: config.brain.api_key_2",                        // a dotted name
		"account for 30% of spend; account 2 of 5",               // prose
		"the task-notification-handler-component-v2 broke",       // sk- inside a word
		"sk-learn and sk-skeleton-loader-wrapper classes",        // no digits
		"AKIAIOSFODNN7EXAMPLE is AWS's documented example",       // a docs example
		"re-checks are due 2026-11-05 and 2026-11-19",            // dates
		"κωδικός: password is μυστικό",                           // a Greek word
	}
	for _, s := range keep {
		out, counts := Text(s)
		if out != s || counts.Total() != 0 {
			t.Errorf("changed ordinary text %q → %q (%v)", s, out, counts)
		}
	}
}

func TestTextIsIdempotentAndCounts(t *testing.T) {
	in := "card 4242 4242 4242 4242, password: hunter2!, key sk-ant-api03-AbCdEf0123456789xyzXYZ_abcd"
	once, c1 := Text(in)
	if c1[KindCard] != 1 || c1[KindPassword] != 1 || c1[KindAPIKey] != 1 || c1.Total() != 3 {
		t.Fatalf("counts %v", c1)
	}
	twice, c2 := Text(once)
	if twice != once || c2.Total() != 0 {
		t.Fatalf("second pass changed it: %q → %q (%v)", once, twice, c2)
	}
	if got := c1.String(); got != "api_key=1 card_number=1 password=1" {
		t.Fatalf("String() = %q", got)
	}
}

func TestStrings(t *testing.T) {
	out, c := Strings([]string{"billing", "4242424242424242", "sqlite"})
	if out[0] != "billing" || out[1] != Placeholder(KindCard) || out[2] != "sqlite" || c[KindCard] != 1 {
		t.Fatalf("%v %v", out, c)
	}
	if _, c := Strings([]string{"a", "b"}); c != nil {
		t.Fatalf("clean input counted %v", c)
	}
}
