#!/bin/sh
# Writes Kong's config ($1, default /tmp/kong.yml) from the template, with one jwt credential per public key in
# IDENTITY_PUBLIC_KEYS ("kid:<base64 PEM>,kid:<base64 PEM>"): key = the key id, RS256, the PEM.
#
# Used at start (start.sh) and for a key rotation WITHOUT restarting Kong (E14d):
#   docker exec -e IDENTITY_PUBLIC_KEYS="<new list>" scalecart-gateway-1 sh /kong/render.sh /tmp/kong-new.yml
#   docker exec scalecart-gateway-1 resty /kong/reload.lua /tmp/kong-new.yml
set -eu
: "${IDENTITY_PUBLIC_KEYS:?IDENTITY_PUBLIC_KEYS is required (node infra/identity/new-signing-key.mjs)}"
out="${1:-/tmp/kong.yml}"

creds=$(mktemp)
for item in $(echo "$IDENTITY_PUBLIC_KEYS" | tr ',' ' '); do
  kid="${item%%:*}"
  {
    echo "      - key: '$kid'"
    echo "        algorithm: RS256"
    echo "        rsa_public_key: |"
    echo "${item#*:}" | base64 -d | sed 's/^/          /'
  } >> "$creds"
done

# Copy the template, putting the credentials where __JWT_CREDENTIALS__ stands.
awk -v creds="$creds" '
  $0 == "__JWT_CREDENTIALS__" { while ((getline line < creds) > 0) print line; next }
  { print }
' /kong/kong.template.yml > "$out"
rm -f "$creds"
