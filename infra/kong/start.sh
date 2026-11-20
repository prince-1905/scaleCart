#!/bin/sh
# Builds Kong's config from the template (filling in JWT_SECRET from the environment), then starts Kong.
# awk with index/substr copies the secret literally: no characters in it are treated as special.
set -eu
: "${JWT_SECRET:?JWT_SECRET is required}"
awk '{
  while ((i = index($0, "__JWT_SECRET__")) > 0) $0 = substr($0, 1, i - 1) ENVIRON["JWT_SECRET"] substr($0, i + 14)
  print
}' /kong/kong.template.yml > /tmp/kong.yml
exec /docker-entrypoint.sh kong docker-start
