#!/bin/sh
# Builds Kong's config from the template (render.sh), then starts Kong.
#
# Phase 11: the gateway gets only identity's PUBLIC keys (IDENTITY_PUBLIC_KEYS, written by
# infra/identity/new-signing-key.mjs). With them Kong can check a token, never create one.
set -eu
sh /kong/render.sh /tmp/kong.yml
exec /docker-entrypoint.sh kong docker-start
