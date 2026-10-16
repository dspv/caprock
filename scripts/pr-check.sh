#!/usr/bin/env bash
# pr-check: the cheap gate before a pull request is opened (`make pr-check`).
#
# It runs what CI catches most often in a fresh branch, on what the branch
# changed, in about the time a targeted test run takes:
#
#   - Go packages changed against origin/master: go vet, go test -race once,
#     and the tests in the changed _test.go files -count=3 more (data races
#     and timing-dependent tests show up here, not in one plain run on a Mac;
#     CI does not run -race at all);
#   - Windows: GOOS=windows go vet ./..., and the changed packages' tests
#     compiled for Windows (a path or syscall that only builds on Unix);
#   - the dashboard, when ui/ changed: typecheck, and the whole vitest suite
#     (#705 changed the sidebar and broke SidebarClose.test.tsx, a test it
#     never touched, and only CI saw it);
#   - the language gate (no Cyrillic), which costs a second.
#
# It is not `make check`: no smoke, no golangci-lint, no full Go suite. `make
# check` stays the full gate; CI runs both halves on three OSes.
#
# Environment: PR_CHECK_BASE overrides the base (default: the merge base with
# origin/master); PR_CHECK_COUNT overrides -count (default 3).
set -euo pipefail

root=$(git rev-parse --show-toplevel)
count=${PR_CHECK_COUNT:-3}

# A stale origin/master would test the branch against the wrong base; a
# failed fetch (offline) is not fatal.
git -C "$root" fetch -q origin master 2>/dev/null || echo "pr-check: could not fetch origin/master; using the local copy"
base=${PR_CHECK_BASE:-$(git -C "$root" merge-base HEAD origin/master)}

# What changed: commits since the base, uncommitted edits and new files.
changed=$( {
	git -C "$root" diff --name-only "$base" --
	git -C "$root" ls-files --others --exclude-standard
} | sort -u)

step() { printf '\n== %s\n' "$*"; }
ok=1
fail() { echo "pr-check: FAILED: $*"; ok=0; }

# --- Go -------------------------------------------------------------------
gofiles=$(echo "$changed" | grep -E '\.go$' | grep -v '^internal/api/dist/' || true)
pkgs=""
smoke_tests=""
if echo "$changed" | grep -qE '^(go\.mod|go\.sum)$'; then
	pkgs="./..."
else
	for f in $gofiles; do
		[ -f "$root/$f" ] || continue # deleted
		d=$(dirname "$f")
		case "$d" in
		internal/smoke | internal/smoke/*)
			# Smoke files build only with -tags smoke and each test starts a
			# daemon: run just the tests the changed files define.
			smoke_tests="$smoke_tests $(sed -n 's/^func \(Test[A-Za-z0-9_]*\)(t \*testing\.T).*/\1/p' "$root/$f")"
			continue
			;;
		esac
		pkgs="$pkgs ./$d"
	done
	pkgs=$(echo "$pkgs" | tr ' ' '\n' | sort -u | tr '\n' ' ')
fi

smoke_tests=$(echo "$smoke_tests" | tr ' ' '\n' | grep . | sort -u | paste -sd '|' - || true)

# -race needs cgo and a C compiler; the Makefile turns cgo off for builds.
race="-race"
if ! command -v "$(go env CC)" >/dev/null 2>&1; then
	race=""
	echo "pr-check: no C compiler ($(go env CC)) here, so no -race; CI runs without it too"
fi

if [ -n "${pkgs// /}" ]; then
	step "go vet:$pkgs"
	go -C "$root" vet $pkgs || fail "go vet"
	step "go test $race:$pkgs"
	CGO_ENABLED=1 go -C "$root" test $race -count=1 $pkgs || fail "go test"
	# The tests the change wrote or touched, again: a test that passes once
	# and fails one run in three is the flake CI would find for you.
	for d in $pkgs; do
		[ "$d" = "./..." ] && continue
		names=""
		for f in $(echo "$gofiles" | grep -E "^${d#./}/[^/]*_test\.go\$" || true); do
			[ -f "$root/$f" ] && names="$names $(sed -n 's/^func \(Test[A-Za-z0-9_]*\)(t \*testing\.T).*/\1/p' "$root/$f")"
		done
		names=$(echo "$names" | tr ' ' '\n' | grep . | sort -u | paste -sd '|' - || true)
		[ -n "$names" ] || continue
		step "go test $race -count=$count, the changed tests of $d"
		CGO_ENABLED=1 go -C "$root" test $race -count="$count" -run "^($names)\$" "$d" || fail "go test -count=$count $d"
	done
fi

if [ -n "$smoke_tests" ]; then
	step "smoke tests the change defines: $smoke_tests"
	go -C "$root" vet -tags smoke ./internal/smoke/ || fail "go vet -tags smoke"
	CGO_ENABLED=1 go -C "$root" test -tags smoke $race -count=1 -run "^($smoke_tests)\$" ./internal/smoke/ || fail "smoke tests"
fi

if [ -n "${pkgs// /}" ] || [ -n "$smoke_tests" ]; then
	step "Windows: go vet ./... and the changed packages' tests compiled"
	GOOS=windows go -C "$root" vet ./... || fail "GOOS=windows go vet"
	out=$(mktemp -d)
	trap 'rm -rf "$out"' EXIT
	# -o into a directory: one test binary per package, none of them run.
	if [ -n "${pkgs// /}" ]; then
		GOOS=windows CGO_ENABLED=0 go -C "$root" test -c -o "$out/" $pkgs >/dev/null || fail "GOOS=windows go test -c"
	fi
	if [ -n "$smoke_tests" ]; then
		GOOS=windows CGO_ENABLED=0 go -C "$root" vet -tags smoke ./internal/smoke/ || fail "GOOS=windows go vet -tags smoke"
	fi
else
	step "Go: nothing changed"
fi

# --- dashboard ------------------------------------------------------------
if echo "$changed" | grep -q '^ui/'; then
	if [ ! -d "$root/ui/node_modules" ]; then
		step "ui: npm ci"
		npm --prefix "$root/ui" ci --no-audit --no-fund >/dev/null || fail "npm ci"
	fi
	step "ui: typecheck"
	(cd "$root/ui" && npm run -s typecheck) || fail "ui typecheck"
	# All of it, not the changed test files: a component's change breaks the
	# tests of whatever renders it. vitest's --changed follows imports, and
	# a test can depend on what it does not import (a stylesheet, a fixture
	# read from disk, a module mocked away); the whole suite costs minutes.
	step "ui: vitest, the whole suite"
	(cd "$root/ui" && npx vitest run) || fail "vitest"
fi

# --- language -------------------------------------------------------------
step "language: no Cyrillic"
(cd "$root" && python3 scripts/check-no-cyrillic.py) || fail "lang-check"

if [ "$ok" = 1 ]; then
	printf '\npr-check: green. Open the pull request; CI runs the full matrix.\n'
else
	printf '\npr-check: red. Fix the above before opening the pull request.\n'
	exit 1
fi
