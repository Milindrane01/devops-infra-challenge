# Progress

## Done
- [x] Scaffolded app (`app/`): Node/Express backend with `/`, `/healthz`, `/readyz`, `/items` (GET+POST), Postgres via `pg`
- [x] `app/Dockerfile` (multi-stage, non-root user)
- [x] K8s manifests (`k8s/`): namespace, postgres (PVC + Deployment + Service), backend (ConfigMap + Deployment w/ readiness+liveness probes + resource limits + Service)
- [x] GitHub Actions pipeline (`.github/workflows/deploy.yml`): build -> push to ECR -> `kubectl apply` -> `kubectl rollout status`
- [x] ECR repo created: `569360421155.dkr.ecr.ap-south-1.amazonaws.com/devops-challenge-backend`
- [x] EKS cluster `devops-challenge` created in `ap-south-1` (2x t3.medium managed nodegroup) — **currently running and billing**
- [x] `kubectl` context points at the cluster (`~/.kube/config`)
- [x] Namespace `appns` + `postgres-secret` created in-cluster (`scripts/bootstrap-secret.sh`)
- [x] README.md written with architecture, setup, reliability rationale, failure-injection walkthrough, tradeoffs, teardown
- [x] GitHub repo created (private): https://github.com/Milindrane01/devops-infra-challenge
- [x] `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` added as GitHub Actions secrets
- [x] First CI/CD run: build+push+apply succeeded, but `kubectl rollout status` **timed out and failed** —
  real bug, not the intentional one. Root cause: EKS ships no working dynamic storage
  provisioner by default (`gp2` StorageClass exists but isn't default, and its
  in-tree `kubernetes.io/aws-ebs` provisioner is deprecated/removed on this k8s
  version). `postgres-pvc` stayed `Pending` forever -> postgres pod `Pending` ->
  backend `/readyz` correctly returned 503 the whole time -> rollout never completed.
  Fixed by: `eksctl utils associate-iam-oidc-provider`, an IRSA role for
  `ebs-csi-controller-sa`, installing the `aws-ebs-csi-driver` EKS addon, and adding
  an explicit `ebs-gp3` StorageClass (`k8s/10-storageclass.yaml`) referenced by name
  from the PVC instead of relying on an implicit default.
- [ ] Push the storage-class fix -> confirm CI/CD run now goes green end-to-end
- [ ] Verify app end-to-end (`kubectl port-forward svc/backend`, curl `/items`)
- [ ] Live: run the intentional failure (bad `PGHOST` env var) and debug it on camera
- [ ] Record the video (demo, architecture walkthrough, failure debugging, tradeoffs)
- [ ] **Teardown after recording**: `eksctl delete cluster --name devops-challenge --region ap-south-1` (cluster is billing right now)

## Key facts to remember
- AWS account: `569360421155`, region `ap-south-1`
- EKS cluster name: `devops-challenge`
- ECR repo: `devops-challenge-backend`
- k8s namespace: `appns`
- Reliability improvement chosen: readiness/liveness probes (split DB-dependent readiness from process-only liveness)
- Intentional failure chosen: bad `PGHOST` env var (`kubectl set env deployment/backend -n appns PGHOST=postgres-typo`) -> readiness probe fails, pods drop out of Service endpoints, no restart-loop
- No Docker/kubectl/eksctl/gh were preinstalled locally (Windows, no admin rights) — kubectl/eksctl/gh were downloaded as standalone binaries into `~/bin`; Docker builds happen in GitHub Actions (which has Docker preinstalled), not locally
