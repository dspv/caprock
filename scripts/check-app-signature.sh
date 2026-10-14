#!/usr/bin/env bash
#
# Check how a built Caprock.app is signed, and print each binary's
# designated requirement: the rule macOS privacy settings (TCC) store with
# an answer and match the next build against.
#
#   scripts/check-app-signature.sh path/to/Caprock.app
#
# With APPLE_SIGNING_IDENTITY in the environment (set by
# scripts/macos-selfsign-keychain.sh), the app and both daemon binaries must
# be signed with that certificate, with the hardened runtime, and each
# requirement must be `identifier "…" and certificate leaf = H"…"`: the same
# for every build, so an answer survives updates. Without it they must be
# ad-hoc, as before, whose requirement is the cdhash and changes with every
# build. Reads the bundle only; raises no dialog.
#
set -euo pipefail

die() { echo "check-app-signature: $*" >&2; exit 1; }

APP="${1:-}"
[[ -d "$APP" ]] || die "usage: scripts/check-app-signature.sh path/to/Caprock.app"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
[[ "$IDENTITY" == "-" ]] && IDENTITY=""

codesign --verify --deep --strict "$APP" || die "the signature does not verify"

for bin in caprock-app caprock caprock-pty-host; do
  exe="$APP/Contents/MacOS/$bin"
  [[ -f "$exe" ]] || die "no $bin in $APP"
  info="$(codesign -dv --verbose=2 "$exe" 2>&1)"
  dr="$(codesign -d -r- "$exe" 2>&1 | sed -n 's/^.*designated => //p')"
  echo "  $bin: $dr"
  if [[ -n "$IDENTITY" ]]; then
    [[ "$info" != *"Signature=adhoc"* ]] || die "$bin is ad-hoc signed, expected $IDENTITY"
    [[ "$info" == *"(runtime)"* ]] || die "$bin is signed without the hardened runtime"
    # codesign quotes an identifier only when it is not a plain word.
    re='^identifier ("[^"]+"|[A-Za-z0-9._-]+) and certificate leaf = H"([0-9a-f]{40})"$'
    [[ "$dr" =~ $re ]] || die "$bin's designated requirement is not identifier + certificate leaf: $dr"
    leaf="${BASH_REMATCH[2]}"
    [[ "$leaf" == "$(tr 'A-F' 'a-f' <<<"$IDENTITY")" ]] || die "$bin is signed by $leaf, not $IDENTITY"
  else
    [[ "$info" == *"Signature=adhoc"* ]] || die "$bin is not ad-hoc signed and no APPLE_SIGNING_IDENTITY is set"
  fi
done

if [[ -n "$IDENTITY" ]]; then
  echo "  ok: app and daemon signed with the stable identity $IDENTITY (the requirement survives updates)"
else
  echo "  ok: ad-hoc signed (the requirement is the cdhash; macOS asks again after each update)"
fi
