> **Research / roadmap — NOT the shipped design.** Noxus ships batching + unmodified CCTP V2 (see the root `README.md` and `docs/SPEC.md`). This document explores alternative rails as future work; it does not describe what is deployed.

# Noxus — Alternative rails to CCTP for a single-user confidential bridge

> Two research waves across CCTP, Circle Gateway, Chainlink CCIP, LayerZero (OFT/OApp),
> Wormhole (Token Bridge/NTT), Hyperlane, Mayan (Swift/MCTP), Stargate, the Jumper/LI.FI
> aggregator set (Across, Hop, Celer, Symbiosis, Synapse, Everclear), and Hyperbridge (ISMP).
> Question: is there a rail where the amount is NOT a mandated public field, so a Nox
> confidential layer works for a **single user with no batching**?

## The one test that decides everything

For each rail, two questions:
1. Is the transferred amount a **protocol-mandated public field**, or an **app-defined payload you can encrypt**?
2. Can you plug in a **custom settlement + custom security module** so a confidential (ERC-7984/Nox) design is possible?

## Scorecard (as a base for a Nox confidential layer)

| Rail | Amount field | Custom settlement | Trust model | Needs pool/filler for real USDC? | Score |
|---|---|---|---|---|---|
| **Hyperbridge (ISMP)** | app-defined bytes (`body: Vec<u8>`) | yes (raw ISMP) | **trustless state proofs** (consensus + Merkle) | yes for backing, but filler is **not a trust root** | **8/10** |
| **Wormhole NTT** | stock = public; custom transceiver = encryptable | yes (custom transceiver, any backend) | trusted (19 guardians or your transceiver) | yes unless confidential end-to-end | **8/10** |
| **Chainlink CCIP** | token path = public; `data` path = encryptable | yes (custom token pool) | trusted DON + RMN | yes unless confidential end-to-end | **8/10** |
| **LayerZero (raw OApp)** | stock OFT = public; OApp `bytes` = encryptable | yes (custom OApp + DVN) | trusted DVN set | yes unless confidential end-to-end | **7/10** |
| **CCTP V2** | **mandated plaintext** (calldata+event+message) | **no** (Circle-owned) | trusted Circle attester | yes (batching) | 4/10 |
| **Mayan (Swift/MCTP)** | public (Swift filler; MCTP=CCTP) | no (fixed) | filler + Wormhole/CCTP | filler by design | 3/10 |
| **Stargate / Jumper set** | **all public** (pool swap must price it) | no | pool/DVN/filler | pool by design | 3/10 |
| **Circle Gateway** | mandated plaintext | no | trusted Circle | closed | 2/10 |

**Two thirds of the "bridge landscape" is disqualified outright:** every pool/AMM/filler rail
(Stargate, Across, Hop, Celer, Symbiosis, Synapse, Everclear, Mayan Swift) **must reveal the
amount** — the pool or solver has to see it to price slippage / decide to fill. Circle Gateway
is CCTP's problem, worse. Mayan MCTP *is* CCTP.

## The two facts that survived every rail

