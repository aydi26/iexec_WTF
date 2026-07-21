// Repo-root serverless entry for the Noxus keeper.
// The Vercel project builds from the repo ROOT (see the root vercel.json:
// `cd frontend && npm run build`), and Vercel serves functions from the root
// `/api` directory. The actual keeper logic lives in `frontend/api/keeper.js`
// (co-located with its deps in frontend/node_modules); this thin module just
// re-exports it so the function deploys under BOTH possible Vercel setups:
//   - root directory = repo root  -> this file is the function
//   - root directory = frontend   -> frontend/api/keeper.js is the function
// The bundler traces the import, inlines the handler + its viem/@iexec-nox deps
// (resolved from frontend/node_modules) and the statically-imported ABIs.
export { default, config } from "../frontend/api/keeper.js";
