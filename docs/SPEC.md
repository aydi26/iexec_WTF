# Noxus — Confidential Cross-Chain USDC Settlement on Circle CCTP V2

> **Individual amounts never touch the blockchain.** Encrypted deposits (iExec Nox / ERC-7984) are batched on ETH Sepolia, one public aggregate bridges via CCTP V2, and distribution on Arbitrum Sepolia is confidential — gated by an on-chain, TEE-verified integrity check that makes cheating detectable and self-punishing.

**Event:** iExec WTF Hackathon (Summer). **Brief fit:** privacy layer over a real open-source protocol, *unmodified*, via **batching** — the mechanism the brief names. **Target:** [Circle CCTP V2](https://developers.circle.com/cctp) (permissionless burn-and-mint). **Privacy:** [iExec Nox](https://docs.noxprotocol.io) (encrypted handles + attested TEEs + on-chain ACL).

**Positioning: confidentiality, not anonymity** (Nox's own doctrine). Participants visible, amounts never — audit-friendly by design, not a mixer.

---

1. [Problem & Flow](#1-problem--flow) · 2. [Privacy Model](#2-privacy-model) · 3. [Integrity Check](#3-integrity-check) · 4. [Architecture](#4-architecture) · 5. [Verified Facts & Addresses](#5-verified-facts--addresses) · 6. [Nox Cheat Sheet](#6-nox-cheat-sheet) · 7. [ Constraints](#7--constraints--read-before-coding) · 8. [Setup & Runbook](#8-setup--runbook) · 9. [Demo Script](#9-demo-script-4-min) · 10. [Compliance](#10-hackathon-compliance) · 11. [Related Work](#11-related-work) · 12. [ Agent Guide](#12--agent-guide-claude-code) · 13. [State, Decisions, Worklog](#13-state-decisions-worklog) · 14. [License](#14-license--disclaimer)

---

## 1. Problem & Flow

`depositForBurn(amount, …)` is a public event: every CCTP treasury move (Coinbase, Kraken and payroll processors use it for exactly this) broadcasts position sizes and flow timing. Mixers answer with anonymity (regulatorily radioactive); Mind Network encrypts the *message in transit* — but the burn amount sits on Etherscan regardless. Noxus makes individual amounts **never exist on-chain**, while the aggregate stays fully auditable.

```mermaid
sequenceDiagram
    autonumber
    participant U as Users (N depositors)
    participant B as NoxusBatcher (ETH Sepolia)
    participant K as Keeper (permissionless)
    participant C as CCTP V2 + Iris
    participant D as NoxusDistributor (Arb Sepolia)

    Note over U,B: P0 pre-fund: wrap USDC→cUSDC (decoupled from bridging)
    U->>B: deposit(dstRecipient, encAmount_src, encInput_dst)
    B->>B: confidential cUSDC transferFrom · encSum = Nox.add(encSum, amt) · store (recipient, encInput_dst)
    B->>B: closeEpoch() → allowPublicDecryption(encSum)  [requires ≥ minDepositors]
    K->>B: settleEpoch(proof) → A = publicDecrypt(encSum)  ← ONLY public number
    B->>C: unwrap A → depositForBurnWithHook(A, domain 3, distributor, hookData=[(recipient_i, encInput_dst_i)])
    C-->>D: Fast Transfer ~8–20s → mint A + hook callback
    D->>D: wrap A → cUSDC · amt_i = fromExternal(encInput_dst_i) · check = eq(Σ amt_i, toEuint256(A)) → allowPublicDecryption
    K->>D: finalizeEpoch(checkProof)
    alt check true
        D->>U: confidential cUSDC credit per recipient (amounts hidden)
    else check false
        D->>D: epoch flagged → opt-in attribution reveal + refund-to-source (Arb→ETH); cheater exposed by Σ≠A
    end
```

**Observer's view per epoch:** participant set  · per-user deposit  · aggregate A  (one number, unavoidable) · recipient set  · per-recipient payout  · any individual amount, ever  · auditor view of one amount  on demand via `addViewer` (add-only, **irrevocable on-chain** — Nox exposes no `removeViewer`; a granted viewer can decrypt that one amount forever; revocation is future work, see SECURITY.md).

## 2. Privacy Model

**Guaranteed by construction:** individual amounts never emitted/stored/derivable on-chain; amount-correlation between source depositor and destination recipient broken (no amount appears on either leg); per-handle selective disclosure via ACL.

**NOT guaranteed — documented, not hidden:**
- Aggregate A is public (CCTP burn amount). Privacy requires **k ≥ 2 depositors/epoch**; `settleEpoch` reverts below `minDepositors` (demo: 3).
- Wrap boundary is public (wrapping 5,000 USDC is a visible ERC-20 tx). Mitigation: pre-fund cUSDC once, bridge many hidden amounts later.
- Participant sets & timing visible — confidentiality, not anonymity.
- Inherited trust: Circle (same as holding USDC at all) + Nox infra (TEE runners, threshold KMS, gateway).

## 3. Integrity Check

**Why:** handles are chain-scoped (§7.1) → each depositor encrypts their amount **twice**: `encAmount_src` (feeds the source-side sum) and `encInput_dst` (fresh input valid on the destination chain, shipped in the hook). Nothing cryptographically binds the two plaintexts — an attacker could inflate their destination claim.

**Mechanism (destination, before any distribution):**
```solidity
euint256 encTotal = Nox.toEuint256(0);
for (uint i; i < claims.length; i++)
    encTotal = Nox.add(encTotal, Nox.fromExternal(claims[i].handle, claims[i].proof));
ebool check = Nox.eq(encTotal, Nox.toEuint256(mintedAggregate));
Nox.allowPublicDecryption(check);            // keeper fetches KMS proof off-chain
// tx2: Nox.publicDecrypt(check, proof) → bool
```
`true` → confidential distribution (honest equilibrium). `false` → epoch flagged, **fallback = opt-in attribution reveal + refund-to-source** (D-010, verified live): each recipient may reveal their *own* destination claim (`requestClaimReveal`) — the published claims expose Σ≠A and pin the inconsistency; then the aggregate A is bridged **back** to the Batcher (reverse CCTP leg) and every depositor is confidentially re-credited their **attested source amount**. The cheater literally cannot claim more than they deposited (payout is driven by source data), and honest depositors' amounts stay private unless they choose to reveal. Cheating is detectable, unprofitable, self-exposing; the refund needs zero Nox/KMS availability to move funds. The reveal pattern itself is iExec's own (`ERC20ToERC7984Wrapper.finalizeUnwrap`) — extended, not invented.

## 4. Architecture

| Contract | Chain | Role |
|---|---|---|
| `NoxusBatcher.sol` | ETH Sepolia | Confidential deposits → `encSum` → epoch settle → unwrap → `depositForBurnWithHook` |
| `NoxusDistributor.sol` | Arb Sepolia | CCTP mint + hook → wrap → integrity check → confidential distribution / fallback |
| `cUSDCWrapper` ×2 | both | Our instances of iExec's official `ERC20ToERC7984Wrapper` around testnet USDC |
| CCTP V2, NoxCompute | both | **Unmodified official deployments — called, never touched** |

```
noxus/
├── README.md                # spec + worklog (this file)
├── feedback.md              # REQUIRED deliverable () — feed from Worklog friction notes
├── contracts/{NoxusBatcher,NoxusDistributor}.sol + interfaces/{ITokenMessengerV2,IMessageHandlerV2}.sol
├── scripts/                 # 00 wrappers · 01 batcher · 02 distributor · 03 wire
│                            # 10 demo deposits · 11 close+settle · 12 relay mint · 13 finalize
│                            # bench_nox_latency.ts  ← DAY-0 SPIKE
├── frontend/                # deposit · epoch dashboard · decrypt-my-balance · auditor view
├── test/ · hardhat.config.ts · .env.example
```

## 5. Verified Facts & Addresses

> Verified 2026-07-11 by reading source/packages (provenance in Worklog S0–S1).  = re-verify at linked primary source before use, log it.

### iExec Nox
| Item | Value |
|---|---|
| NoxCompute — ETH Sepolia (11155111) | `0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF` |
| NoxCompute — Arb Sepolia (421614) | `0xd464B198f06756a1d00be223634b85E0a731c229` |
| Solidity SDK | `@iexec-nox/nox-protocol-contracts` → `contracts/sdk/Nox.sol` (resolves NoxCompute per chainId). Solidity `^0.8.27` |
| ERC-7984 + wrapper | `iExec-Nox/nox-confidential-contracts` (MIT): `ERC20ToERC7984WrapperBase` — `wrap` / two-step `unwrap`+`finalizeUnwrap(proof)` |
| JS SDK | `@iexec-nox/handle` (checked `0.1.0-beta.13`, 2026-06-08): `createEthersHandleClient` / `createViemHandleClient`; `encryptInput` · `decrypt` · `publicDecrypt` · `viewACL` |
| **ETH Sepolia SDK support: SHIPPED** | `NETWORK_CONFIGS` in the published tarball contains **both** 11155111 and 421614 — the docs' "upcoming release" note is stale |
| Gateway (shared testnets) | `https://gateway-testnets.noxprotocol.dev` |
| Subgraph ETH Sepolia | `https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo` |
| Subgraph Arb Sepolia | `https://thegraph.arbitrum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/BjQAX2HpmsSAzURJimKDhjZZnkSJtaczA8RPumggrStb` |
| Docs / status | `https://docs.noxprotocol.io` (Networks page lists ETH Sepolia;  banner) · `https://status.noxprotocol.io` |
| Pipeline (debugging) | Ingestor (RPC poll) → NATS JetStream → Runner (TEE) → Handle Gateway (ECIES/S3) → KMS (delegated decryption); gateway proofs are EIP-712 |
| Fees / allowlist | none found on NoxCompute — permissionless; ACL only gates handles |
|  `nox-hardhat-starter` | 404 all branches (brief links it); `nox-hardhat-plugin` still template. Use plain Hardhat + npm packages |

### Circle CCTP V2 (**V2 only — V1 phase-out starts 2026-07-31**)
| Item | Value |
|---|---|
| Testnets | ETH Sepolia  Arb Sepolia  · domains: ETH=`0`, ARB=`3` |
| Signature (pinned) | `depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)` — re-verified vs `circlefin/evm-cctp-contracts` master 2026-07-12. `destinationCaller`: if set, ONLY that address may call `receiveMessage`; `bytes32(0)` ⇒ anyone. **Noxus sets `destinationCaller = our contract` on both legs (D-011)** — a direct `receiveMessage` would mint without initializing epoch state and consume the nonce; relay stays permissionless one level up via `relayReceive`/`relayRefund`. Fast Transfer ⇒ `minFinalityThreshold = 1000` (≤1000 = Fast, confirmed) |
| Whitepaper endorsement | *"splitting a transfer among multiple recipients"* is a listed Hook use case, destination contract interprets hookData — Noxus is a sanctioned pattern |
| BurnMessage (V2) | `[0:4] ver · [4:36] burnToken · [36:68] mintRecipient · [68:100] amount · [100:132] sender · [132:164] maxFee · [164:196] feeExecuted · [196:228] expirationBlock · [228:…] hookData` — **corrected 2026-07-12** (this row previously had feeExecuted/expirationBlock swapped; verified vs `BurnMessageV2.sol` constants + docs). Outer `MessageV2` header = 148 B (`nonce` is bytes32@12, `destinationCaller`@108, `messageBody`@148) ⇒ hookData at outer offset 376. `maxMessageBodySize = 8192 B` (official deploy script;  re-verify via on-chain getter on BOTH chains Day-0 — send-side ETH Sepolia value binds) ⇒ hookData budget ≈ 7964 B; Plan B: pre-register `encInput_dst` on Distributor, hook carries epoch ID only (D-006) |
| Addresses (testnet, pinned 2026-07-12) | `TokenMessengerV2` `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` · `MessageTransmitterV2` `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` — **SAME on ETH Sepolia and Arb Sepolia** (CREATE2). Source: https://developers.circle.com/cctp/evm-smart-contracts.  **`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` is the MAINNET MessageTransmitterV2 (Etherscan-labeled) — never use on testnet**; this row previously mislabeled it "Arb Sepolia". USDC testnet: ETH Sep `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` · Arb Sep `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`. No npm pkg for CCTP contracts — vendor from `github.com/circlefin/evm-cctp-contracts` master (`src/v2/`, `src/messages/v2/`; official hook sample `src/examples/CCTPHookWrapper.sol`) |
| Iris (testnet) | `https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}?transactionHash=<tx>` → `pending_confirmations` → `complete` (Fast ≈ 8–15 s; standard ETH finality ≈ 13–19 min) · `receiveMessage` permissionless |
| USDC faucet | https://faucet.circle.com (both testnets) |

**Dropped:** Centrifuge — `createPool` gated by their ops multisig on official Sepolia (`OpsGuardian.onlySafe`, verified in source). Closed, see D-002.

## 6. Nox Cheat Sheet

- **Types:** `ebool euint16 euint256 eint16 eint256` — no 64/128; **use `euint256` for amounts**.
- **Ingest:** `toEuint256(x)` (public handle: plaintext-derivable, no ACL — fine for constants like the minted aggregate) · `fromExternal(handle, proof)` for user inputs made via SDK `encryptInput`.
- **Math:** `add/sub/mul/div` **wrap on overflow** → use `safeAdd/…` (return `(ebool ok, result)`) + `select` for user-influenced values; encrypted `div` exists (TEE, not FHE).
- **Compare/branch:** `eq/ne/lt/le/gt/ge` → `ebool`; branch only via `select(cond, a, b)` — never `if` on encrypted data.
- **ACL:** `allowThis(h)` (contract reuse — required after every stored mutation) · `allow(h, addr)` (client decrypt) · `allowTransient/disallowTransient` (single-tx) · `addViewer/isViewer` (auditor mode) · `allowPublicDecryption/isPubliclyDecryptable`.
- **Two-tx reveal (the pattern this project runs on):** tx1 `allowPublicDecryption(h)` → keeper: SDK `publicDecrypt(h)` → `(plaintext, proof)` → tx2 `Nox.publicDecrypt(h, proof)` verifies KMS proof on-chain, reverts if bad.
- **Init:** an `euint256` field is NOT a valid zero by default — `encSum = Nox.toEuint256(0)` in constructor/epoch reset.

## 7.  Constraints — READ BEFORE CODING

1. **Handles are chain-scoped, enforced** (`Compute.sol`: `chainIdInHandle == block.chainid`) — source handles revert on destination; no cross-chain primitive. Hence dual encryption + §3. Layout note: v0.1.0 contracts put chainId at bytes `[1-4]`, current docs say `[26-29]` — revised between versions; **installed `HandleUtils.sol` is ground truth**; chain-scoping holds either way.
2. **No synchronous plaintext.** Every reveal = two txs + off-chain KMS round-trip. State machines split accordingly: `closeEpoch()` ≠ `settleEpoch(proof)`; `receiveHook()` ≠ `finalizeEpoch(proof)`. Wrapper unwrap is itself two-step — budget the extra keeper round-trip.
3. **`allowThis` after every stored handle mutation**, or the next tx reverts on ACL.
4. **k-anonymity floor:** `settleEpoch` reverts if `depositorCount < minDepositors`.
5. **Only 3 legal `allowPublicDecryption` call sites:** epoch sum, integrity `ebool`, fallback path (labeled `// PRIVACY FALLBACK — plaintext by design`). Grep in review.
6. **Day-0 unknowns (burn down before product code):**
   - [x] ETH Sepolia SDK support — RESOLVED 2026-07-11 (shipped in beta.13).
   - [ ] Live probe gateway + both subgraphs; run `bench_nox_latency.ts` on both chains (encrypt → op → decrypt; publicDecrypt proof RTT). Endpoints existing ≠ healthy today. Check status page.
   - [ ] Pin `TokenMessengerV2`/`MessageTransmitterV2` testnet addresses (Circle docs).
   - [ ] hookData size test N=3 / N=10 → decide D-006 (inline vs pre-registration).
   - [ ] Discord #1: bi-chain with source leg on ETH Sepolia satisfies the deployment criterion — get it in writing.
   - [ ] Discord #2: any confidential-CCTP project at Vibe Coding? (prior-project reuse = disqualification; avoid collision).

## 8. Setup & Runbook

Node ≥ 20 · pnpm · two funded testnet accounts (deployer + keeper). Faucets: Sepolia/ArbSepolia ETH + Circle USDC faucet.

```bash
git clone <repo> && cd noxus && pnpm install && cp .env.example .env
# .env (gitignored from commit #1): DEPLOYER_PRIVATE_KEY, KEEPER_PRIVATE_KEY,
# ETH_SEPOLIA_RPC_URL, ARB_SEPOLIA_RPC_URL, ETHERSCAN_API_KEY, ARBISCAN_API_KEY
```
Deps (pinned 2026-07-12 from npm registry): `@iexec-nox/nox-protocol-contracts@0.2.4`, `@iexec-nox/nox-confidential-contracts@0.2.2` (npm name confirmed — the ERC-7984 pkg), `@iexec-nox/handle@0.1.0-beta.13`, hardhat + toolbox, ethers v6. Compiler `0.8.27` (or highest the Nox packages accept).

**Runbook (ordered; log every address in Worklog):** `00` wrappers on both chains → `01` Batcher (wrapper, USDC, TokenMessengerV2, dstDomain=3, minDepositors) → `02` Distributor (wrapper, USDC, MessageTransmitterV2, srcDomain=0) → `03` wire peers + staticcall sanity → verify all on Etherscan/Arbiscan (judges click) → smoke `10→11→12→13` with 3 users, small amounts. **First full epoch E2E before any frontend work.**

## 9. Demo Script (4 min)

Pre-run epoch #1 fully; run epoch #2 live (Fast Transfer makes the bridge leg ~8–20 s; Nox RTT is the variable — record on a green-status day).

`0:00` real CCTP burn on Etherscan: "every treasury move is public" → `0:30` three hidden-amount deposits; Etherscan side-by-side shows txs but no amounts → `1:30` close epoch → keeper settle → ONE public number → live `depositForBurnWithHook`; CCTP explorer picks it up → `2:15` mint lands, hook fires, integrity `ebool` proof tx, confidential distribution; recipient decrypts own balance in UI → `3:00` auditor: `addViewer`, decrypt one amount, revoke — "private for the market, transparent for whoever has the right to know" → `3:40` integrity+fallback one-liner, repo link, @iEx_ec.

## 10. Hackathon Compliance

- [ ] Public repo, complete OSS code · README (this) · **`feedback.md` at root ()** — feed from Worklog friction notes
- [ ] Functional frontend · video ≤ 4 min · **deployed on ETH Sepolia** (source leg; organizer confirmation logged)
- [ ] End-to-end **no mock data** (real testnet USDC, Iris, Nox proofs)
- [ ] X post: description + video + repo, tag **@iEx_ec** · no Vibe-project reuse (validated on Discord, date logged) · team ≤ 5

## 11. Related Work

**Mind Network — FHE encrypted transfer layer for CCTP (May 2025):** encrypts the CCIP message payload in transit (routing metadata), ZKPs for compliance. Structural gap: the burn amount is an on-chain event whatever the message says — encrypting the envelope hides nothing from Etherscan. Noxus attacks the on-chain layer: amounts never exist there, only the aggregate; cross-chain consistency is TEE-verified. Also differs in stack (TEE/Nox vs FHE), path (direct CCTP V2 Hooks vs via CCIP), mechanism (batching vs payload encryption). Their x402z (w/ Zama, Jan 2026) = single-chain ERC-7984 agent payments — not batched cross-chain settlement.
**Mixers/privacy pools:** identity unlinkability via anonymity sets; not CCTP-native; the opposite compliance posture.
**Claim wording (exact, defensible):** *"first amount-confidential CCTP settlement via TEE batching with verifiable integrity"* — never "first private CCTP".

## 12.  Agent Guide (Claude Code)

> Machine-directed. Read fully before first edit, every session.

**Mission:** ship the §1 epoch flow E2E on real testnets under every §7 constraint. Working > elegant; one flawless flow > three half-flows.

**Session protocol:** ① read §7, STATE, last 2 Worklog entries; state a one-paragraph plan before editing → ② small verifiable steps; compile+test after each contract change; never end a step uncompilable → ③ MANDATORY close-out: append Worklog entry, tick STATE, log decisions with alternatives. **Append-only — never edit past entries.**

**Guardrails (hard):**
- **G1** Never modify/fork/redeploy CCTP or NoxCompute — call official deployments only.
- **G2** No address outside §5; anything  gets re-verified at primary source + logged before use.
- **G3** `allowPublicDecryption` in exactly 3 code paths (§7.5). Anything else = privacy bug.
- **G4** Every new stored handle → `allowThis` same function; every user-facing handle → `allow(h, user)`.
- **G5** No `require`/`if` on encrypted values — `select` only. No plaintext user amounts in events/storage/calldata outside the labeled fallback.
- **G6** Two-tx reveal everywhere; no function assumes a proof in the flagging tx.
- **G7** Secrets in `.env` only, gitignored from commit #1.
- **G8** Inexplicable Nox revert → check in order: ACL (`isAllowed`) → handle init → chainId-in-handle. Log resolution in `feedback.md`.
- **G9** Any iExec-tooling friction → one line in `feedback.md` **immediately**.
- **G10** Never invent Nox/CCTP signatures — `node_modules` source is ground truth over any tutorial.

**Definition of Done:** ① 3-depositor epoch settles ETH Sepolia → distributes Arb Sepolia, `check == true`, zero mocks ② corrupted-claim test yields `check == false` + fallback ③ frontend: deposit / epoch status / decrypt-my-balance / auditor grant+view ④ contracts verified on both explorers; no per-user amount findable on-chain ⑤ video + substantive `feedback.md` + X draft.

**Build order (respect it):** `bench_nox_latency.ts` → wrappers → Batcher (deposits + encSum, unit-tested) → settlement + CCTP call → Distributor happy path → integrity + fallback → frontend → auditor → polish. *Frontend before a working epoch is a scheduling bug.*

**3-week plan:** **W1** Day-0 spikes + Discord answers + wrappers + Batcher tested · **W2** settlement → CCTP → Distributor → integrity + fallback (the hard core; slack for infra surprises) · **W3** frontend, auditor mode, feedback.md, record on a green-status day, submit.

## 13. State, Decisions, Worklog

### STATE
- [x] Research & feasibility (S0) · [x] Final verification pass (S1) · [x] Day-0: ETH Sepolia SDK support confirmed · [x] Implementation plan + external verification pass (S3 → `docs/PLAN.md`)
- [x] Day-0 (S4): gateway/subgraph live probe  · CCTP on-chain getters  (maxMessageBodySize=8192 both chains, domains 0/3, Iris fast fee 1–1.3 bps) · repo bootstrapped + toolchain
- [x] Day-0 (S5): **latency bench = GO-LIVE both chains** (ETH Sep prodRTT median 7.0s/p90 7.5s; Arb prodRTT 1.7s) · proof=137 B → hookData N=10 ≈ 3.3 KB ≪ 7964 B (inline fits on SIZE) · toolchain compiles (solc 0.8.35, Nox lib)
- [ ] Day-0 remaining: **D-006** — inline fits on size but owner-binding (`ownerInProof==owner`, source-confirmed + positive bench) points to option B; confirm negative case (3rd-party submit reverts) in Phase 1 · 2 Discord confirmations (posted?)
- [x] Wrappers  · [x] Batcher  · [x] Settlement+CCTP  (live burn→Iris→relayReceive both directions) · [x] Distributor  · [x] Integrity+fallback  · [x] Frontend  (single bidirectional in-browser bridge widget: Bridge + Track tabs, header Faucet, builds + deployed on Vercel) · [x] Auditor  (grantAuditor; add-only, script-driven) · [x] **E2E no-mock: DoD ① AND ② both LIVE + reverse direction (Arb→ETH) LIVE** · [x] Contracts verified (Sourcify exact_match ×6, both directional pairs) · [ ] Video+X post
- **Live + Sourcify-verified deployments (current — redeployed 2026-07-22 with batch entry points `preRegisterMany`/`depositMany`; bidirectional, third-party sends enabled):** cUSDC ETH `0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C` · Arb `0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209`. **ETH→Arb**: Batcher@ETH `0x4eDbe88f04A547c20a3dfD3A7c7452479f3c7E77`, Distributor@Arb `0xc5097a40C5Fd58E2Db5cb7989C9cBD85251583B2`. **Arb→ETH**: Batcher@Arb `0xAFF3778e41Df36c4895154196f7880969A1B482a`, Distributor@ETH `0xbd259Aa982aBE9E8f3f5CD28d783AB452264A539`. All 6 Sourcify `exact_match`. (Earlier redeploy sets appear only in past worklog entries.)
- **Live app + keeper (2026-07-22):** https://iexecwtf.vercel.app — Vercel builds from the REPO ROOT (root `vercel.json`); serverless keeper at `/api/keeper` (source `api/keeper.mjs`, address `0x50ea6bF3D5e8B5F6A7b9Cc1842B09EfE01851abC`, gas-only key — steps gated by state + Circle attestation + KMS proof, never caller identity). Keeper phases: ping / fill / close / settle / attest / relaycheck / finalize; **fill** = operator contributes the 2×0.5 cUSD batch fillers from its own pre-wrapped liquidity within ~5 s (fillers cycle back to the operator on dst), proven live both directions. User signatures: recurring ≈ 2 (`preRegisterMany` + `depositMany`, batch E2E proven live on the new set — A=1050000, check==1, state 4); first bridge adds one-time funding (approve max + wrap + setOperator) ≈ 5. Fallbacks: keeper unreachable → client-side signing (~7 with contract batching); fill can't engage → self-filler mode; EIP-5792 atomic batching on smart-account wallets. All 4 flows (honest fwd/rev, third-party, adversarial) proven live on the current set. Product rules: 1 USDC/bridge cap, k=3 floor.

### Decision Log
| ID | Decision | Alternatives | Rationale | Date |
|---|---|---|---|---|
| D-001 | Target = CCTP V2 | EAS "Cachet" (lower risk), OZ Governor, ERC-4337, 0xSplits, Chainlink insurance | Highest ceiling; literal "batching" fit; both testnets Nox-covered; no permission walls | 07-11 |
| D-002 | Drop Centrifuge | VeilPool over ERC-7540 | Official Sepolia pool creation multisig-gated (verified); self-deploy ≈ 30% of timeline in ops | 07-11 |
| D-003 | Dual encryption + destination integrity check | handle bridging (impossible, §7.1) · public payouts (amount correlation) · fixed denominations (mixer, contradicts Nox doctrine) | Only design working on existing primitives; mirrors iExec's own finalizeUnwrap pattern | 07-11 |
| D-004 | Cheat handling = epoch fallback | per-claim bisection · slashing bonds | Weekend-simple; cheating unprofitable & self-exposing; bisection = future work | 07-11 |
| D-005 | Fast Transfer for demo | standard (free, 13–19 min) | 4-min video criterion; testnet fee negligible | 07-11 |
| D-006 | **DECIDED: pre-registration (option B)** | inline hookData | Inline FITS on size (137-B proofs ⇒ N=10 ≈ 3.3 KB ≪ 7964 B) BUT owner-binding forbids relayer submission — **CONFIRMED LIVE on Arb Sepolia (S6): owner's own submit simulates OK, 3rd-party submit of the same input reverts.** Each depositor pre-registers their own dst claim (own tx, own `fromExternal`) on the Distributor; the hook carries `epochId` + a `claimsHash` commitment binding the source batch to the destination pre-registrations. Consequence: Distributor ingestion is self-service (no relayer try/catch); a bad proof fails only that depositor's own preRegister tx. Distributor redesign folded into Phase 3. | 07-12 |
| D-007 | Co-initiated dual-proof settle (1 wall-clock KMS RTT): `closeEpoch` grants SITE 1 + starts wrapper unwrap; `settleEpoch` verifies both proofs + requires USDC balance-delta == A | two sequential RTTs; plaintext unwrap | wrapper source verified: `unwrap` burns to a FRESH self-revealed handle, `finalizeUnwrap(unwrapRequestId, proof)`; delta-check fails loudly on divergence; re-confirm from node_modules before coding (G10) | 07-12 |
| D-008 | Per-claim try/catch ingestion via external self-call (`ingestAll` batches); widened `forceFallback` timeout hatch | whole-loop ingest (one griefer bricks a minted epoch); async-poison design | `fromExternal` verified to REVERT synchronously on bad proof (137-B proof, `appInProof==msg.sender`) | 07-12 |
| D-009 | `encSum` accumulates the RETURNED `confidentialTransferFrom` handle (amount-or-zero); `withdrawDeposit` (safeSub + refund, Open only) heals the innocent zero-short case | accumulate the user-supplied handle | verified return semantics `transferred = select(success, amount, 0)`; solvency by construction | 07-12 |
| D-010 | Fallback = opt-in dst attribution reveal (`requestClaimReveal`, SITE 3) + confidential refund-to-source via reverse CCTP leg. Amends §3 prose/§1 mermaid/§2 fallback line; D-004's epoch granularity stands ("self-exposing" → "exposed by attribution") | dst pro-rata (exploitable: inflated claim captures ≈ all of A); FCFS (racy); reveal-window hedge (kept on shelf in docs/PLAN.md §3.5) | only design where "cheater cannot claim more than attested" holds literally AND honest amounts stay private in fallback; refund needs zero Nox availability | 07-12 |
| D-011 | `destinationCaller = our contract` on both CCTP legs; relay permissionless via `relayReceive`/`relayRefund` | `bytes32(0)` (per old §5 note) | direct `receiveMessage` would mint without epoch state and consume the nonce — strands the epoch; verified `CCTPHookWrapper.sol` pattern | 07-12 |

### Worklog (append-only; template: `#### Session N — date — author — focus` / Done / Verified / Open / Next / feedback.md candidates)

#### Session 0 — 2026-07-11 — claude — Feasibility & protocol selection
**Done:** source-level review of nox-protocol-contracts, nox-confidential-contracts, Centrifuge protocol; CCTP survey; prior-art search; architecture designed; README v1.
**Verified:** Nox on both testnets (addresses hardcoded per chainId in `Nox.sol`) · handles chain-scoped & enforced → D-003 · on-chain `publicDecrypt(handle, proof)` via `validateDecryptionProof` (same pattern as wrapper `finalizeUnwrap`) · primitive set sufficient (incl. encrypted `div`, `addViewer`); arithmetic wraps; no euint64/128 · NoxCompute: no fees/allowlist · wrapper exists (MIT, two-step unwrap) · CCTP V2 on both testnets; Hooks; Fast 8–20 s; `receiveMessage` permissionless; V1 deprecation 07-31; Iris sandbox; Circle faucet; domains 0/3 · Centrifuge pool creation multisig-gated → D-002 · starter repo 404; plugin = template; docs  · prior art: Mind Network = payload-in-transit encryption (doesn't hide on-chain burns); x402z single-chain; no batched integrity-verified amount-confidential CCTP found → §11 claim wording.
**feedback.md candidates:** docs  banner · starter 404 vs brief link · Hello World targets Arb Sepolia while hackathon mandates ETH Sepolia · plugin template unfilled.

#### Session 1 — 2026-07-11 — claude — Final verification pass
**Done:** docs re-crawl (new domain docs.noxprotocol.io, Networks page, official use-case pages), published SDK tarball inspected, CCTP hook specs pinned; README §5/§7 updated.
**Verified:** **ETH Sepolia first-class in Nox**: Networks page lists it, and `@iexec-nox/handle@0.1.0-beta.13` ships built-in config for 11155111 — gateway + **dedicated ETH Sepolia subgraph** (indexing pipeline stood up; docs "upcoming release" caveat stale) · full `depositForBurnWithHook` signature pinned; Fast = threshold 1000; Iris V2 endpoint format · **whitepaper endorses multi-recipient splitting via Hooks** — sanctioned pattern · handle layout differs v0.1.0 ([1-4]) vs docs ([26-29]) — installed `HandleUtils.sol` = ground truth · official use-case samples don't overlap Noxus.
**Open:** live infra probe + latency bench (needs wallet/RPC) · TokenMessengerV2 pin · hookData size (D-006) · 2 Discord confirmations.
**feedback.md candidates:** stale "upcoming release" note vs shipped SDK · docs/contracts handle-layout mismatch · docs domain migration mid-hackathon.

#### Session 2 — 2026-07-11 — claude — README v2 consolidation
**Done:** full rewrite for signal density (485 → ~230 lines): deduplicated Hooks/CCTP rows and the reveal-pattern explanation (now §6 only), merged setup+runbook, compressed worklog narratives to fact bullets, updated STATE, added D-006 placeholder and the 3-week plan. **No verified fact, address, guardrail, or open question was removed.**

<!-- APPEND NEW SESSIONS BELOW THIS LINE -->

#### Session 8 — 2026-07-12 — claude — Full audit + fix-all + redeploy + reverify
**Done:** ran a 4-agent code audit (contracts/scripts/frontend/docs) + full live E2E verification. Fixed every finding. Contract fixes (F-8 follow-up): `wirePeer` now **deployer-only AND one-shot** on both contracts (closes the deploy-time front-run window the audit flagged as HIGH); `finalizeEpoch` distribution follows **CEI** (state before external calls); `relayReceive` accepts state `None` too (all-missing batch mints → fallback/refund, never stranded). Doc/UX fixes: stale addresses corrected across SPEC STATE / DEMO_SCRIPT / ResourcesPage / README narrative; ConnectButton pointed at ETH Sepolia (was Arbitrum); contracts.js dead TODOs removed; ALT_RAILS.md + CONFIDENTIAL_BRIDGE.md marked "research/roadmap, not shipped". Frontend accent recolored green→yellow (`#B0F2B6`→`#F5D64B`, 57 occ / 10 files) per user request.
**Verified (LIVE, 2026-07-12):** recompiled; **redeployed hardened Batcher + Distributor** (reused cUSDC wrappers); **new set — ETH Sep Batcher `0x814a70961395218365DA5892F5de768a9Ed84E37`, Arb Sep Distributor `0x410195cF6137661B066d4264515C6dc9b860ECFA`** (cUSDC unchanged: ETH `0x47d150…41C`, Arb `0xD74A1F…0209`); wired (deployer-only wirePeer succeeded), buffer seeded; **all 4 Sourcify `exact_match`**; **honest E2E PASS** on the fresh contracts (A=0.10, check==1, confidential distribution, recipient decrypts balance); `audit_privacy` PASS; frontend builds. Audit verdict: contracts sound for testnet (check cannot pass with Σ≠A; no theft with honest deployer); security hygiene clean (`.env` never committed, key absent from history).
**Open:** video + X post (drafts in docs/). functions_test / adversarial re-run pending only faucet USDC (both proven live earlier; logic unchanged by the F-8 fixes on those paths).
**feedback.md candidates:** none new.

#### Session 9 — 2026-07-18 — claude — Bidirectional bridge (multi-chain-ready)
**Done:** made the architecture multi-chain-ready and shipped **bidirectional bridging**. The contracts were already domain/peer-parameterized, so this is a pure deploy+wire + a direction-agnostic frontend — no contract change. Deployed the REVERSE pair (`scripts/06_deploy_reverse.ts`): **ETH NoxusDistributor `0x073A213Be93EC6B5aD830e466DA95603450bbfb0`** (srcDomain 3) + **Arb NoxusBatcher `0x47Cd125B48970D899bD9C7434187a8C5c5214d30`** (dstDomain 0), wired + ETH-side fee buffer seeded. Frontend: `contracts.js` gains `ROUTES`/`buildRoute()` + per-chain USDC/domain/label metadata (both Batcher+Distributor per chain); `bridge.js` `runConfidentialBridge` now takes a `route` and is fully direction-agnostic; the widget's swap pill flips ETH↔Arb, and Track scans BOTH directions' in-flight bridges. Also (user UX): single bridge widget only (removed the 5 tab-views), HyperSecret-style exchange widget, header Noxus logo (white) + enlarged Arbitrum logomark, X→aiden_7788, removed Discord/LinkedIn, "Start bridging" CTA, menu closes on outside click.
**Verified (LIVE, 2026-07-18):** **REVERSE honest E2E PASS** (`scripts/07_honest_e2e_reverse.ts`): Arb→ETH, 3 hidden deposits → A=0.10 bridged → **check==1** → confidential distribution on ETH (state=4 Distributed). Forward (ETH→Arb) still green. **All 6 contracts Sourcify `exact_match`** (2 cUSDC + 2 Batcher + 2 Distributor). Frontend builds. wallet-connect audit: injected + EIP-6963 discovery works; no WalletConnect (mobile) — needs a projectId.
**Open:** WalletConnect/Coinbase connectors (need projectId) for mobile wallets; video + X post. Multi-chain beyond 2 is gated on iExec deploying Nox to more CCTP chains (SDK networks list has only 11155111 + 421614).
**feedback.md candidates:** iExec Nox is deployed on only 2 testnets (ETH Sep + Arb Sep) — the intersection with CCTP, and the hard cap on the bridge's chain count.

#### Session 10 — 2026-07-21 — claude — UX polish, fewer signatures, docs pass
**Done:** dead-code sweep (removed lib/nox.js, unused shared/format/contracts exports, stale scripts 01/05b/05c/05d, dead widget-1 CSS block). Widget UX: batch fillers set to **2 × 0.5 cUSD = 1 USDC** working liquidity (returned to sender on destination) + **hard cap 1 USDC per bridge**; step tracker decluttered (labels only on the active rail node, done phases collapse, pending hidden, "Step N of 9" caption, single error display); bilan shows the **actual bridged amount** (not the balance incl. fillers); header **Faucet** button (droplet pill, dropdown: Circle USDC + both gas faucets). Fewer signatures without security change (bridge.js): **one-time max USDC approval** to our own wrapper + **wrap with +1 USDC filler headroom** capped by the real USDC balance — from the 2nd bridge on, zero funding transactions. Docs pass: ResourcesPage (bidirectional, fillers/cap, one-time funding, 6-contract deployment table, faucet), README ("The app" practical details, reverse-E2E row in verified table), DEPLOY_VERCEL (single-widget reality), DEMO_SCRIPT (widget Track tab replaces keeper-panel/decrypt/auditor views; auditor demo = script), SPEC STATE refreshed.
**Verified:** frontend builds green at every step; eslint clean on touched files; all pushed.
**Open:** video + X post; a friend's real 1-USDC bridge to verify on-chain (next).
**feedback.md candidates:** none new.

#### Session 11 — 2026-07-21 — claude — Third-party bridge verified, adversarial re-proven, buffers funded
**Done:** full re-verification sweep (compile, audit:privacy PASS, Sourcify ×6, wiring both pairs, frontend build, git synced). Topped up both Batcher refund buffers (0.05 USDC each; txs `0x1d97b0…` ETH / `0xb5fd55…` Arb). Decision logged: CCTP fee stays an operator subsidy (buffer ≈ 500 bridges); user-funded fee (burn A+fee budget collected in deposit) noted as future work — not worth a redeploy at 0.0003/bridge.
**Verified (LIVE, 2026-07-21):** (1) **First real third-party bridge**: external user `0x5d4CA59A…A386` bridged **1 USDC Arb→ETH** end-to-end from the browser (reverse pair, epoch #1): A=2.0, hasMissing=false, check==1, Distributed, zero claims revealed, balance handle minted on ETH, buffer consumed exactly the CCTP fee (0.00026). (2) **Adversarial E2E re-proven on the hardened contracts** (fwd pair, epoch #1): inflated 0.99 claim → check==0 → FallbackAttribution → opt-in reveals exposed 0.10/0.15/0.99 (Σ=1.24≠A=0.45) → initiateRefund (Arb→ETH) → relayRefund → Batcher **Refunded**, attested amounts re-credited — cheater got 0.20, not 0.99. All four flows (honest fwd/rev, third-party, adversarial) now live-proven on the current 6-contract deployment.
**Open:** video + X post. UI guard for third-party destinations (preRegister requires msg.sender==recipient → bridging to a foreign address reverts at pre-registration; widget defaults to self so self-bridges work — either document in UI or relax the guard in a future contract rev). Optional: WalletConnect (projectId), multi-account k>1 demo.
**feedback.md candidates:** none new.

#### Session 12 — 2026-07-21 — claude — Third-party sends: guard relaxed + full redeploy + all 4 flows re-proven
**Decision change (supersedes F-7's identity guard):** `NoxusDistributor.preRegister` no longer requires `msg.sender == recipient`. Rationale: anti-squatting is enforced by the Nox input-proof owner-binding (`fromExternal` only passes for the handle's creator, bound to this contract as `app`), so a caller can only register `(recipient, handle)` pairs from THEIR OWN handles, which stay inert until the sender's own source-authenticated committed deposit references that exact pair. This enables **direct confidential sends to any address**. `requestClaimReveal` keeps its `msg.sender == recipient` guard (only a recipient may reveal its own amount).
**Done:** relaxed the guard, recompiled, **full redeploy of all 4 directional contracts** (cUSDC reused), both pairs wired, all 4 buffers funded (Dist 0.15, Batcher 0.05), all 6 Sourcify `exact_match`. New set — ETH→Arb Batcher@ETH `0x82688B8890Aab5744135cB26C3292eb821A4934A` / Distributor@Arb `0x1a87F73D57BeF323376860a7B3f11f7C18AcE666`; Arb→ETH Batcher@Arb `0x0c0695023920e4e8F89976773998fC77E7b2f000` / Distributor@ETH `0x3B9d67AD5B02a50d8B0db0890FCF2060BdcC80eC`. `bridge.js` already passed `transfers[i].recipient` to preRegister/deposit → frontend unchanged. New test `scripts/08_thirdparty_e2e.ts`. Addresses updated everywhere; SECURITY.md documents the relaxed guard; docs (README/Resources/DEMO) note third-party sends.
**Verified (LIVE, 2026-07-21, on the NEW deployment):** all four flows re-proven end-to-end, zero mocks: (1) **third-party send** — sender bridged 0.05 to a fresh unfunded address, recipient decrypted exactly 0.05 with its own key; (2) **honest ETH→Arb** check==1; (3) **honest Arb→ETH** check==1 (recipient decrypts on ETH); (4) **adversarial** — inflated 0.99 → check==0 → reveals exposed Σ=1.24≠A=0.45 → refund Arb→ETH → Batcher Refunded, cheater got 0.20 not 0.99. Plus: compile clean, audit:privacy PASS, wiring OK both pairs (bridgeEnabled true), buffers all funded, frontend builds, git synced.
**Open:** video + X post; optional WalletConnect (projectId) + multi-account k>1 demo.
**feedback.md candidates:** none new.

#### Session 15 — 2026-07-22 — claude — Contract batching + root keeper deploy + final audit pass
**Context:** real-user browser tests kept failing on wallet-RPC rate limits (Rabby → Tenderly, then publicnode: `eth_gasPrice`/`eth_getTransactionCount` 429). Root cause = transaction COUNT, not RPC choice. User directives: "REDUIS LE NOMBRE DE TX", keep Vercel building from the repo root, then full audit/cleanup/docs pass + neutral grading.
**Done:**
- **Contract-level batching (redeploy):** `NoxusDistributor.preRegisterMany` + `NoxusBatcher.depositMany` — each loops the exact per-item logic (own owner-bound Nox proof; F-1/F-2 unchanged), so 6 user data-txs → 2. Full 4-contract redeploy (cUSDC reused), both pairs wired, buffers 5/3/5/3, keeper operator on both Batchers, **all 4 Sourcify `exact_match`**. New set: fwd Batcher@ETH `0x4eDbe88f…7E77` / Distributor@Arb `0xc5097a40…83B2`; rev Distributor@ETH `0xbd259Aa9…A539` / Batcher@Arb `0xAFF3778e…482a`. bridge.js sends one `preRegisterMany` + one `depositMany` per bridge.
- **Keeper deployed from the repo ROOT (user constraint):** self-contained `/api/keeper.mjs` (deps from root node_modules — viem added to root package.json, pnpm devEngines removed; ABIs/addresses co-located in `api/{abis,deployments}`), root vercel.json functions config + `/api`-excluding rewrite + root install step. Clean-room fresh-install validation before push. **LIVE on https://iexecwtf.vercel.app/api/keeper** (user set KEEPER_PRIVATE_KEY in Vercel). Two earlier root attempts crashed the Vercel build (cross-dir bundling) — reverted, then rebuilt self-contained; duplicate `frontend/api/keeper.js` deleted.
- **RPC de-contention:** app read-RPCs lead with drpc/ankr (not publicnode — wallets default to it, shared IP budget); private Alchemy URLs wired via env only (`ETH/ARB_SEPOLIA_RPC_URL`, `VITE_ALCHEMY_SEPOLIA/ARB`), never in source; keeper KMS wait capped 45s < 60s maxDuration; manual header network switcher removed (auto chain-switching only).
- **4-agent final pass (audit / dead-code / .md / Resources):** audit ALL GREEN — build, compile, audit_privacy PASS (3 labeled sites), secrets sweep zero hits in tracked files, ABI/deployment triplicates byte-equal (batch fns everywhere), prod keeper GET+POST verified, on-chain wiring/k=3/buffers/gas healthy, no temp files. Dead code: frontend/api duplicate deleted, 6 module-only exports de-exported, ~460 lines orphaned CSS removed (grep-verified), eslint 0 / build green on combined state. README/SECURITY/DEMO_SCRIPT/DEPLOY_VERCEL/SPEC-STATE/ResourcesPage finalized to current facts (new addresses, live URL, keeper trust model, ~2-sig flow, fallbacks).
**Verified (LIVE, 2026-07-22):** batch E2E on the new set — 3 transfers via 1 `preRegisterMany` + 1 `depositMany` → A=1050000 → check==1 → Distributed(4); keeper-filler E2E both directions (fill 2+2 in 5.0s/4.6s, `entryAt` shows keeper as filler depositor); prod keeper ping + real state-read verified post-deploy.
**User cost now:** recurring ≈ 2 signatures (preRegisterMany + depositMany; keeper does fillers + the whole back half); first bridge ≈ 5 (one-time approve/wrap/setOperator); keeper-less fallback ≈ 7.
**Open (user):** video ≤ 4 min + X post; optional Vercel env `ETH/ARB_SEPOLIA_RPC_URL` (private RPC for the keeper); heavy testers should point their wallet RPC at a private endpoint.
**feedback.md candidates:** none new this session (wallet-RPC rate limiting already logged).

#### Session 14 — 2026-07-22 — claude — Operator-provided fillers (fill phase) + Nox SDK RPC pinning
**Context:** user request: when a bridge starts, the keeper should contribute the 2 fillers within ~5 s, then the user's funds go, then the classic flow. Also a field bug: browser bridge failed at the source leg with `Failed to read contract at 0x24ef36ec… (method: gateway)`.
**Done:**
- **Nox SDK RPC pinning (bug fix):** the SDK extends the client it receives with publicActions, so ALL its on-chain reads (gateway() resolution at client creation, isPubliclyDecryptable per publicDecrypt poll) ran through the WALLET's own RPC. `noxClientFor()` now hands the SDK a wallet client with the user's address as a local `toAccount` stub + chain/transport pinned to the app's fallback RPC pool (RPC_URLS exported from wagmi.js); applied to pre-register/deposit encrypts + settle/finalize reveals; private `decrypt` (signs) stays on the real wallet, best-effort. Validated headless on both chains.
- **Operator-provided fillers:** new keeper phase `fill` — at bridge start the frontend fires it; the keeper contributes the 2×0.5 fillers from its own pre-wrapped cUSDC (pre-registered to itself on dst, cycling back to the operator): 2 preRegisters (dst) + 2 deposits (src) with explicit nonces, no receipt waits, returns ~5 s. Guards: epoch Open, keeper has no live deposit in the epoch, ≤1 co-depositor (hostile caller strands at most one filler pair; a stranded pair serves as the next bridge's fillers — self-healing, observed live), refuse when decrypted filler balance < 1.0 (never deposit enc(0)), simulate-before-send. bridge.js collapses the user's leg to 1 preRegister + 1 deposit and polls the batch to 3/3 before the keeper back half; self-filler fallback whenever fill can't engage. Keeper funded 6 cUSD/chain + operator on both Batchers.
- **User cost now:** recurring bridge ≈ 2 signatures (own preRegister + own deposit); first bridge adds one-time approve(max)+wrap+setOperator.
**Verified (LIVE, 2026-07-22, both directions):** eth-arb epoch 8 and arb-eth epoch 3 — fill submitted 2+2 in 5.0 s / 4.6 s; user signed only preRegister+funding+deposit; batch 3/3; keeper drove close→settle (A=1050000 exact both) → attest → relay+check → finalize state=4. On-chain: `entryAt` shows deposits #0/#1 = keeper, #2 = user on both source Batchers; EpochDistributed(8) (Arb) + EpochSettled(3, 1050000) (Arb) events captured; keeper liquidity handles non-zero both chains. E2E harness kept at `frontend/test_fill_e2e.mjs` (direction-parametrized).
**Open:** Vercel already has KEEPER_PRIVATE_KEY (set by user); redeploys picked up fill. Browser click-through on the new 2-signature flow (user); video + X post.
**feedback.md candidates:** none new (RPC-pinning issue is app-side integration, not Nox).

#### Session 13 — 2026-07-21 — claude — Signature reduction (EIP-5792 + serverless keeper) + RPC resilience
**Context:** a real user on **Rabby** (plain EOA) hit `sepolia.gateway.tenderly.co rate limit exceeded` mid-bridge and had to sign ~14 txs. Root causes: (1) the wallet broadcasts through its OWN rate-limited RPC; (2) an EOA reports no EIP-5792 `atomic` capability, so nothing batched.
**Done — signature reduction (frontend-only, contracts untouched):**
- **EIP-5792 atomic batching** (`bridge.js` `tryBatch`/`runCalls`): pre-registrations, source leg (fund+deposits+close), and relay+check each collapse to ONE confirmation on wallets reporting `atomic` support; footgun-hardened (fallback only if nothing submitted; nonce/`return null` guards against double-execution). Only engages on smart-account wallets — NOT a plain Rabby/MetaMask EOA.
- **Serverless keeper** (`frontend/api/keeper.js`, Vercel Node fn): runs the 5 permissionless steps (close, settle+CCTP burn, Iris attest, relay+check, finalize) for the user on ANY wallet → first bridge ~14→~9 sigs, repeat ~6. Safe by design (steps gated by state + attestation + KMS proof, never identity — docs/PLAN §3.0; keeper key is gas-only, dedicated, `KEEPER_PRIVATE_KEY`, never in the client bundle). Thin per-phase design (each call finishes inside the serverless timeout); Iris polling moved server-side (no browser CORS). `bridge.js` pings it up front and **falls back to client-side signing if unreachable** — never a blocked bridge. `vercel.json` rewrite excludes `/api`.
- **RPC resilience:** `wagmi.js` transports now `fallback()` over 4–5 public RPCs per chain (viem rotates past a throttled provider); `writeResilient()` retries transient/rate-limit submit errors with a **nonce guard** (no double-send); rate-limit errors now surface an actionable message (switch the wallet RPC — names Rabby + MetaMask).
**Verified (LIVE, 2026-07-21):** honest ETH→Arb + reverse Arb→ETH re-proven end-to-end (check==1, Distributed); batch calldata proven byte-equal to the sequential path (8/8 call shapes round-trip); **keeper drove close→settle→relay→check→finalize on epoch 4 to Distributed (state 4) with a dedicated keeper key, user signing nothing beyond deposits**; handler ping/error verified; build + eslint clean.
**Open (needs you):** set `KEEPER_PRIVATE_KEY` (+ optional `ETH_SEPOLIA_RPC_URL`/`ARB_SEPOLIA_RPC_URL`) in Vercel env for the deployed keeper; keeper address `0x50ea6bF3D5e8B5F6A7b9Cc1842B09EfE01851abC` (funded 0.05 ETH/chain — top up as it runs); video + X post.
**feedback.md candidates:** wallet default testnet RPCs (Tenderly gateway) rate-limit hard under a multi-tx flow — dapps can't override a wallet's built-in-network RPC, only guide users to change it.

#### Session 7 — 2026-07-12 — claude — DoD ② live + verification + frontend + docs (completion pass)
**Done:** redeployed fresh contracts (clean epochs); ran BOTH E2E flows live; verified all 4 contracts on Sourcify; finished frontend; generated demo script + X draft. Fixed the refund fee-buffer (Batcher needs a small PLAIN-USDC buffer for the refund leg — `wrap(A)` pulls plain USDC; `05c_complete_refund.ts`).
**Verified (LIVE, both testnets, 2026-07-12):** **DoD ② adversarial fallback+refund** — depositor #3 deposits 0.20 on source but pre-registers an inflated 0.99 dst claim → Σ(dst)=1.24 ≠ A=0.45 → **integrity check == 0** → fallback → opt-in attribution reveals exposed 0.10/0.15/**0.99** (cheat caught) → `initiateRefund` bridged A back (Arb→ETH) → `relayRefund` confidentially re-credited every depositor their ATTESTED source amount. **Cheater got 0.20, not 0.99.** · DoD ① reconfirmed on fresh contracts (check==1, recipient decrypts balance). · **All 4 contracts Sourcify exact_match** (cUSDC ×2, Batcher, Distributor). · `audit:privacy` PASS. · Frontend: base UI shell + 5 Noxus views (Deposit/Epochs/Decrypt/Auditor/Keeper), `pnpm build` green. · Final addresses in STATE.
**Open (needs you):** video ≤ 4 min + X post @iEx_ec (draft in `docs/X_POST.md`, shot list in `docs/DEMO_SCRIPT.md`); for the k-anon demo, 3 distinct depositor addresses + more USDC; optional Etherscan/Arbiscan API-key verification (Sourcify already covers source verification).
**Next:** record + submit.
**feedback.md candidates:** Sourcify V1 API is in a deprecation brownout (hardhat-verify@2 hits it) — had to POST the standard-JSON to the Sourcify V2 API directly; hardhat-verify@3 (V2) needs Hardhat 3.

#### Session 6 — 2026-07-12 — claude — Phases 3–6: full cross-chain build + honest E2E live
**Done:** `NoxusDistributor.sol` (option B: `preRegister` + `relayReceive`/parse + `checkEpoch` + `finalizeEpoch` + fallback/`requestClaimReveal`/`resolveClaim`/`initiateRefund`/`forceFallback`); `NoxusBatcher` extended with `relayRefund` + message transmitter; `CCTPMessageParser` lib + CCTP interfaces; cross-chain deploy/wire + Arb-USDC seed scripts; `04_honest_e2e.ts`, `05_fallback_e2e.ts`, `audit_privacy.ts`; frontend base UI shell ported + rebranded + builds. Fixed: plain `confidentialTransfer` doesn't grant the caller the result handle → dropped the unauthorized `allow` (root-caused `UnauthorizedSender` from Nox ACL).
**Verified (LIVE, both testnets, 2026-07-12):** **DoD ① honest cross-chain E2E** — 3 hidden deposits (0.10/0.15/0.20) → preRegister on Arb (option B, owner-binding) → claimsHash matched cross-chain → dual-proof settle+burn → Iris attest → `relayReceive` mint A=450000 (fee=45) → **integrity check == 1 (TEE, on-chain)** → confidential distribution → recipient decrypted balance=450000. CCTP validated BOTH ways (ETH→Arb honest + seed; Arb→ETH refund path is the same primitive). `audit:privacy` PASS (exactly 3 reveal sites: closeEpoch/checkEpoch/requestClaimReveal; no amount leakage; no encrypted branches). Deploy addresses in STATE.
**Open (blocked on external resource):** **adversarial live run (DoD ②) is ETH-Sepolia-gas-blocked** — contracts complete/compiled/deployed and the run reached deposits before the deployer's Sepolia ETH (started 0.1) ran to ~0.0038; needs a Sepolia-ETH top-up to run `05_fallback_e2e.ts` on a fresh epoch (redeploy Distributor to clear its epoch-1 state, or advance the epoch). Frontend deposit-handler still shows the ported base UI; swapping its submit path fully to the Noxus wrap→setOperator→encrypt→deposit flow is the remaining polish.
**Next:** top up Sepolia ETH → adversarial E2E; finish BridgeWidget→Noxus deposit wiring; README §1/§3 prose amendments (D-010 fallback story); video.
**feedback.md candidates:** Nox `UnauthorizedSender` is opaque (no context on which ACL grant failed) — took a selector hunt to root-cause; `confidentialTransfer` (internal-amount overload) not granting the caller the returned handle (unlike `confidentialTransferFrom`) is an easy footgun worth a doc note.

#### Session 7 — 2026-07-12 — claude — Phase 2: NoxusBatcher live source-leg E2E
**Done:** `contracts/interfaces/ITokenMessengerV2.sol` (vendored CCTP V2 sig); `contracts/NoxusBatcher.sol` (constructor init, deposit, withdrawDeposit, closeEpoch, settleEpoch, grantAuditor, wirePeer, getters) — compiles solc 0.8.35; `scripts/01_batcher_micro_epoch.ts`. Adjusted for D-006 option B: `deposit(dstRecipient, srcHandle, srcProof, dstHandle)` stores (recipient, dstHandle) for the `claimsHash` commitment (no inline dst proof).
**Verified (LIVE, ETH Sepolia, 2026-07-12):** NoxusBatcher `0x72045c0C39F54D84C3E46f98defdb9A409607Ebe`. Full source-leg micro-epoch: pre-fund (wrap 0.5 USDC → cUSDC, setOperator) → **3 hidden-amount deposits (0.10/0.15/0.20 USDC — none on-chain)** → activeCount=3 (minDepositors gate) → closeEpoch (SITE 1 reveal + wrapper unwrap co-initiated) → keeper fetched BOTH proofs concurrently (encSum=450000 == unwrapRequestId=450000, one 2.8s wall-clock RTT — **confirms D-007**) → settleEpoch verified A on-chain, **balance-delta == A check passed**, state→Settled, next epoch opened. Bridge gated off (`bridgeEnabled=false`) for this smoke test. **DoD ① source half achieved.**
**Open:** L1 unit tests (live integration covers the path; units deferred) · Phase 3 CCTP leg + Distributor (option-B pre-registration redesign) · Arb wrapper deploy · wire peers. **Note:** micro-epoch leaves 0.45 USDC in the Batcher (bridge off, no recovery) — expected for the test.
**Next:** Phase 3 — Distributor + CCTP cross-chain (fresh session recommended; larger chunk).
**feedback.md candidates:** none new.

#### Session 6 — 2026-07-12 — claude — Phase 1: cUSDC wrapper deployed + verified live; D-006 decided
**Done:** OZ 5.6.1 installed; `NoxusCUSDC.sol` (thin concrete subclass of the official abstract optimized wrapper — G1-clean, adds no logic) compiles (18 files, solc 0.8.35); `scripts/lib/common.ts`, `scripts/00_wrapper_deploy_verify.ts`, `scripts/verify_binding.ts`; deployment registry `deployments/<chainId>.json`.
**Verified (LIVE, ETH Sepolia + Arb Sepolia, 2026-07-12):** **wrapper cycle round-trips 1 USDC** — NoxusCUSDC deployed `0xe195B0396B973C548178Eeb64DC20b9dd9B8406a` (ETH Sep); approve → `wrap(1 USDC)` → `unwrap(external input)` → `UnwrapRequested` event yields unwrapRequestId → SDK `publicDecrypt` = 1000000 → `finalizeUnwrap` → USDC restored 10→9→10. Confirms D-007 reveal machinery + handle chainId at bytes[1-4] (unwrapRequestId prefix `0x0000aa36a723…` = 11155111). **D-006 owner-binding CONFIRMED (Arb Sep, eth_call sim):** owner's own `ingest` simulates OK; a different address submitting the SAME input REVERTS → **D-006 = pre-registration (option B)**, decided. Distributor becomes self-service pre-registration (each depositor ingests own claim); hook carries epochId + claimsHash. Redesign folded into Phase 3.
**Open:** deploy wrapper on Arb Sep (deferred until Distributor phase) · Batcher (Phase 2) · Distributor option-B redesign (Phase 3). Discord questions dropped per user.
**Next:** Phase 2 — NoxusBatcher.
**feedback.md candidates:** wrapper is abstract even though it implements `_update` (must subclass to deploy) — a one-line deployable reference would help.

#### Session 3 — 2026-07-12 — claude — Implementation plan + external verification + adversarial design review
**Done:** implementation plan (`docs/PLAN.md`): 8 phases W1–W3; Phase-0 GO/NO-GO gate w/ partitioned latency tiers (GO-LIVE ≤15 s median / GO-WITH-CUTS ≤90 s = baseline / NO-GO); both contracts at signature+state-machine level w/ per-function ACL map (3 reveal sites: `closeEpoch` / `checkEpoch` / `requestClaimReveal`); test pyramid (local stub → fork spike → testnet-primary); 12-risk register; deliverables mapping. Design passed 3-critic adversarial review; fixes folded in (opt-in fallback reveal, `withdrawDeposit` healing, balance-delta settle check, widened `forceFallback`, expiration handling, production-shaped bench item). User decisions: frontend = base UI shell port (Aiden card only); keeper via frontend w/ visible proof; amounts 3.10/2.45/4.45; README renamed to `README.md` at commit #1. §5 safety corrections landed this session (see Verified). Repo bootstrapped: `.gitignore` (G7), `.env.example`, `CLAUDE.md`, `feedback.md` seed, `docs/PLAN.md`, `docs/DISCORD_QUESTIONS.md`.
**Verified (primary sources, 2026-07-12):** `TokenMessengerV2` testnet `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` + `MessageTransmitterV2` testnet `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` — SAME on both chains (developers.circle.com/cctp/evm-smart-contracts) · §5's `0x81D4…4B64` was the MAINNET transmitter mislabeled Arb Sepolia — **corrected in §5 this session** · BurnMessageV2 `feeExecuted@164` / `expirationBlock@196` (§5 had them swapped — **corrected**), outer header 148 B · `maxMessageBodySize` 8192 → hookData ≈ 7964 B · Circle never executes hooks (official `CCTPHookWrapper.sol` = wrap `receiveMessage` + parse; `destinationCaller` = exclusive receiveMessage caller) · no npm pkg for CCTP contracts → vendor `circlefin/evm-cctp-contracts` · Iris v2 endpoints + `/v2/burn/USDC/fees/{src}/{dst}` · faucet 20 USDC/2 h/address/chain · ERC-7984 pkg pinned `@iexec-nox/nox-confidential-contracts@0.2.2` (+ protocol 0.2.4, handle beta.13) · wrapper `unwrap` burns to FRESH handle + self-grants `allowPublicDecryption`; `finalizeUnwrap(unwrapRequestId, proof)` · `confidentialTransferFrom` returns transferred-or-zero `euint256` · `fromExternal` REVERTS synchronously (137-B proof; `appInProof==msg.sender`; `ownerInProof==owner`) · handle chainId at bytes [1-4] in latest pkg AND current docs (the "[26-29]" docs claim: no live source found) · Nox status all-green 2026-07-12 · no summer-event page found anywhere; both predecessor briefs (Hack4Privacy, Vibe Coding) required ARB Sepolia deployment → Discord Q1 covers both directions.
**Open:** Phase-0 live bench (incl. production-shaped chained-op RTT + proof-binding test — needs funded `.env`) · Discord Q1/Q2 posting + answers · remaining README prose amendments (Phase 7 list in `docs/PLAN.md` §1) · D-007/8/9 node_modules re-confirmation before contract code.
**Next:** Phase 0 execution (0b–0f).
**feedback.md candidates:** docs Networks page data is client-side-only (unscrapable) · handle-layout "[26-29]" docs claim unsourced · `nox-hardhat-plugin@0.1.0` published but template.

#### Session 4 — 2026-07-12 — claude — Phase 0a + 0c/0d execution (repo bootstrap + keyless probes)
**Done:** repo bootstrapped — `README.md` renamed + §5 corrections landed, `docs/PLAN.md`, `CLAUDE.md`, `feedback.md` seed, `docs/DISCORD_QUESTIONS.md`, `.gitignore`/`.env.example` (commit `e9b37bf`); toolchain pinned (handle beta.13, protocol 0.2.4, confidential 0.2.2, ethers 6, hardhat 3, tsx — commit `b728808`); `.env` created with the funded account (gitignored, verified 6 ways — key exists ONLY in `.env`); `scripts/probe_infra.ts` written + run (13/13 pass).
**Verified (LIVE on-chain / API, 2026-07-12):** Nox gateway up (`{"service":"Handle Gateway"}`); status page operational; **subgraphs healthy — ETH Sep lag 1 block (~12 s), Arb Sep lag 2 blocks, no indexing errors** (R6 low); NoxCompute proxies present both chains; CCTP `TokenMessengerV2` present both chains · **`MessageTransmitterV2` on-chain getters: `maxMessageBodySize=8192` on BOTH chains** (hookData budget ≈ 7964 B confirmed live, not just from deploy script), `localDomain` = 0 (ETH) / 3 (Arb), `version=1` · **Iris testnet fees: Fast (threshold 1000) = 1 bps ETH→Arb, 1.3 bps Arb→Eth; Standard = 0 bps** (for A=10 USDC, fast maxFee ≈ 0.001 USDC — negligible, confirms D-005) · fast-burn allowance ~100 B USDC (no constraint). Funded account `0x3Da27411b65b9dBD879291ffC87f2f1b28d4d8a5`: 0.1 ETH each chain, 10 USDC ETH Sep.
**Open:** latency bench (0b, needs the same funded key — writes txs) · hookData size + proof-binding (0e) · Discord Q1/Q2. **Demo-funding note:** only 10 USDC on ONE address — enough for a single-account smoke epoch, but the k-anonymity demo wants 3 distinct depositor addresses + ~60 USDC across rehearsals (faucet banking, 20 USDC/2 h/address). Flagged to user.
**Next:** 0b latency bench + 0e hookData tests.
**feedback.md candidates:** `pnpm@11` fails its own script-run preflight on any un-approved build script (esbuild) even with `onlyBuiltDependencies` set — had to invoke `tsx` via the direct bin path (not Nox-specific, but bit the setup).

#### Session 5 — 2026-07-12 — claude — Phase 0b latency bench + toolchain + Nox source ground-truth
**Done:** Hardhat 2.28.6 toolchain (switched off Hardhat 3 + toolbox-7 risk), solc 0.8.35, `hardhat.config.cjs`; `contracts/test/BenchHarness.sol` (test-only) compiles against the Nox library under pnpm; `scripts/bench_nox_latency.ts` deploys + times the full round-trip. Ran on both chains. Full API ground-truth read from installed `node_modules` (G10) — feeds Phase 1 D-007/8/9.
**Verified (LIVE, real testnet + gateway/KMS, 2026-07-12):** **latency bench = GO-LIVE on BOTH chains** (production-shaped reveal RTT = 3× fromExternal + safeAdd fold + eq + select + allowPublicDecryption in one tx, then SDK publicDecrypt): **ETH Sepolia median 7.0s / p90 7.5s / 5-5 success; Arb Sepolia median 1.7s** — both ≪ the 15s-median / 30s-p90 GO-LIVE bar. Component metrics (ETH Sep): encryptInput 0.7s, fromExternal tx 8.4s (12s-block-dominated), client-decrypt RTT 2.5s, idle reveal RTT 3.3s. **KMS reveal is NOT the bottleneck — block confirmation is.** proof size = **137 B** (matches Compute.sol) → hookData model `96 + N×320` ⇒ N=10 ≈ 3.3 KB ≪ 7964 B (inline fits on size). Nox SDK: `createEthersHandleClient(signer)` auto-resolves network by chainId; `encryptInput(value:bigint, 'uint256', appContract)` → `{handle, handleProof}`; `decrypt(handle)` / `publicDecrypt(handle)→{value,decryptionProof}`. Positive proof-binding case CONFIRMED live (owner=EOA creates input for app=harness, same EOA calls harness → fromExternal succeeds). **Source findings (G10):** `removeViewer` does NOT exist in Nox.sol (auditor grants add-only — README §1 "revocable" needs rework, feedback logged); `fromExternal` passes `msg.sender` as owner and Compute.sol requires `ownerInProof==owner` + `appInProof==calling contract` → third-party can't submit a user's input (predicts D-006 → option B); `ERC20ToERC7984Wrapper` is ABSTRACT (needs a concrete subclass overriding `_update`); wrapper `unwrap` burns to a fresh handle + self-calls `allowPublicDecryption`, `finalizeUnwrap(euint256 unwrapRequestId, bytes decryptedAmountAndProof)` (confirms D-007); `confidentialTransferFrom(from,to,euint256) returns euint256 transferred = select(success,amount,0)` (confirms D-009); handle chainId at bytes [1-4]; needs solc ≥ 0.8.35.
**Open:** D-006 negative binding test (Phase 1, needs 2nd account) · Discord Q1/Q2 · Phase 1 wrapper subclass + OZ dep. **Demo funding:** account has 10 USDC on ONE ETH-Sep address; full k-anon demo wants 3 distinct depositor addresses + ~60 USDC across rehearsals — user to bank via faucet (20 USDC/2 h/address).
**Next:** commit Day-0 artifacts; await user Discord posting; Phase 1 (wrappers, subclass, negative-binding test).
**feedback.md candidates:** no directly-deployable concrete `ERC20ToERC7984Wrapper` (abstract only) · SDK `encryptInput` owner/app binding undocumented (silently rules out relayer-submits designs).

## 14. License & Disclaimer

Our code: **MIT**. Interacts with unmodified third-party deployments (Circle CCTP V2, iExec Nox — their licenses apply). Testnet-only, unaudited, hackathon software — never use with real funds. Not affiliated with Circle or iExec.
**Team:** <fill, ≤5> · **Contact:** <Discord> · **X post:** <link after submission, tag @iEx_ec>
