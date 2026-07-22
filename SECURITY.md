# Security & Known Limitations

Noxus is a **testnet-only, hackathon-stage** project: confidential cross-chain USDC
settlement over Circle CCTP V2 and iExec Nox. This document is an honest account of
its security posture — what an independent review verified as sound, which findings
were fixed, and which limitations remain accepted for this version. It is written to
be read *before* anyone considers taking this code anywhere near real funds.

**Scope of assurance:** the guarantees below concern the Noxus contracts
(`NoxusBatcher`, `NoxusDistributor`, `NoxusCUSDC`, `CCTPMessageParser`). Circle CCTP V2
and iExec Nox are unmodified official deployments; Noxus inherits their trust
assumptions and does not attempt to re-audit them.

---

## What is sound (verified by an independent audit)

These properties were checked by an independent review of the contracts and hold as of
this version:

- **No fund theft is possible with an honest deployer.** There is no code path by which
  an attacker can extract another user's principal. Payouts in the honest path are
  confidential credits of what was deposited; payouts in the fallback path are driven by
  *attested source amounts*, not by attacker-supplied destination claims.
- **The encrypted integrity check cannot be passed with `Σ ≠ A`.** The destination sums
  each depositor's committed claim with overflow-safe `safeAdd` and folds the per-add
  `ok` flags into an `okCount`; the epoch only distributes confidentially when the
  encrypted total equals the minted aggregate `A` *and* no add overflowed. Inflating a
  claim moves `Σ` away from `A` and flips the check to `false` — it cannot be masked by
  wrap-around.
- **Individual amounts never appear on-chain.** No per-user deposit or per-recipient
  payout is emitted, stored in plaintext, or derivable from on-chain state. Only the
  aggregate `A` (the CCTP burn amount, unavoidably public) and, in the flagged fallback,
  amounts that a recipient *opts in* to reveal.
- **Exactly three plaintext-reveal sites.** `allowPublicDecryption` appears in exactly
  three code paths — `closeEpoch` (the epoch sum), `checkEpoch` (the integrity boolean),
  and `requestClaimReveal` (the opt-in fallback attribution). This is enforced by review
  and a static privacy audit (`scripts/audit_privacy.ts`). No other value is ever made
  publicly decryptable.

---

## Findings that were fixed (hardening pass)

The following issues were identified and remediated before this version. Severities are
relative to a testnet deployment.

### F-1 / F-2 — Claim-set binding and pre-registration integrity — **High**

**Was:** an attacker could influence the set of destination claims the integrity check
summed over — injecting, reordering, or withdrawing claims — which could brick an epoch
(make an honest epoch fail its check) or shift accounting.

**Now:**
- The exact claim list is **source-committed and shipped explicitly in `hookData`**, so
  the destination checks the same set the source batched — the two legs are bound.
- Each destination claim is **pre-registered under a key of `(recipient, dstHandle)`**, and
  anti-squatting is enforced by the **Nox input proof's owner-binding** (`fromExternal` only
  passes for the handle's creator, bound to this contract as `app`), not by a caller-identity
  check. `preRegister` is therefore open to any caller — which is what enables **direct
  confidential sends to a third-party `recipient`**: the sender registers the recipient's
  claim, but it only resolves if the sender's own source-authenticated committed deposit
  references that exact `(recipient, dstHandle)`, and the recipient alone gets ACL to reveal
  or spend it. Injected, reordered, or withdrawn claims still cannot brick an epoch.
  (`requestClaimReveal` keeps its `msg.sender == recipient` guard: only a recipient may reveal
  their **own** amount in fallback.)
- The **batch entry points** added later (`preRegisterMany` on the Distributor, `depositMany`
  on the Batcher) are loops over the same per-item logic: each item carries its **own
  owner-bound Nox input proof**, so the F-1/F-2 anti-squatting guarantees hold **per item**.
  Batching reduces the transaction count; it does not change the trust model.

### F-5 — Immutable peer wiring — **High**

**Was:** peer wiring was re-settable by the deployer, which meant a deployer could later
redirect where the CCTP burn is sent (a trust/centralization hazard even on testnet).

**Now:** `wirePeer` is **deployer-only AND one-shot** — the cross-chain peer can be set once,
only by the deploying account, and never redirected. This closes both re-pointing *and* the
deploy-time front-run window a follow-up audit flagged (a non-deployer could otherwise have set
the peer first). Fixed in source, redeployed, and Sourcify-verified.

### F-3 — Checks-effects-interactions on the refund path — **Medium**

**Was:** `relayRefund` performed external interactions before finalizing its own state
updates, a reentrancy-shaped ordering hazard.

**Now:** `relayRefund` follows the **checks-effects-interactions** pattern — state is
settled before external calls, closing the ordering hazard.

### F-7 — State and length guards — **Low/Medium**

**Was:** some entry points lacked explicit guards on epoch state and on the length of
externally supplied arrays.

**Now:** added **state-machine and length guards** so functions reject calls made in the
wrong epoch state or with malformed / oversized inputs.

