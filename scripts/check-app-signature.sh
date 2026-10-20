#!/usr/bin/env bash
#
# Check how a built Caprock.app is signed, and print each binary's
# designated requirement: the rule macOS privacy settings (TCC) store with
# an answer and match the next build against.
#
#   scripts/check-app-signature.sh path/to/Caprock.app [--notarized]
#
# What it expects follows APPLE_SIGNING_IDENTITY in the environment:
#
# - "Developer ID Application: <Company> (<TEAMID>)" (release.yml, set by
#   scripts/macos-developer-id.sh): the app and both daemon binaries signed by
#   a Developer ID Application certificate, with the hardened runtime and a
#   secure timestamp (notarization refuses either missing), and each
#   requirement `identifier … and anchor apple generic and … certificate
#   leaf[subject.OU] = <TEAMID>`: the same for every build. With APPLE_TEAM_ID
#   set, the team must be that one. With --notarized, the app must also carry
#   a stapled notarization ticket and Gatekeeper must accept it.
# - A certificate SHA-1 (the self-signed fallback, set by
#   scripts/macos-selfsign-keychain.sh): signed with that certificate, with
#   the hardened runtime, each requirement `identifier "…" and certificate
#   leaf = H"…"`.
# - Unset: ad-hoc, as before, whose requirement is the cdhash and changes
#   with every build.
#
# Reads the bundle only; raises no dialog (spctl --assess and stapler
# validate only read).
#
set -euo pipefail

die() { echo "check-app-signature: $*" >&2; exit 1; }

APP="${1:-}"
[[ -d "$APP" ]] || die "usage: scripts/check-app-signature.sh path/to/Caprock.app [--notarized]"
NOTARIZED=0
[[ "${2:-}" == --notarized ]] && NOTARIZED=1
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
[[ "$IDENTITY" == "-" ]] && IDENTITY=""
MODE=adhoc
if [[ "$IDENTITY" == "Developer ID Application: "* ]]; then
  MODE=devid
  TEAM="${APPLE_TEAM_ID:-}"
  if [[ -z "$TEAM" && "$IDENTITY" =~ \(([A-Z0-9]{10})\)$ ]]; then TEAM="${BASH_REMATCH[1]}"; fi
elif [[ -n "$IDENTITY" ]]; then
  MODE=selfsigned
fi
[[ "$NOTARIZED" == 0 || "$MODE" == devid ]] || die "--notarized needs a Developer ID in APPLE_SIGNING_IDENTITY"

codesign --verify --deep --strict "$APP" || die "the signature does not verify"

for bin in caprock-app caprock caprock-pty-host; do
  exe="$APP/Contents/MacOS/$bin"
  [[ -f "$exe" ]] || die "no $bin in $APP"
  info="$(codesign -dv --verbose=2 "$exe" 2>&1)"
  dr="$(codesign -d -r- "$exe" 2>&1 | sed -n 's/^.*designated => //p')"
  echo "  $bin: $dr"
  if [[ "$MODE" == devid ]]; then
    [[ "$info" == *"Authority=Developer ID Application: "* ]] || die "$bin is not signed by a Developer ID Application certificate"
    [[ "$info" == *"(runtime)"* ]] || die "$bin is signed without the hardened runtime"
    # A secure timestamp prints Timestamp=; without one codesign prints
    # "Signed Time=" or nothing, and notarization refuses the binary.
    [[ "$info" == *$'\nTimestamp='* ]] || die "$bin has no secure timestamp (codesign --timestamp)"
    [[ "$dr" == *"anchor apple generic"* ]] || die "$bin's designated requirement is not anchored at Apple: $dr"
    re='certificate leaf\[subject\.OU\] = "?([A-Z0-9]+)"?'
    [[ "$dr" =~ $re ]] || die "$bin's designated requirement names no team: $dr"
    if [[ -n "$TEAM" ]]; then
      [[ "${BASH_REMATCH[1]}" == "$TEAM" ]] || die "$bin is signed by team ${BASH_REMATCH[1]}, not $TEAM"
      [[ "$info" == *"TeamIdentifier=$TEAM"* ]] || die "$bin's TeamIdentifier is not $TEAM"
    fi
  elif [[ "$MODE" == selfsigned ]]; then
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

if [[ "$NOTARIZED" == 1 ]]; then
  xcrun stapler validate -q "$APP" || die "no notarization ticket stapled to $APP"
  assess="$(spctl --assess --type execute -vv "$APP" 2>&1)" || die "Gatekeeper rejects $APP: $assess"
  [[ "$assess" == *"source=Notarized Developer ID"* ]] || die "Gatekeeper does not see a notarized app: $assess"
fi

if [[ "$MODE" == devid ]]; then
  stapled=", not notarized"
  [[ "$NOTARIZED" == 1 ]] && stapled=", notarized and stapled"
  echo "  ok: app and daemon signed with the Developer ID of team ${TEAM:-?}$stapled"
elif [[ "$MODE" == selfsigned ]]; then
  echo "  ok: app and daemon signed with the stable identity $IDENTITY (the requirement survives updates)"
else
  echo "  ok: ad-hoc signed (the requirement is the cdhash; macOS asks again after each update)"
fi
