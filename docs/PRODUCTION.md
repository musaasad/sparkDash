# sparkDash — Production operations

The canonical **AI Lab Control Plane** runs on **DGX Spark #1**. Everything below
is operational; **no secrets are included here** (see "Secrets" for where they live).

## Canonical topology

```
DSH / Mac mini (development)
        │  commit + push
        ▼
GitHub  musaasad/sparkDash   (source of truth)
        │  controlled promotion (deploy-production.sh)
        ▼
DGX Spark #1  edgexpert-40f8 · 192.168.1.173   (production runtime)
        │  one canonical sparkDash service (Docker, host network)
        ├─ monitors DGX #1 (local)   GLM vLLM head  :8888
        ├─ monitors DGX #2           TP2 worker of #1
        └─ monitors DGX #3  192.168.1.246   Qwen TabbyAPI :8889
        ▼
Mac mini / MacBook Pro / MacBook Air / trusted LAN + Tailscale devices
```

- **Repository:** `https://github.com/musaasad/sparkDash.git`
- **Production branch:** `feature/ai-lab-control-plane`
- **Production host:** DGX Spark #1 — `edgexpert-40f8` / `192.168.1.173`
- **Canonical URL:** `http://192.168.1.173:5555` (and `http://edgexpert-40f8.local:5555`)
- **Tailscale:** reach the DGX #1 tailnet IP on `:5555` the same way (same token).
- **Production directory (source):** `~/sparkDash-production` (on DGX #1)
- **Persistent config/secrets:** `~/sparkDash-production-config/` (outside git)
- **Container / image:** `sparkDash` / `sparkdash-production:<commit>` (tag `:latest` too)
- **Auth mode:** bearer token (`SPARKDASH_TOKEN`), fail-closed if the token is ever missing.
- **Bind:** `BIND_HOST=192.168.1.173` (the LAN IP), **not** `0.0.0.0` — see "Bind & Tailscale".

## Bind & Tailscale (read before changing the bind)

DGX #1 runs `tailscale serve` which already binds `:5555` on the **tailnet**
interface (`100.77.26.68:5555` + IPv6). Binding sparkDash to `0.0.0.0:5555`
therefore collides with tailscaled and crashes with `EADDRINUSE`. The production
container binds the **LAN IP `192.168.1.173:5555`** instead — a distinct address,
so it coexists with tailscaled and still enforces token auth (a non-loopback bind
is what turns remote auth on; a loopback bind would leave GETs open).

The Docker `HEALTHCHECK`, compose healthcheck and deploy probe resolve the probe
host from `BIND_HOST` (loopback/`0.0.0.0` → `127.0.0.1`, else the bind IP), so a
LAN-IP bind self-probes correctly.

`tailscale serve` is repointed to proxy the tailnet to the LAN IP so tailnet
access keeps working on the same `:5555` URL:

```bash
# persistent (run once; re-run after any tailscaled restart)
tailscale serve --http=5555 --bg http://192.168.1.173:5555
```

If a foreground/ephemeral listener blocks the `--bg` re-add, clear it with
`tailscale serve --http=5555 off` first. This only affects the sparkDash tailnet
entry point; the unrelated `:11002` serve is left untouched.

Model identities are **not** hard-coded — live-first discovery + backend adapters
(vLLM native, TabbyAPI log-stream) resolve serving models automatically, so future
model swaps appear without config edits.

## First-time setup (once)

```bash
# On DGX #1
git clone https://github.com/musaasad/sparkDash.git ~/sparkDash-production
cd ~/sparkDash-production && git checkout feature/ai-lab-control-plane

# Persistent config dir, OUTSIDE the source tree (copy the working fleet + secrets)
mkdir -p ~/sparkDash-production-config
# copy sparks.json, sparks-secrets.json, .secrets-key, settings.json, gpu-memory.sh
# from the previous install's config/ (see rollback notes), then:
chmod 700 ~/sparkDash-production-config

# Production env file (chmod 600, never committed)
$EDITOR ~/sparkDash-production-config/deploy.env   # see template below
```

`deploy.env` (chmod 600) — see `deploy.env.example` for the template:

```
SPARKDASH_TOKEN=<strong-random-token>
SPARKDASH_CONFIG_DIR=/home/musaasad/sparkDash-production-config
SPARKDASH_SSH_KEY=/home/musaasad/.ssh/id_ed25519_nvsync_cluster_assistant
BIND_HOST=192.168.1.173          # LAN IP (see "Bind & Tailscale"); never 0.0.0.0 here
SPARKDASH_ALLOW_OPEN_REMOTE=0    # fail-closed: no token => 401 on the remote bind
```

Generate a strong token: `openssl rand -hex 32`.

## Promote a future commit (the everyday command)

From a Mac (or anywhere), SSH to DGX #1 and run the deploy script. It pulls the
intended branch, builds, runs a **canary health gate on an isolated port**, and
only then cuts over the canonical container — auto-rolling back if health fails.

```bash
ssh ai                                   # musaasad@192.168.1.173
cd ~/sparkDash-production
scripts/deploy-production.sh feature/ai-lab-control-plane
# or pin an exact commit:
scripts/deploy-production.sh 96a500c
# rehearse without touching production:
scripts/deploy-production.sh --dry-run feature/ai-lab-control-plane
```

The script **never** touches inference containers (glm53-exl3-head / vLLM /
TabbyAPI / TP2 / NCCL) — it only manages the `sparkDash` container via compose.

## Status / logs / restart

```bash
# status (container + health + which commit)
docker ps --filter name=^sparkDash$ --format '{{.Names}} {{.Status}} {{.Image}}'
docker inspect sparkDash --format '{{.State.Health.Status}}'
curl -s -H "Authorization: Bearer $SPARKDASH_TOKEN" http://192.168.1.173:5555/api/version

# logs (bounded by docker json-file limits)
docker logs --tail 100 -f sparkDash

# restart sparkDash ONLY (never inference)
docker restart sparkDash
```

## Rollback

`deploy-production.sh` renames+stops the previous container on every cutover
(`sparkDash-rollback-<timestamp>`), so rollback is instant:

```bash
cd ~/sparkDash-production
scripts/deploy-production.sh --rollback
```

Full snapshots of the pre-production install are under `~/sparkdash-rollback/<ts>/`
(container inspect, old git `MiaAI-Lab/sparkDash@33391e0`, compose, config + secrets).

## Version visibility

- Endpoint: `GET /api/version` → `{ commit, shortCommit, builtAt, mode, imageBuild, nodeEnv, node, uptimeSeconds }`.
- UI: a quiet `build <commit> · prod` marker in the sidebar footer (`BuildBadge`).
- `GIT_COMMIT`/`BUILD_DATE` are baked into the image at build time by the deploy script.

## Authentication / access

- The dashboard uses sparkDash's existing bearer auth (`SPARKDASH_TOKEN`).
- A trusted device opens `http://192.168.1.173:5555/?token=<TOKEN>` **once**; the
  token is stored in that browser's localStorage and stripped from the URL. After
  that, plain `http://192.168.1.173:5555` works on that device.
- No per-Mac SSH tunnel is required. LAN/Tailscale only — **do not** expose `:5555`
  to the public internet; scope any firewall to the trusted LAN/tailnet.
- LLM/TabbyAPI keys are used **server-side only** (encrypted in
  `sparks-secrets.json` under `.secrets-key`); they are never sent to the browser.

## Safety rails

- Inference stacks (GLM, Qwen, vLLM, TabbyAPI, TP2, NCCL, DGX networking) are
  never restarted or reconfigured by these operations.
- Secrets live outside git (`~/sparkDash-production-config`, `deploy.env`) and are
  gitignored; never committed or printed.
- Production is `:5555` on DGX #1; development preview stays on `:5556` on the Mac mini.