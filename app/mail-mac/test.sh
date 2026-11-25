#!/bin/sh
# Checks the Mac preview's navigation rule (policy.swift) without building or
# opening the app: compiled with swiftc, run, removed. Needs the Xcode command
# line tools. build.sh runs it first.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# swiftc wants the top-level code in main.swift.
cp policy_test.swift "$tmp/main.swift"
swiftc -o "$tmp/policy-test" policy.swift "$tmp/main.swift"
"$tmp/policy-test"
