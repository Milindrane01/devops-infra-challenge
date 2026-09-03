#!/usr/bin/env bash
# One-time, run locally after the cluster exists and before the first CI deploy.
# Creates the namespace and the postgres-secret. Never commit real secret values to git.
set -euo pipefail

NAMESPACE="appns"
PASSWORD="$(openssl rand -base64 20)"

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic postgres-secret \
  -n "$NAMESPACE" \
  --from-literal=password="$PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "postgres-secret created in namespace $NAMESPACE"
