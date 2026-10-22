#!/usr/bin/env bash
# Walks the polaroid API (worker/) through a submission's whole life against
# `wrangler dev`: submit, upload, approve, claim, files, done, show, delete,
# and the refusals along the way. Local only: it uses .dev.vars' ADMIN_TOKEN
# and Turnstile's always-pass test secret, and fake media.
#
#   bunx wrangler d1 migrations apply lysterfield-polaroids --local
#   bunx wrangler dev --port 8799 &
#   scripts/polaroids-smoke.sh [http://localhost:8799]
set -euo pipefail
cd "$(dirname "$0")/.."
B=${1:-http://localhost:8799}/api
T=$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars)
A=(-H "authorization: Bearer $T")
fails=0
# expect <label> <pattern> <curl args...>: the response has to contain the pattern.
expect() {
  local label=$1 pattern=$2; shift 2
  local out; out=$(curl -s "$@")
  if [[ $out == *"$pattern"* ]]; then echo "ok   $label"; else echo "FAIL $label: $out"; fails=$((fails + 1)); fi
}
fake=$(mktemp); head -c 4096 /dev/urandom > "$fake"; trap 'rm -f "$fake"' EXIT

expect "a bad crop is refused" 'crop needs' -XPOST $B/polaroids -d '{"crop":{"x":2,"y":0.5,"zoom":1},"turnstile":"t"}'
expect "no human check is refused" 'human check' -XPOST $B/polaroids -d '{"crop":{"x":0.5,"y":0.5,"zoom":1}}'
id=$(curl -s -XPOST $B/polaroids -d '{"crop":{"x":0.5,"y":0.6,"zoom":1.2},"turnstile":"t","email":"test@example.com"}' | sed -E 's/.*"id":"([0-9a-f]+)".*/\1/')
echo "     submitted $id"
expect "a clip that isn't video is refused" 'A clip is one of' -XPUT $B/polaroids/$id/clip -H 'content-type: text/plain' --data-binary x
expect "the clip goes up" '"status":"submitted"' -XPUT $B/polaroids/$id/clip -H 'content-type: video/webm' --data-binary @"$fake"
expect "only once" 'already has its clip' -XPUT $B/polaroids/$id/clip -H 'content-type: video/webm' --data-binary @"$fake"
expect "the private link doesn't show the email" '"status":"submitted","createdAt"' $B/polaroids/$id
expect "admin needs the key" 'Not allowed' $B/admin/polaroids -H 'authorization: Bearer nope'
expect "it's in the inbox" "\"id\":\"$id\"" "${A[@]}" "$B/admin/polaroids?status=submitted"
expect "nothing to claim before approval" 'null' -XPOST "${A[@]}" $B/admin/queue/claim
expect "can't show what isn't made" "Can't show" -XPOST "${A[@]}" $B/admin/polaroids/$id/review -d '{"decision":"show"}'
expect "approve" '"status":"approved"' -XPOST "${A[@]}" $B/admin/polaroids/$id/review -d '{"decision":"approve"}'
expect "claim" '"status":"making"' -XPOST "${A[@]}" $B/admin/queue/claim
expect "not done without its files" 'Upload atlas.mp4 and loop.mp4' -XPOST "${A[@]}" $B/admin/polaroids/$id/done
expect "only its own file names" "A polaroid's files" -XPUT "${A[@]}" $B/admin/polaroids/$id/files/x.exe --data-binary @"$fake"
expect "atlas" '"name":"atlas.mp4"' -XPUT "${A[@]}" $B/admin/polaroids/$id/files/atlas.mp4 --data-binary @"$fake"
expect "loop" '"name":"loop.mp4"' -XPUT "${A[@]}" $B/admin/polaroids/$id/files/loop.mp4 --data-binary @"$fake"
expect "done, the email cleared" '"hasEmail":false' -XPOST "${A[@]}" $B/admin/polaroids/$id/done
expect "the clip is deleted" 'clip is gone' "${A[@]}" $B/admin/polaroids/$id/clip
expect "no resend once it's sent" 'No email to send' -XPOST "${A[@]}" $B/admin/polaroids/$id/email
expect "show" '"status":"shown"' -XPOST "${A[@]}" $B/admin/polaroids/$id/review -d '{"decision":"show"}'
expect "in the gallery" "\"id\":\"$id\"" $B/polaroids
expect "delete" '"deleted":true' -XDELETE "${A[@]}" $B/admin/polaroids/$id
expect "gone" 'No such polaroid' $B/polaroids/$id
[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
