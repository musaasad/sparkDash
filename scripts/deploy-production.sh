#!/usr/bin/env bash
# ============================================================================
# sparkDash PRODUCTION deploy — runs ON DGX Spark #1 (the canonical host).
# ----------------------------------------------------------------------------
# Controlled promotion of a git ref into the canonical container, with a
# canary-before-cutover health gate and automatic rollback. It manages ONLY the
# sparkDash container via docker compose — it NEVER touches inference containers
# (glm53-exl3-head / vLLM / TabbyAPI / TP2 / NCCL).
#
# Usage (on DGX #1):
#   scripts/deploy-production.sh [ref]        # promote ref (default: $SPARKDASH_BRANCH)
#   scripts/deploy-production.sh --dry-run [ref]   # build + canary only, no cutover
#   scripts/deploy-production.sh --rollback   # restore the last cutover container
#
# Required env file (default ~/sparkDash-production-config/deploy.env, chmod 600):
#   SPARKDASH_TOKEN=...            # bearer token for LAN auth (never in git)
#   SPARKDASH_CONFIG_DIR=...       # persistent config/secrets dir (outside git)
#   SPARKDASH_SSH_KEY=...          # monitoring private key host path
# Optional overrides: SPARKDASH_REPO_DIR, SPARKDASH_BRANCH, SPARKDASH_IMAGE,
#   SPARKDASH_CONTAINER, PORT, SPARKDASH_CANARY_PORT. See docs/PRODUCTION.md.
# ============================================================================
set -euo pipefail

REPO_DIR="${SPARKDASH_REPO_DIR:-$HOME/sparkDash-production}"
BRANCH="${SPARKDASH_BRANCH:-feature/ai-lab-control-plane}"
ENV_FILE="${SPARKDASH_DEPLOY_ENV:-$HOME/sparkDash-production-config/deploy.env}"
IMAGE="${SPARKDASH_IMAGE:-sparkdash-production:latest}"
CONTAINER="${SPARKDASH_CONTAINER:-sparkDash}"
PROD_PORT="${PORT:-5555}"
CANARY_PORT="${SPARKDASH_CANARY_PORT:-5557}"
CANARY_CONTAINER="${SPARKDASH_CANARY_CONTAINER:-sparkDash-canary}"
ROLLBACK_ROOT="${SPARKDASH_ROLLBACK_ROOT:-$HOME/sparkdash-rollback}"
COMPOSE_FILE="docker-compose.production.yml"

DRY_RUN=0
MODE="deploy"
REF=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) REF="$a" ;;
  esac
done

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "FATAL: $*"; exit 1; }

# Health/version probe INSIDE a container (uses its node + SPARKDASH_TOKEN env;
# no host curl/node dependency). args: <container> <port> <path> [expect-commit]
probe() {
  local c="$1" port="$2" path="$3" expect="${4:-}"
  docker exec "$c" node -e '
    const p=process.argv[1], path=process.argv[2], expect=process.argv[3]||"";
    fetch("http://127.0.0.1:"+p+path,{headers:{Authorization:"Bearer "+(process.env.SPARKDASH_TOKEN||"")}})
      .then(r=>r.ok?r.json():Promise.reject("HTTP "+r.status))
      .then(j=>{ if(expect && j.commit!==expect){console.error("commit "+j.commit+" != "+expect);process.exit(1);} console.log(JSON.stringify(j)); })
      .catch(e=>{console.error(String(e));process.exit(1);});
  ' "$port" "$path" "$expect"
}

wait_healthy() {
  local c="$1" port="$2" expect="${3:-}" tries="${4:-40}" i
  for ((i=1;i<=tries;i++)); do
    if probe "$c" "$port" /api/health >/dev/null 2>&1; then
      if [[ -z "$expect" ]] || probe "$c" "$port" /api/version "$expect" >/dev/null 2>&1; then
        log "healthy: $c :$port (attempt $i)"; return 0
      fi
    fi
    sleep 2
  done
  log "UNHEALTHY: $c :$port after $tries attempts"; return 1
}

# ── rollback path ───────────────────────────────────────────────────────────
if [[ "$MODE" == "rollback" ]]; then
  RB="$(docker ps -aq -f "name=^${CONTAINER}-rollback-" 2>/dev/null | head -1 || true)"
  [[ -z "$RB" ]] && die "no ${CONTAINER}-rollback-* container found to restore"
  RB_NAME="$(docker inspect "$RB" --format '{{.Name}}' | sed 's#^/##')"
  log "rolling back: stopping current $CONTAINER, restoring $RB_NAME"
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  docker rename "$RB_NAME" "$CONTAINER"
  docker update --restart=unless-stopped "$CONTAINER" >/dev/null 2>&1 || true
  docker start "$CONTAINER" >/dev/null
  wait_healthy "$CONTAINER" "$PROD_PORT" "" 30 || die "rollback container is not healthy"
  log "ROLLBACK OK: $CONTAINER restored (was $RB_NAME) on :$PROD_PORT"
  exit 0
fi

# ── deploy path ──────────────────────────────────────────────────────────────
[[ -d "$REPO_DIR/.git" ]] || die "not a git checkout: $REPO_DIR"
[[ -f "$ENV_FILE" ]] || die "missing env file: $ENV_FILE (must define SPARKDASH_TOKEN, SPARKDASH_CONFIG_DIR, SPARKDASH_SSH_KEY)"
cd "$REPO_DIR"

