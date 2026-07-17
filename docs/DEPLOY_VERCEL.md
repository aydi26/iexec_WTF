# Deploying the Noxus frontend to Vercel

The app is a static Vite + React SPA in [`frontend/`](../frontend). It has **no server
and no build-time secrets** — RPC endpoints and contract addresses are baked in from
`src/config/` and `src/deployments/`, and the iExec Nox SDK resolves its network config by
chainId at runtime. So a plain static deploy is all it needs.

## One-time setup (Vercel dashboard)

1. **New Project → Import** the GitHub repo `aydi26/iexec_WTF`.
2. **Root Directory:** set to **`frontend`** (this is the key setting — the repo is a
   monorepo; the app lives in `frontend/`).
3. **Framework Preset:** Vite (auto-detected).
4. Leave Build/Install/Output as detected — they are also pinned in
   [`frontend/vercel.json`](../frontend/vercel.json):
   - Install: `npm install`
   - Build: `npm run build`
   - Output: `dist`
5. **Environment variables:** none required.
6. **Deploy.**

Node version is pinned via [`frontend/.nvmrc`](../frontend/.nvmrc) (`22`) and
`engines.node >= 20.19` in `package.json` (Vite 7 requires Node ≥ 20.19 / 22.12).

## Why npm (not pnpm)

The frontend ships a committed `package-lock.json` and installs with **npm**. pnpm 11's
default blocks package build scripts (esbuild's native binary) and its script-run preflight
fails the Vercel build; npm runs postinstall cleanly, so npm is the reliable choice here.

## SPA routing

`vercel.json` rewrites every unmatched path to `/index.html` so the client-side routes
(`/`, `/resources`, `/team`) resolve on direct navigation and refresh — static assets under
`/assets/*` are still served directly.

## Verify locally (same commands Vercel runs)

```bash
cd frontend
npm install
npm run build      # -> dist/
npm run preview    # serve the production build at http://localhost:4173
```

## After deploy

- The dApp works once a wallet is connected to **Ethereum Sepolia** (the source leg).
- Faucet button (header) dispenses test cUSDC; deposit / epoch dashboard / decrypt / auditor /
  keeper views are all live against the deployed, Sourcify-verified contracts.
- The full cross-chain confidential bridge (relay → integrity check → distribute on Arbitrum)
  is driven by the keeper scripts in [`scripts/`](../scripts) — see the root `README.md`.
