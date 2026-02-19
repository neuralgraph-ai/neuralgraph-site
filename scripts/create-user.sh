#!/usr/bin/env bash
set -euo pipefail

PROJECT="neuralgraph-app"
API="https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}"

usage() {
  cat <<EOF
Usage: $0 <email> <password> <tenant_id> <user_id> <space_ids>

  space_ids: comma-separated (no spaces)

Example:
  $0 alice@example.com s3cret123 \\
    7666b595-602f-4cb7-bfce-663a6a5f1933 \\
    alice-uid \\
    a70bf013-626e-4bf3-92ce-1411dde7a7c3,second-space-id

Requires: gcloud auth application-default login
EOF
  exit 1
}

[[ $# -lt 5 ]] && usage

EMAIL="$1"
PASSWORD="$2"
TENANT_ID="$3"
USER_ID="$4"
SPACE_IDS_RAW="$5"

# Build JSON array from comma-separated space IDs
SPACE_IDS_JSON=$(echo "$SPACE_IDS_RAW" | tr ',' '\n' | jq -R . | jq -s .)

TOKEN=$(gcloud auth print-access-token)

echo "==> Creating user ${EMAIL}"
CREATE_RESP=$(curl -sf "${API}/accounts" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${EMAIL}\",
    \"password\": \"${PASSWORD}\",
    \"emailVerified\": true
  }")

LOCAL_ID=$(echo "$CREATE_RESP" | jq -r '.localId')
echo "    Firebase UID: ${LOCAL_ID}"

CLAIMS=$(jq -n -c \
  --arg t "$TENANT_ID" \
  --arg u "$USER_ID" \
  --argjson s "$SPACE_IDS_JSON" \
  '{ngTenant: $t, ngUserId: $u, ngSpaceIds: $s}')

echo "==> Setting custom claims"
curl -sf "${API}/accounts:update" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"localId\": \"${LOCAL_ID}\",
    \"customAttributes\": $(echo "$CLAIMS" | jq -Rs .)
  }" > /dev/null

echo "    Claims: ${CLAIMS}"
echo "==> Done. User can sign in at the sandbox."