# Load production env (token/config/ssh) for canary + probes.
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"
set +a
[[ -n "${SPARKDASH_TOKEN:-}" ]] || die "SPARKDASH_TOKEN empty in $ENV_FILE"
[[ -n "${SPARKDASH_CONFIG_DIR:-}" ]] || die "SPARKDASH_CONFIG_DIR empty in $ENV_FILE"
[[ -n "${SPARKDASH_SSH_KEY:-}" ]] || die "SPARKDASH_SSH_KEY empty in $ENV_FILE"
[[ -f "$SPARKDASH_SSH_KEY" ]] || die "SSH key not found: $SPARKDASH_SSH_KEY"
[[ -f "$COMPOSE_FILE" ]] || die "missing $COMPOSE_FILE in $REPO_DIR"

# 1. Fetch + checkout the intended ref (only our repo/branch).
log "fetch origin"
git fetch --all --prune >/dev/null
SHA="$(git rev-parse --verify "${REF:-$BRANCH}^{commit}" 2>/dev/null || true)"
[[ -z "$SHA" ]] && die "cannot resolve ref '${REF:-$BRANCH}'"
SHORT="$(git rev-parse --short "$SHA")"
DIRTY="$(git status --porcelain | grep -v '^??' || true)"
[[ -n "$DIRTY" ]] && die "tracked modifications in $REPO_DIR, refusing to deploy:
$DIRTY"
PREV_SHA="$(git rev-parse HEAD 2>/dev/null || echo none)"
log "deploying $SHORT ($SHA)  [previous checkout HEAD $(git rev-parse --short "$PREV_SHA" 2>/dev/null || echo none)]"
git checkout --quiet --detach "$SHA"

cleanup_canary() { docker rm -f "$CANARY_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup_canary EXIT

# 3. Build the production image from this exact commit (before any cutover).
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "build image $IMAGE (GIT_COMMIT=$SHORT)"
GIT_COMMIT="$SHA" BUILD_DATE="$BUILD_DATE" \
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build \
  >/tmp/sparkdash-build-$SHORT.log 2>&1 || { log "BUILD FAILED — see /tmp/sparkdash-build-$SHORT.log"; docker start "$CONTAINER" 2>/dev/null || true; exit 1; }
docker tag "$IMAGE" "sparkdash-production:${SHORT}"

# 4. Canary on an isolated port with the SAME config/secrets — before cutover.
cleanup_canary
log "canary on :$CANARY_PORT (loopback) with config $SPARKDASH_CONFIG_DIR"
docker run -d --name "$CANARY_CONTAINER" --network host --restart=no \
  -v "$SPARKDASH_CONFIG_DIR:/app/config" \
  -v "$SPARKDASH_SSH_KEY:/root/.ssh/id_ed25519:ro" \
  -e BIND_HOST=127.0.0.1 -e PORT="$CANARY_PORT" -e SPARKDASH_TOKEN="$SPARKDASH_TOKEN" \
  -e SPARKDASH_ALLOW_OPEN_REMOTE=0 -e NODE_ENV=production -e APP_MODE=production \
  -e HOST_PROC_PATH=/host/proc -e HOST_SYS_PATH=/host/sys -e HOST_ROOT_PATH=/host/root \
  -e SSH_IDENTITY_FILE=/root/.ssh/id_ed25519 \
  "$IMAGE" >/dev/null || die "canary failed to start"

if ! wait_healthy "$CANARY_CONTAINER" "$CANARY_PORT" "$SHA" 40; then
  log "CANARY FAILED — new build is not healthy; previous container left as-is, NO cutover"
  probe "$CANARY_CONTAINER" "$CANARY_PORT" /api/health || true
  docker logs --tail 40 "$CANARY_CONTAINER" 2>&1 | sed 's/^/  canary| /' || true
  die "aborted before cutover"
fi
log "canary healthy + reports commit $SHORT"
if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY RUN complete: $SHORT builds + serves healthy on :$CANARY_PORT. No cutover."
  exit 0
fi

# 5. Preserve the current canonical container for instant rollback (rename+stop) —
#    only now, after the canary passed and this is a real (non-dry) deploy.
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ROLLBACK_ROOT"
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  RB_NAME="${CONTAINER}-rollback-${STAMP}"
  docker update --restart=no "$CONTAINER" >/dev/null 2>&1 || true
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rename "$CONTAINER" "$RB_NAME"
  echo "$RB_NAME" > "$ROLLBACK_ROOT/last-rollback-container"
  log "previous container preserved as $RB_NAME (stopped)"
else
  log "no existing $CONTAINER container (first production deploy)"
fi

# 6. Controlled cutover: start the new canonical on :$PROD_PORT (LAN + token).
cleanup_canary
log "cutover: starting canonical $CONTAINER on :$PROD_PORT (BIND_HOST=0.0.0.0)"
GIT_COMMIT="$SHA" BUILD_DATE="$BUILD_DATE" \
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d \
  >/tmp/sparkdash-cutover-$SHORT.log 2>&1 || { log "CUTOVER up failed — see /tmp/sparkdash-cutover-$SHORT.log"; }

if ! wait_healthy "$CONTAINER" "$PROD_PORT" "$SHA" 40; then
  log "CUTOVER HEALTH FAILED — auto-rolling back"
  "$0" --rollback
  exit 1
fi

log "DEPLOY OK: $SHORT live as $CONTAINER on :$PROD_PORT (LAN, token auth)"
log "rollback available: $0 --rollback  (container $(cat "$ROLLBACK_ROOT/last-rollback-container" 2>/dev/null || echo none))"
probe "$CONTAINER" "$PROD_PORT" /api/version | sed 's/^/  version| /' || true