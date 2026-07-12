# feedback.md — iExec tooling feedback (Manifold, iExec WTF Hackathon)

> Required deliverable. Running log — entries added the moment friction occurs (guardrail G9),
> polished at submission. Dates are when we hit the issue.

## Docs & onboarding

- **[2026-07-11] Docs carry a 🚧 banner mid-hackathon** — docs.noxprotocol.io was under visible construction while being the primary integration reference.
- **[2026-07-11] `nox-hardhat-starter` linked from the brief 404s** (all branches). `nox-hardhat-plugin` exists on npm (0.1.0) but is an unfilled template. We fell back to plain Hardhat + npm packages.
- **[2026-07-11] Hello World targets Arbitrum Sepolia while the brief mandates Ethereum Sepolia** — first-contact example and judging criterion point at different chains.
- **[2026-07-11] Stale "upcoming release" note for ETH Sepolia SDK support** — `@iexec-nox/handle@0.1.0-beta.13` already ships `NETWORK_CONFIGS` for 11155111; the docs caveat lagged the release.
- **[2026-07-11] Handle-layout mismatch between docs and contracts** — v0.1.0 contracts put chainId at bytes [1-4]; docs said [26-29] at the time. 2026-07-12 re-check: latest package AND current docs both say [1-4]; we found no live source for the [26-29] claim — if it described a real intermediate version, a changelog note would prevent confusion.
- **[2026-07-11] Docs domain migrated mid-hackathon** (to docs.noxprotocol.io) — old links broke during the event window.
- **[2026-07-12] Networks page data is client-side only** — /getting-started/networks renders addresses via a Vue component; not scrapable/curl-able. We had to read `chain.utils.ts` in the docs GitHub repo to pin NoxCompute addresses programmatically. A static JSON (or the addresses in the markdown) would help tooling.

## SDK & contracts

- (pending — entries added as we integrate `@iexec-nox/handle`, `nox-protocol-contracts`, `nox-confidential-contracts`)

## Infra (gateway / KMS / runner / subgraphs)

- (pending — latency bench results and any incidents land here)