### F-8 — CEI on the distribution path + stranded-mint edge — **Low** (follow-up audit)

**Was:** `finalizeEpoch` set its `Distributed` state *after* the wrap/transfer loop; and
`relayReceive` required state `PreRegistering`, so if nobody pre-registered, the CCTP mint
could not be relayed (aggregate stranded in the message).

**Now:** `finalizeEpoch` transitions state **before** the external calls (checks-effects-
interactions), and `relayReceive` also accepts state `None` — an all-missing batch now mints
and routes straight to fallback/refund-to-source, so the aggregate is never stranded. Fixed
in source, redeployed, and Sourcify-verified.

---

## Residual accepted limitations (testnet v1)

These are known and *accepted* for a testnet hackathon build. They are the reasons this
code is not mainnet-ready. Each is stated plainly rather than hidden.

### L-1 — Operator fee buffer is a subsidy that must be monitored — **Medium (operational)**

The reverse-bridge / wrap operations draw on a **plain-USDC fee buffer** that the operator
funds. This is an **operational subsidy, not a self-sustaining mechanism**: if the buffer
is exhausted, `finalize` is **blocked until the operator tops it up**. `forceFallback`
rescues a stuck epoch after a timeout. Consequence for griefing: the **reverse-bridge fees
of a forced fallback are borne by the operator (the honest side)**, so an attacker can
impose cost on the honest side even though the attacker **gains nothing** (they still only
recover their attested deposit). Griefing is unprofitable for the attacker but not free for
the operator. Mitigation for production would be bonded fallback / anti-griefing economics
(see below).

### L-2 — Single active epoch per Batcher — **Medium**

The Batcher supports **one active epoch at a time**. A stuck epoch (e.g. waiting on a KMS
reveal, or a fee-buffer top-up) **blocks new deposits** until it settles or is
force-fallen-back. There is no multi-epoch concurrency; throughput is serialized on epoch
settlement.

### L-3 — Auditor grants are IRREVOCABLE on-chain — **Medium**

iExec Nox provides `addViewer` but **no `removeViewer` primitive**. Therefore an auditor
grant is **add-only and permanent**: once an address is granted view access to a specific
amount handle, **it can decrypt that one amount forever**. The project's earlier framing of
a "revocable auditor" is **not accurate** and has been corrected in the README and SPEC.
Scope note: a grant is per-handle (one amount), so the exposure is bounded to the specific
amounts explicitly shared — but that exposure cannot be withdrawn on-chain. A revocation
mechanism is future work and would require either a Nox `removeViewer` primitive or a
re-encryption / key-rotation scheme layered on top.

### L-4 — Confidentiality rests on the iExec Nox trust model — **High (external dependency)**

Amount privacy depends entirely on the **iExec Nox TEE + threshold-KMS + gateway** trust
model. This is a **young / beta stack**. A **TEE break, a threshold-KMS compromise, or a
malicious gateway signer** would compromise amount privacy. Noxus does not and cannot
mitigate a break in the underlying confidential-compute layer; it inherits that layer's
assurances and their current maturity.

### L-5 — Centralized operator keeper — **Low/Medium (operational)**

The live app runs a **serverless keeper** (`/api/keeper` on the deployed app, address
`0x50ea6bF3D5e8B5F6A7b9Cc1842B09EfE01851abC`) that contributes the two batch fillers ("fill")
and drives the permissionless back half of every epoch (close → settle + CCTP burn → Iris
attestation → relay + integrity check → finalize). It is a **liveness helper, not a trust
point**: every step it performs is gated by **epoch state + the Circle attestation + the
on-chain KMS proof — never by caller identity** — so the keeper key is gas-only and **cannot
steal funds or alter amounts**. Worst case if it goes down or runs dry: the epoch simply does
not advance; any user can self-serve the same permissionless steps (the frontend falls back to
client-side signing, and self-filler mode replaces the operator fillers), and `forceFallback`
rescues a stuck epoch after the timeout. The **centralized operator** (fillers, fee buffer,
keeper gas) is an accepted testnet limitation; production would want a decentralized keeper
set or user-funded economics.

### L-6 — Testnet-only and unaudited beyond this review — **Informational**

The code is deployed only to Ethereum Sepolia and Arbitrum Sepolia, uses testnet USDC, and
has **not undergone a professional security audit**. The independent review referenced here
covered the specific properties listed under "What is sound" and the findings above; it is
not a substitute for a full audit.

---

## Not for mainnet without

This project must **not** be deployed to mainnet without, at minimum:

1. A **professional security audit** of the full contract set and cross-chain flow.
2. **Multi-epoch concurrency** so a single stuck epoch cannot block deposits.
3. **Bonded fallback / anti-griefing economics** so forced-fallback costs are not borne by
   the honest operator.
4. A **revocation mechanism for auditors** (a Nox `removeViewer` primitive, or a
   re-encryption / key-rotation design) so shared amounts can be un-shared.

---

## Reporting

This is hackathon software with no bug-bounty program. For security-relevant observations,
open an issue on the repository. Do **not** use this code with real funds.
