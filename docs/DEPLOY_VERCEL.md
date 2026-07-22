# Deploying Noxus to Vercel

The Vercel project builds from the **repo root** (not `frontend/`) using the root
[`vercel.json`](../vercel.json). One deployment serves two things:

1. **The static frontend** — the Vite + React SPA in [`frontend/`](../frontend). Contract
   addresses are baked in from `src/config/` and `src/deployments/`, and the iExec Nox SDK
   resolves its network config by chainId at runtime.
2. **The serverless keeper** — [`api/keeper.mjs`](../api/keeper.mjs) at the repo root, served
   at **`/api/keeper`**. It contributes the two batch fillers ("fill") and runs the
   permissionless back half of every bridge (close → settle + CCTP burn → Iris attestation →
   relay + integrity check → finalize) so a plain-EOA user only signs their own data
   transactions (~2 recurring: `preRegisterMany` + `depositMany`).

The live deployment is **https://iexecwtf.vercel.app** — `GET /api/keeper` returns
`{"ok":true,"keeper":"0x50ea6bF3D5e8B5F6A7b9Cc1842B09EfE01851abC"}` when the keeper is up.

## One-time setup (Vercel dashboard)

1. **New Project → Import** the GitHub repo `aydi26/iexec_WTF`.
2. **Root Directory:** leave at the **repository root** (do *not* set it to `frontend` — the
   keeper function must live at the deployment root for Vercel to serve `/api/keeper`).
3. Build settings come from the root [`vercel.json`](../vercel.json) — nothing to configure:
   - Install: `npm install --omit=dev --no-audit --no-fund && cd frontend && npm install`
     (the root install provides the keeper's runtime deps — viem + `@iexec-nox/handle`)
   - Build: `cd frontend && npm run build`
   - Output: `frontend/dist`
   - Functions: `api/keeper.mjs` (60 s max duration, ships `api/{abis,deployments}/**`)
4. **Environment variables** (see below) — set `KEEPER_PRIVATE_KEY` if you want the keeper.
5. **Deploy.**

## Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | **Required for the keeper** | Private key of a **dedicated, gas-only** keeper account (fund it with a little Sepolia + Arb Sepolia ETH). It cannot steal funds: every step it runs is gated by epoch state + the Circle attestation + the on-chain KMS proof, never by caller identity. It lives only in the Vercel env — never in the client bundle. If unset, `/api/keeper` reports unavailable and the frontend **falls back to client-side signing** — the bridge still works. |
| `ETH_SEPOLIA_RPC_URL` / `ARB_SEPOLIA_RPC_URL` | Optional (keeper) | Your own RPC provider URL per chain for the keeper's reads/writes. Recommended — the public default endpoints are rate-limited and non-archive. |
| `VITE_ALCHEMY_SEPOLIA` / `VITE_ALCHEMY_ARB` | Optional (frontend) | Your own RPC provider URL per chain, baked into the frontend at build time and put **first** in the app's fallback read pool. Without them the app uses public fallback RPCs (drpc/ankr first), which also works. |

Never commit any of these values — keys and provider URLs belong in the Vercel env (or a
git-ignored `.env`) only.

## Why npm (not pnpm)

The build installs with **npm** (committed lockfiles at root and in `frontend/`). pnpm 11's
default blocks package build scripts (esbuild's native binary) and its script-run preflight
fails the Vercel build; npm runs postinstall cleanly, so npm is the reliable choice here.
Node version is pinned via [`frontend/.nvmrc`](../frontend/.nvmrc) (`22`) and
`engines.node >= 20.19` in `package.json` (Vite 7 requires Node ≥ 20.19 / 22.12).

## SPA routing

The root `vercel.json` rewrites every non-`/api/*` path to `/index.html` so the client-side
routes resolve on direct navigation and refresh; `/api/keeper` is excluded from the rewrite
and static assets are served directly.

## Verify locally (same build Vercel runs)

```bash
npm install                 # root deps (keeper runtime)
cd frontend
npm install
npm run build               # -> frontend/dist
npm run preview             # serve the production build at http://localhost:4173
```

## After deploy

- The app is a single bridge widget: connect a wallet, enter an amount + destination (any
  address — third-party sends supported), and the confidential cross-chain flow (both
  directions, ETH↔Arb, max 1 USDC per bridge) runs against the deployed, Sourcify-verified
  contracts. With the keeper up, a recurring bridge is ~2 signatures.
- Check `GET /api/keeper` returns `ok:true` and top up the keeper address with testnet ETH as
  it runs (it pays gas for fill/close/settle/relay/finalize).
- The header **Faucet** button links to the Circle USDC faucet and both gas faucets.
- The keeper scripts in [`scripts/`](../scripts) remain available as a CLI fallback and for the
  adversarial/refund demo — see the root `README.md`.
