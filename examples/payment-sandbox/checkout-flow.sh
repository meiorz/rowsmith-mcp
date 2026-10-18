#!/usr/bin/env bash
# A checkout test against the Rowsmith payment sandbox: one charge that succeeds, one that is declined.
# The sandbox moves no money and contacts no payment provider; it is deleted 1 hour after it is created.
set -euo pipefail
B=https://testdata-api.re-jam620.workers.dev
ID=$(curl -sSf "$B/v1/sandbox" -H 'content-type: application/json' -d '{"seed":42}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

ok=$(curl -s -o /dev/null -w '%{http_code}' "$B/v1/sandbox/$ID/charges" -H 'content-type: application/json' \
  -d '{"amount":1999,"currency":"usd","card":"4242424242424242"}')
declined=$(curl -s -o /dev/null -w '%{http_code}' "$B/v1/sandbox/$ID/charges" -H 'content-type: application/json' \
  -d '{"amount":1999,"currency":"usd","card":"4000000000000002"}')

test "$ok" = 201 && test "$declined" = 422 && echo "checkout flow: success 201, decline 422 (card_declined)"
