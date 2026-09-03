# DevOps 90-Minute Infra Challenge

Minimal production-style stack: a Node/Express backend, a Postgres dependency, both running
on EKS, deployed automatically by GitHub Actions.

## Architecture

```
GitHub push (main)
      |
      v
GitHub Actions (deploy.yml)
  1. docker build ./app -> tag with git SHA
  2. push to ECR (devops-challenge-backend)
  3. aws eks update-kubeconfig
  4. kubectl apply -f k8s/  (image placeholder substituted with the new ECR tag)
  5. kubectl rollout status  (pipeline fails if the rollout doesn't succeed)
      |
      v
EKS cluster "devops-challenge" (ap-south-1, 2x t3.medium managed nodegroup)
  namespace: appns
    Deployment/backend  (2 replicas, readiness+liveness probes, resource limits)
      -> Service/backend (ClusterIP :80 -> :3000)
    Deployment/postgres (1 replica, PVC-backed)
      -> Service/postgres (ClusterIP :5432)
```

Backend endpoints: `GET /`, `GET /healthz` (liveness), `GET /readyz` (readiness),
`GET /items`, `POST /items` (writes to Postgres).

## One-time cluster setup (not part of the CI/CD pipeline)

```bash
eksctl create cluster --name devops-challenge --region ap-south-1 \
  --nodegroup-name workers --node-type t3.medium --nodes 2 --managed

aws eks update-kubeconfig --name devops-challenge --region ap-south-1

./scripts/bootstrap-secret.sh   # creates namespace + postgres-secret (never committed)

gh secret set AWS_ACCESS_KEY_ID -b"<value>"
gh secret set AWS_SECRET_ACCESS_KEY -b"<value>"
```

From here, every `git push` to `main` builds, pushes, and deploys automatically —
no manual `kubectl apply` needed for app changes.

## Reliability improvement: readiness + liveness probes

**Why this one:** with a single replica set and no probes, Kubernetes has no way to know
whether a pod can actually serve traffic. A pod that's up but can't reach its database
still receives traffic and returns errors to users; a pod that's genuinely wedged never
gets restarted.

**What it solves:** the two probes are split on purpose.
- `livenessProbe` (`/healthz`) only checks that the Node process is responsive. It does
  **not** touch the database — so a slow or down DB never causes Kubernetes to kill and
  restart an otherwise-healthy pod (that would just add restart-storm on top of a DB outage).
- `readinessProbe` (`/readyz`) reflects real DB connectivity. The moment it fails,
  Kubernetes pulls the pod out of the Service's endpoint list, so no traffic is routed to
  a pod that can't serve it — while the pod stays alive so it can recover on its own once
  the dependency comes back.

**Tradeoff:** more moving parts and two extra endpoints to maintain; badly tuned
thresholds (too aggressive `failureThreshold`/`periodSeconds`) can flap pods in and out of
service during brief hiccups, or mask a real hang for too long if set too loose. It also
doesn't fix the underlying dependency failure — it just stops it from becoming a
user-facing outage while it lasts.

## Intentional failure simulation: bad environment variable / DB connectivity

Trigger the failure live:

```bash
kubectl set env deployment/backend -n appns PGHOST=postgres-typo
```

Observe:

```bash
kubectl get pods -n appns -w              # backend pods stay 0/1 READY, no restarts
kubectl get endpoints backend -n appns    # Service has zero endpoints -> effectively down
kubectl describe pod -l app=backend -n appns   # Warning: Readiness probe failed
kubectl logs -l app=backend -n appns --tail=20  # "[db] not ready: getaddrinfo ENOTFOUND postgres-typo"
```

Root cause: `PGHOST` points at a Service name that doesn't exist, so the pg pool can never
connect; `/readyz` correctly reports 503 and the readiness probe (not liveness) takes the
pods out of rotation instead of crash-looping them.

Fix:

```bash
kubectl set env deployment/backend -n appns PGHOST=postgres
kubectl rollout status deployment/backend -n appns
kubectl get endpoints backend -n appns    # endpoints repopulate once pods pass /readyz
```

## Tradeoffs / what I simplified

- **Postgres runs in-cluster on a single replica with one PVC** instead of a managed
  RDS instance — fast and free to set up for a 90-minute challenge, but no automated
  backups, no HA/failover, and `Recreate` deploy strategy means a brief write-outage on
  every Postgres rollout. In production I'd use RDS (or an operator like CloudNativePG)
  with multi-AZ.
- **No Ingress/TLS/load balancer** — the Service is ClusterIP and demoed via
  `kubectl port-forward`. At real scale this needs an ALB Ingress with TLS termination
  and DNS.
- **Secrets are a single manually-created Kubernetes Secret**, not something like AWS
  Secrets Manager / External Secrets Operator with rotation.
- **No autoscaling (HPA)** — fixed at 2 replicas. Under real load this needs to scale on
  CPU/RPS, plus cluster-autoscaler or Karpenter for node capacity.
- **CI/CD has no staging environment or approval gate** — every push to `main` deploys
  straight to the only environment that exists. Production would need a staging deploy,
  smoke tests, and a manual/automated promotion gate before prod.
- **AWS credentials as long-lived GitHub Actions secrets** rather than OIDC federation —
  simpler to wire up in the time box, but OIDC (no long-lived keys stored in GitHub) is
  the safer pattern for a real org.

## Teardown

```bash
eksctl delete cluster --name devops-challenge --region ap-south-1
aws ecr delete-repository --repository-name devops-challenge-backend --region ap-south-1 --force
```
