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

- **[2026-07-12] No `removeViewer` in `Nox.sol`** — the ACL surface has `addViewer`/`isViewer` but no way to revoke a viewer on-chain. The docs/marketing frame auditor access as "revocable, on-chain"; with the current SDK an `addViewer` grant is add-only. A `removeViewer(handle, addr)` would let integrators build revocable auditor/compliance modes (our Manifold auditor feature wants exactly this).
- **[2026-07-12] Proof owner/app binding makes third-party `fromExternal` submission impossible** — `Nox.fromExternal(h, proof)` calls `validateInputProof(handle, msg.sender, proof, type)`, and `NoxCompute` requires `ownerInProof == owner (== the fromExternal caller's msg.sender)` AND `appInProof == the calling contract`. So an encrypted input created by user A (owner=A, app=C) can only clear `fromExternal` when A is the direct caller of C. A relayer/keeper cannot submit A's input on A's behalf. This is reasonable security, but it isn't called out in the encryptInput docs and it silently rules out "user encrypts, relayer submits" designs (it forced our cross-chain hookData design from inline-relay to per-user pre-registration). Worth an explicit note in the encryptInput guide: the account that will call `fromExternal` must equal the input's owner.
- **[2026-07-12] `@iexec-nox/nox-protocol-contracts` pins `pragma solidity ^0.8.35`** while `nox-confidential-contracts` uses `^0.8.28` — consumers must use solc ≥ 0.8.35 (a very new release) to depend on the SDK library; a note on the minimum supported/tested solc version would help.
- **[2026-07-12] `ERC20ToERC7984Wrapper` is `abstract`** (must be subclassed with an `_update` override choosing optimized vs raw primitives) — there is no directly-deployable concrete wrapper in the package. A ready-to-deploy reference wrapper (or a documented minimal subclass) would speed integration.

## Infra (gateway / KMS / runner / subgraphs)

- (pending — latency bench results and any incidents land here)
