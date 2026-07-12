# Noxus — X (Twitter) Submission Post

Placeholders: `[VIDEO_LINK]` (the ≤4-min demo) · `[REPO_LINK]` (public repo).
Tag: **@iEx_ec**. Defensible claim (use verbatim; **never** "first private CCTP"):
> "first amount-confidential CCTP settlement via TEE batching with verifiable integrity"

Char counts below assume the placeholders resolve to short links (~23 chars each, X `t.co` shortening). Trim if your links are longer.

---

## Variant A — Main post (≤ 280 chars)

```
Noxus: confidential cross-chain USDC over real, unmodified CCTP V2.

Amounts never touch chain; one aggregate bridges; a TEE-verified check gates payout.

First amount-confidential CCTP settlement via TEE batching. @iEx_ec [VIDEO_LINK] [REPO_LINK]
```

---

## Variant B — Shorter alt (≤ 280 chars, punchy)

```
Every CCTP treasury move is public on Etherscan. Noxus hides the amounts, not the audit trail.

Encrypted deposits → 1 aggregate bridges via real CCTP V2 → TEE-verified integrity check → confidential payout.

@iEx_ec [VIDEO_LINK] [REPO_LINK]
```

---

## Variant C — One-liner (very short, for reposts/replies, ≤ 200 chars)

```
Noxus: amount-confidential cross-chain USDC on unmodified CCTP V2. Amounts never on-chain, aggregate stays auditable, integrity TEE-verified. @iEx_ec [VIDEO_LINK] [REPO_LINK] #iExec #Nox
```

---

## Thread version (problem → mechanism → what's novel)

**1/5 — the problem**
```
`depositForBurn(amount, …)` is a public event. Every CCTP treasury move broadcasts your position size and timing on Etherscan.

Mixers answer with anonymity (regulatorily radioactive). Noxus answers with confidentiality — amounts that never exist on-chain. 
```

**2/5 — the mechanism**
```
How: encrypted USDC deposits (iExec Nox / ERC-7984) batch on Ethereum Sepolia. One public aggregate A bridges via REAL, unmodified CCTP V2 Fast Transfer with a hookData commitment.

No individual amount is ever emitted, stored, or derivable on-chain. @iEx_ec
```

**3/5 — the integrity gate**
```
On Arbitrum, an on-chain, TEE-verified check: Σ(destination claims) == A.

Pass → confidential distribution. Cheat (inflate your claim) → check fails → opt-in attribution reveal + refund-to-source makes everyone whole. Cheating is detectable, unprofitable, self-exposing.
```

**4/5 — what's novel vs Mind Network**
```
Mind Network encrypts the CCIP message in transit — but the burn amount still sits on Etherscan.

Noxus attacks the on-chain layer: amounts never exist there, only the aggregate; cross-chain consistency is TEE-verified. @iEx_ec
```

**5/5 — the claim + links**
```
First amount-confidential CCTP settlement via TEE batching with verifiable integrity.

Confidentiality, not anonymity — audit-friendly, not a mixer.

Demo: [VIDEO_LINK]
Code: [REPO_LINK]

#iExec #Nox #CCTP #USDC #ConfidentialComputing
```

> Note: tweets 4/5 and 5/5 replace a single over-length final tweet so every tweet posts within 280 chars. If you prefer a 4-tweet thread, merge 4 and 5 but drop the hashtags and one link label to fit.

---

## Hashtag bank (mix and match)
`#iExec` · `#Nox` · `#CCTP` · `#USDC` · `#ConfidentialComputing` · `#TEE` · `#ERC7984` · `#CrossChain` · `#Privacy` · `#Web3`

## Copy guardrails
- **Always** tag `@iEx_ec`.
- **Never** write "first private CCTP" or "anonymous" / "mixer" — the positioning is **confidentiality, not anonymity** (audit-friendly).
- Emphasize **real / unmodified CCTP V2** — we call Circle's official contracts, nothing forked.
- Keep the claim exact: **"first amount-confidential CCTP settlement via TEE batching with verifiable integrity."**
