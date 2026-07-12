# Discord questions — post verbatim, log answers (date + screenshot) in README §13 worklog

## Q1 — deployment criterion

> Hi team! Question on the deployment criterion. Our project is a confidential cross-chain USDC settlement over CCTP V2, so it is necessarily bi-chain: the user-facing leg (encrypted deposits, batching, epoch settlement, CCTP burn) is deployed on **Ethereum Sepolia**, and the distribution leg (CCTP mint + integrity check + confidential payout) on **Arbitrum Sepolia** — both calling the official unmodified CCTP V2 and Nox deployments. (a) Does the Ethereum Sepolia source leg satisfy the deployment requirement as stated in the brief? (b) If the requirement is instead Arbitrum Sepolia (as it was for Hack4Privacy and the Vibe Coding Challenge), does the bi-chain setup qualify via its Arbitrum Sepolia leg? A written yes/no on (a) or (b) would be great so we can log it. Thanks!

## Q2 — prior-project collision + shell reuse

> Second question: was there any project at the Vibe Coding Challenge or Hack4Privacy doing confidential/batched CCTP transfers, or cross-chain USDC settlement with Nox? We want to be certain we don't collide with prior work, since reuse of a prior project is disqualifying. Our concept: batch ERC-7984-encrypted USDC deposits on the source chain, bridge one public aggregate via CCTP V2 Fast Transfer with hookData, and gate confidential distribution on the destination behind a TEE-verified integrity check. (Relatedly: our frontend shell adapts UI scaffolding from our own earlier hackathon repo, with all protocol logic new — please confirm that's acceptable.) Happy to share more detail in DM.

## Status

- [ ] Q1 posted (date: )
- [ ] Q2 posted (date: )
- [ ] Q1 answered → log verbatim + date in worklog (risk R7 tracks non-answer; ~4-day trigger)
- [ ] Q2 answered → log verbatim + date in worklog
