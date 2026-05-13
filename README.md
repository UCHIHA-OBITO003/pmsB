# pmsB (backend API)

## Why deploy “worked before” on the same plan but fails now

On Render, **Starter / free-style limits are usually RAM (memory), not disk “storage.”** Builds spike RAM during `npm install`, Prisma generate, and TypeScript compile. The instance size in MB can stay the same while **your app stops fitting** because:

1. **More or heavier dependencies** — e.g. **Puppeteer** (in `package.json`) runs install-time browser downloads and uses a lot of RAM/disk even if you never `import` it yet.
2. **Different repo layout than the docs** — Commands that assume a **pnpm monorepo** (`pnpm run render:build:api`, root `pnpm-workspace.yaml`) only work in that layout. **This repo (`pmsB`) is standalone** (no workspace, no root `render:build:api`). Using monorepo build lines here fails immediately.

---

## Deploy this repo (`pmsB`) on Render (512 MiB–friendly)

**Root directory:** `.` (repository root — same folder as this `README.md` and `package.json`).

**Build command** (skip Puppeteer’s browser download to save RAM/time; adjust if you truly need bundled Chrome on the dyno):

```bash
export NODE_OPTIONS="--max-old-space-size=384"
export PUPPETEER_SKIP_DOWNLOAD=true
npm install
npx prisma generate
npm run build
```

**Start command:**

```bash
npm run start
```

**Health check path:** `/health` (or whatever you expose publicly).

**Port:** Render sets `PORT`; the app uses `process.env.PORT` (see `src/utils/config.ts`).

### If the build still OOMs or is killed

1. Bump the service to **≥ 1 GiB RAM** (most reliable).
2. Lower Node heap slightly only if installs succeed but `tsc` dies: e.g. `--max-old-space-size=320` — too low breaks the build.
3. Commit a **`package-lock.json`** (`npm install` locally, commit the lockfile) so every deploy installs the same versions and avoids surprise resolver work.

---

## Optional: same machine layout as a pnpm monorepo

If you deploy from a **single repository** that contains `frontend/`, `backend/`, `shared/`, root `pnpm-lock.yaml`, and root `package.json` with script `render:build:api`, use the filtered install documented there (or root `render.yaml`). **Do not** point Render at this `pmsB` repo and use those commands — they will not exist here.
