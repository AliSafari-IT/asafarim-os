#!/bin/sh
# Prepares the dev/CI Garage through its admin API (#359): a one-node layout, the given access key (allowed to create
# buckets, as the store tests do), and the bucket. Safe to run again. Needs only sh and curl.
#   GARAGE_ADMIN_URL    e.g. http://garage:3903
#   GARAGE_ADMIN_TOKEN  the server's admin token
#   GARAGE_KEY_ID       GK followed by 24 hex digits
#   GARAGE_SECRET_KEY   64 hex digits
#   GARAGE_BUCKET       the bucket to create, e.g. knowledge-media
#   GARAGE_S3_URL       optional, e.g. http://garage:3900: when set, the bucket lets any origin PUT to it (CORS), so a
#                       browser on a local Knowledge can upload. Dev only; production sets CORS on its proxy.
set -eu

# One admin API call; the answer comes back on one line with no whitespace (Garage pretty-prints its JSON), so sed
# and grep below can match it.
api() {
  method=$1 path=$2
  shift 2
  out=$(curl -fsS -X "$method" -H "Authorization: Bearer $GARAGE_ADMIN_TOKEN" -H "Content-Type: application/json" \
    "$GARAGE_ADMIN_URL/v2/$path" "$@") || return 1
  printf '%s' "$out" | tr -d ' \t\r\n'
}

i=0
until status=$(api GET GetClusterStatus 2>/dev/null); do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "garage: admin API not answering at $GARAGE_ADMIN_URL" >&2; exit 1; }
  sleep 1
done

if api GET GetClusterLayout | grep -q '"version":0'; then
  node=$(printf '%s' "$status" | sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)
  [ -n "$node" ] || { echo "garage: no node id in $status" >&2; exit 1; }
  api POST UpdateClusterLayout -d "{\"roles\":[{\"id\":\"$node\",\"zone\":\"dc1\",\"capacity\":1000000000,\"tags\":[]}]}" >/dev/null
  api POST ApplyClusterLayout -d '{"version":1}' >/dev/null
  echo "garage: layout applied on node $node"
fi

# Keys and buckets answer "Layout not ready" until the new layout has taken effect; /health turns 200 then.
i=0
until curl -fsS "$GARAGE_ADMIN_URL/health" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "garage: not healthy after the layout: $(api GET GetClusterLayout)" >&2; exit 1; }
  sleep 1
done

if ! api GET "GetKeyInfo?id=$GARAGE_KEY_ID" >/dev/null 2>&1; then
  api POST ImportKey -d "{\"accessKeyId\":\"$GARAGE_KEY_ID\",\"secretAccessKey\":\"$GARAGE_SECRET_KEY\",\"name\":\"knowledge\"}" >/dev/null
  echo "garage: key $GARAGE_KEY_ID imported"
fi
api POST "UpdateKey?id=$GARAGE_KEY_ID" -d '{"allow":{"createBucket":true}}' >/dev/null

if ! api GET "GetBucketInfo?globalAlias=$GARAGE_BUCKET" >/dev/null 2>&1; then
  bucket=$(api POST CreateBucket -d "{\"globalAlias\":\"$GARAGE_BUCKET\"}" | sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p')
  [ -n "$bucket" ] || { echo "garage: CreateBucket gave no id" >&2; exit 1; }
  api POST AllowBucketKey \
    -d "{\"bucketId\":\"$bucket\",\"accessKeyId\":\"$GARAGE_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null
  echo "garage: bucket $GARAGE_BUCKET created"
fi
if [ -n "${GARAGE_S3_URL:-}" ]; then
  curl -fsS -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$GARAGE_KEY_ID:$GARAGE_SECRET_KEY" \
    -H "Content-Type: application/xml" "$GARAGE_S3_URL/$GARAGE_BUCKET?cors" --data-binary \
    '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>' \
    >/dev/null
  echo "garage: CORS set on $GARAGE_BUCKET"
fi
echo "garage: ready"