**Fact 1 — the amount stops being mandatory-public the moment you leave the stock token type.**
Generic messaging (`ISMP body`, `CCIP data`, `LayerZero OApp payload`, `Wormhole publishMessage`)
treats the body as **opaque app-defined bytes**. You can put a ciphertext there. CCTP is the
outlier: its amount is welded into Circle's contracts *and* its off-chain attestation service,
which you cannot fork. **This alone makes CCIP / NTT / Hyperlane / Hyperbridge / raw-OApp
strictly better bases than CCTP.** (Mind Network exploited exactly this: FHE over CCIP's payload.)

**Fact 2 — value conservation is unbeatable; the rail choice never removes it.**
Real value must be backed. If a single user's own 1:1 lock/burn of **real USDC** happens on the
source, that ERC-20 event is public *on the token's own ledger*, no matter how encrypted the
message is. So for canonical USDC, single-user amount-hiding **still** needs either aggregation
(batching), a pre-funded pool/filler, or **the value moving as a confidential token end-to-end**.

## The design that actually gives a single-user confidential bridge (no batch, no pool)

The escape from value conservation: **don't move canonical USDC per hop — move cUSDC (ERC-7984)
as a confidential burn-and-mint token.** Supply is conserved by `burn == mint`, so **no liquidity
pool is needed**. The only unsolved piece is that Nox handles are chain-locked (a source
ciphertext is invalid on the destination) — and that is exactly what **iExec's TEE re-encryption**
is for.

```mermaid
sequenceDiagram
    participant U as User (single, no batch)
    participant SC as cUSDC (source, ERC-7984)
    participant T as iExec TEE gateway
    participant R as Rail (Hyperbridge / NTT / CCIP)
    participant DC as cUSDC (dest, ERC-7984)

    U->>SC: burn X (X = ciphertext handle, hidden on-chain)
    SC->>T: request bridge(X-handle, dstChain, recipient)
    Note over T: enclave decrypts X (plaintext ONLY inside TEE),<br/>re-encrypts X to the DEST chain key,<br/>signs {source burn, dstChain, recipient, X-cipher}
    T->>R: opaque payload = re-encrypted X + attestation
    R-->>DC: deliver (Hyperbridge: trustless state proof of the source burn;<br/>NTT/CCIP: TEE-attested transceiver/pool verifies)
    DC-->>U: mint X of cUSDC (confidential credit, amount hidden)
```

- **Amount hidden end-to-end:** on-chain it is a ciphertext handle on both chains and an opaque
  blob on the wire. Plaintext exists **only inside the SGX/TDX enclave**, never on any chain.
- **No pool, no filler, no batch:** burn=mint conserves supply; it is a single user's own transfer.
- **The two things Nox can't do alone are supplied by the stack:** cross-chain *trust* →
  Hyperbridge state proofs (trustless) or an NTT/CCIP TEE-attested module; chain-locked *handle*
  → the iExec TEE re-encrypts the amount to the destination key (this is iExec's native strength —
  confidential off-chain compute). Zama's protocol calls the same operation "bridging ciphertexts"
  (roadmap H1 2026); iExec can do it today via a TEE task.

### Rail choice for this design

- **Hyperbridge** — best if you want the cross-chain authorization to be **trustless**. A GET
  request lets the destination verify a source storage slot (the burn) by Merkle proof, **no
  oracle**. It removes the trusted-attestation root that CCTP/Wormhole/LayerZero all have. Cost:
  finality + challenge-period latency on the trustless path (a filler can front for UX, trusted
  only for liveness, not safety); consensus clients must exist for both chains.
- **Wormhole NTT** — best if you want a **mature, audited, pool-free burn/mint framework now**.
  Custom transceiver with *any* verification backend → a TEE-attested transceiver is native.
  Fork the token to burn/mint confidentially; carry the ciphertext in `_handleAdditionalPayload`.
- **CCIP** — best **institutional/proven** story: Chainlink already markets "CCIP Private
  Transactions" (encrypt amounts, hold your own keys), Mind Network shipped FHE-over-CCIP. Custom
  token pools are first-class. Heaviest to customize.

### The residual leak, stated honestly

The cross-chain transfer is fully confidential and single-user. The **only** public amount is at
the **wrap/unwrap edge** to canonical USDC (entering cUSDC on chain A, exiting on chain B) — but
that is a *same-chain* event, decoupled from the bridge: a user can wrap/unwrap at different
times/sizes, or the protocol can pool/batch **just that edge** (which is where the current Noxus
batching design becomes the *edge-settlement* layer). The moment a user holds cUSDC and stays in
cUSDC, cross-chain movement leaks nothing.

## Verdict

- **Is there a better rail than CCTP? Yes — three of them.** Hyperbridge (trustless), Wormhole
  NTT (mature custom settlement), CCIP (proven confidential). All let the amount be an encrypted
  payload; CCTP forbids it.
- **Does any rail remove the pool for *canonical USDC* single-user hiding? No** — value
  conservation forbids it. **But moving value as a confidential ERC-7984 burn-mint token removes
  the pool entirely** — the rail carries opaque ciphertext, iExec's TEE re-encrypts across the
  chain-locked-handle boundary, and supply is conserved by burn=mint.
- **Recommended for Noxus v2:** a **confidential burn-and-mint cUSDC OFT** over **Hyperbridge**
  (trustless) or **Wormhole NTT** (fastest to ship), with the **iExec TEE as the cross-chain
  amount re-encryptor**. This is a true single-user, no-batch, no-pool confidential bridge — the
  thing CCTP structurally cannot be. Keep the current CCTP + batching design as the trustless,
  canonical-USDC edge-settlement layer.

*Grounding (verified-primary unless noted): Hyperbridge/ISMP docs (PostRequest `body: Vec<u8>`,
GET state proofs); Wormhole NTT github (custom transceivers, `_handleAdditionalPayload`); CCIP
docs (`EVM2AnyMessage.data` 30 KB, custom token pools) + Chainlink "CCIP Private Transactions";
LayerZero `OFTMsgCodec` (public `amountSD`) vs OApp `_lzSend(bytes)`; Circle CCTP source
(mandated plaintext amount); Mayan Swift contract (plaintext `amountIn`) + MCTP=CCTP; Stargate/
LI.FI set (pool/filler, amount public by construction); Zama litepaper (ciphertext bridging,
H1-2026); iExec confidential computing (SGX2/TDX enclave, plaintext only inside).*
