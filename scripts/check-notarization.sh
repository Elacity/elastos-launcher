#!/bin/bash
# Check notarization status and optionally staple artifacts.
#
# Usage:
#   # First time: store credentials in keychain
#   xcrun notarytool store-credentials "ElastOS" \
#     --apple-id "sasha@elacity.com" \
#     --team-id "LA64G2ZMY2" \
#     --password "<app-specific-password>"
#
#   # Check a specific submission
#   ./scripts/check-notarization.sh status <UUID>
#
#   # Check all recent submissions
#   ./scripts/check-notarization.sh history
#
#   # Staple a notarized artifact
#   ./scripts/check-notarization.sh staple dist-electron/ElastOS-1.2.2-arm64.dmg
#
# Known submission UUIDs (v1.2.2):
#   DMG: 2434db22-0281-4c30-8cca-233532630fde
#   ZIP: 3f2d210a-a22f-4db3-9f8e-e0e6b1e3e6e7

PROFILE="${NOTARY_PROFILE:-ElastOS}"

case "${1}" in
  status)
    if [ -z "$2" ]; then echo "Usage: $0 status <UUID>"; exit 1; fi
    xcrun notarytool info "$2" --keychain-profile "$PROFILE"
    ;;
  log)
    if [ -z "$2" ]; then echo "Usage: $0 log <UUID>"; exit 1; fi
    xcrun notarytool log "$2" --keychain-profile "$PROFILE"
    ;;
  history)
    xcrun notarytool history --keychain-profile "$PROFILE"
    ;;
  staple)
    if [ -z "$2" ]; then echo "Usage: $0 staple <artifact-path>"; exit 1; fi
    xcrun stapler staple "$2"
    ;;
  *)
    echo "Usage: $0 {status|log|history|staple} [arg]"
    echo ""
    echo "Commands:"
    echo "  status <UUID>   Check notarization status"
    echo "  log <UUID>      Download notarization log"
    echo "  history         List recent submissions"
    echo "  staple <path>   Staple ticket to artifact"
    echo ""
    echo "First, store credentials:"
    echo "  xcrun notarytool store-credentials \"$PROFILE\" \\"
    echo "    --apple-id \"sasha@elacity.com\" \\"
    echo "    --team-id \"LA64G2ZMY2\" \\"
    echo "    --password \"<app-specific-password>\""
    ;;
esac
