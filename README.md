# pmsB (backend API)

## Deploy on Render (512 MiB–friendly)

**What was going wrong:** a full monorepo `pnpm install` at the repo root installs **frontend + backend + shared**, which often exceeds **512 MiB RAM** during install on Render Starter.

**Root directory:** repository root (where `pnpm-lock.yaml` and `pnpm-workspace.yaml` live). Do **not** set Root Directory to `backend` unless you introduce a separate lockfile there.

### Recommended build command (dashboard or Blueprint)

Use a **filtered** install so only the backend dependency graph is linked (skips the Vite/React frontend tree):

```bash
export NODE_OPTIONS="--max-old-space-size=384"
export PNPM_NETWORK_CONCURRENCY=2
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm run render:build:api
```

Or as a **single line** (matches [render.yaml](../render.yaml) `buildCommand`):

```bash
export NODE_OPTIONS="--max-old-space-size=384" && export PNPM_NETWORK_CONCURRENCY=2 && corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm run render:build:api
```

`render:build:api` is defined in the **root** [package.json](../package.json) as:

`pnpm install --frozen-lockfile --filter backend... && pnpm --filter backend run db:generate && pnpm --filter backend run build`

### Start command

```bash
pnpm --filter backend start
```

Runs `node dist/index.js` from [package.json](./package.json).

### Port / health

Render injects **`PORT`**. The API reads it in [src/utils/config.ts](./src/utils/config.ts) (`process.env.PORT || '3001'`). Set your Render health check path to `/health` (or your public health route).

### If install still OOMs

1. Upgrade the instance to **≥ 1 GiB RAM** (most reliable).
2. Tighten further: `PNPM_NETWORK_CONCURRENCY=1` and/or lower `--max-old-space-size` slightly (must stay enough for `tsc` + `prisma generate`).

### Blueprint file

Repo root [render.yaml](../render.yaml) wires the same build/start pattern for **Blueprint** deploys. Adjust `region` / `plan` / `name` as needed.
