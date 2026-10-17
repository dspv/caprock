package brain

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTLDRShortCountsRunesNotBytes(t *testing.T) {
	if !TLDRShort(strings.Repeat("é", TLDRShortRunes-1)) {
		t.Error("279 accented letters are 558 bytes and still short")
	}
	if TLDRShort(strings.Repeat("a", TLDRShortRunes)) {
		t.Error("280 letters are long enough to squeeze")
	}
	if !TLDRShort("  short  \n") {
		t.Error("short")
	}
}

func TestTLDRInputKeepsTheHeadAndTheTail(t *testing.T) {
	short := strings.Repeat("x", TLDRMaxInputChars)
	if TLDRInput(short) != short {
		t.Error("an answer that fits is sent whole")
	}
	long := "START " + strings.Repeat("東京タワー ", 5000) + " END"
	in := TLDRInput(long)
	if !utf8.ValidString(in) {
		t.Fatal("cut inside a rune")
	}
	if !strings.HasPrefix(in, "START ") || !strings.HasSuffix(in, " END") || !strings.Contains(in, TLDRGap) {
		t.Errorf("head, gap and tail: %q … %q", in[:20], in[len(in)-20:])
	}
	if n := utf8.RuneCountInString(in) - utf8.RuneCountInString(TLDRGap) - 4; n != TLDRMaxInputChars {
		t.Errorf("sent %d runes of the answer, want %d", n, TLDRMaxInputChars)
	}
}

func TestCleanTLDR(t *testing.T) {
	for in, want := range map[string]string{
		"TL;DR: Kept SQLite.\nNext: ship it.": "Kept SQLite. Next: ship it.",
		`"Kept SQLite."`:                      "Kept SQLite.",
		"«Garder SQLite.»":                    "Garder SQLite.",
		"  plain  ":                           "plain",
	} {
		if got := cleanTLDR(in); got != want {
			t.Errorf("cleanTLDR(%q) = %q, want %q", in, got, want)
		}
	}
	if n := utf8.RuneCountInString(cleanTLDR(strings.Repeat("ü", 1000))); n > TLDRMaxRunes+1 {
		t.Errorf("clipped to %d runes", n)
	}
}

func TestSqueezeAsksForPlainTextFromTheCheapestModel(t *testing.T) {
	var got Request
	r := RunnerFunc(func(_ context.Context, req Request) (Result, error) {
		got = req
		return Result{Text: "TL;DR: Kept SQLite in WAL mode; next, ship 0.128.", Model: "claude-haiku-5-5", CostUSD: 0.001}, nil
	})
	res, err := Squeeze(context.Background(), r, strings.Repeat("A long answer. ", 40))
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "Kept SQLite in WAL mode; next, ship 0.128." || res.Model != "claude-haiku-5-5" || res.CostUSD != 0.001 {
		t.Errorf("%+v", res)
	}
	if !got.Plain || got.Model != "haiku" || got.System != TLDRSystem || !strings.Contains(got.Prompt, "A long answer.") {
		t.Errorf("request %+v", got)
	}
	empty := RunnerFunc(func(context.Context, Request) (Result, error) { return Result{Text: "  "}, nil })
	if _, err := Squeeze(context.Background(), empty, "x"); !errors.Is(err, ErrTLDREmpty) {
		t.Errorf("an empty answer: %v", err)
	}
	none := RunnerFunc(func(context.Context, Request) (Result, error) { return Result{}, ErrNoClaude })
	if _, err := Squeeze(context.Background(), none, "x"); !errors.Is(err, ErrNoClaude) {
		t.Errorf("no claude: %v", err)
	}
}

func TestArgvForAPlainRequest(t *testing.T) {
	args, stdin := Argv(Request{System: "sys", Prompt: "the answer", Model: "haiku", Plain: true}, "/d/settings.json", false)
	if slices.Contains(args, "--json-schema") {
		t.Errorf("a plain request asks for no schema: %v", args)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"-p", "--output-format json", "--no-session-persistence", "--setting-sources local", "--model haiku", "--system-prompt sys"} {
		if !strings.Contains(joined, want) {
			t.Errorf("argv lacks %q: %v", want, args)
		}
	}
	if i := slices.Index(args, "--tools"); i < 0 || args[i+1] != "" {
		t.Errorf("--tools must be given an empty list: %v", args)
	}
	if stdin != "the answer" {
		t.Errorf("stdin = %q", stdin)
	}
	args, stdin = Argv(Request{System: "sys", Prompt: "the answer", Plain: true}, "/d/settings.json", true)
	if slices.Contains(args, "--system-prompt") || strings.Contains(stdin, Schema) || stdin != "sys\n\nthe answer" {
		t.Errorf("batch: %v %q", args, stdin)
	}
}

func TestParseText(t *testing.T) {
	r, err := ParseText([]byte(`{"is_error":false,"result":"Kept SQLite.","total_cost_usd":0.0004,"usage":{"input_tokens":3,"cache_creation_input_tokens":900,"output_tokens":20},"modelUsage":{"claude-haiku-5-5":{}}}`))
	if err != nil || r.Text != "Kept SQLite." || r.TokensIn != 903 || r.TokensOut != 20 || r.CostUSD != 0.0004 || r.Model != "claude-haiku-5-5" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := ParseText([]byte(`{"is_error":true,"subtype":"error_during_execution","result":"Invalid API key"}`)); err == nil || !strings.Contains(err.Error(), "Invalid API key") {
		t.Errorf("an error result: %v", err)
	}
}
