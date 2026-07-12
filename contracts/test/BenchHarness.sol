// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";

/// @title BenchHarness — Phase-0b latency spike (docs/PLAN.md). TEST-ONLY.
/// @notice Exercises the full Nox round-trip (encryptInput -> fromExternal ->
/// encrypted op -> allow/allowPublicDecryption) so scripts can time the KMS RTT.
/// Not part of Manifold; single-EOA; never deployed in the demo flow.
contract BenchHarness {
    euint256 public last; // last ingested handle (== the external input handle)
    euint256 public sum; // running encrypted sum (fresh computed handle)
    euint256 public chainRes; // result of the chained op (fresh handle)

    constructor() {
        // Nox: a euint256 field is NOT a valid zero by default.
        sum = Nox.toEuint256(0);
        Nox.allowThis(sum);
    }

    /// metric 2 (fromExternal tx) + sets up metric 4 (client decrypt of `last`)
    function ingest(externalEuint256 h, bytes calldata proof) external {
        euint256 v = Nox.fromExternal(h, proof);
        last = v;
        Nox.allowThis(v);
        Nox.allow(v, msg.sender);
    }

    /// metric 3 (encrypted op tx): add an external input into the running sum
    function addToSum(externalEuint256 h, bytes calldata proof) external {
        euint256 v = Nox.fromExternal(h, proof);
        (, euint256 s) = Nox.safeAdd(sum, v);
        sum = s;
        Nox.allowThis(sum);
        Nox.allow(sum, msg.sender);
    }

    /// metric 5 (idle-handle reveal RTT): mark `last` publicly decryptable
    function revealLast() external {
        Nox.allowPublicDecryption(last);
    }

    /// metric 7 (production-shaped RTT): 3x fromExternal + safeAdd fold + eq +
    /// select + allowPublicDecryption, all in ONE tx (proves same-tx symbolic
    /// chaining and measures runner catch-up on the whole op DAG).
    function chained(
        externalEuint256 h1,
        bytes calldata p1,
        externalEuint256 h2,
        bytes calldata p2,
        externalEuint256 h3,
        bytes calldata p3,
        uint256 expected
    ) external {
        euint256 t = Nox.toEuint256(0);
        (, t) = Nox.safeAdd(t, Nox.fromExternal(h1, p1));
        (, t) = Nox.safeAdd(t, Nox.fromExternal(h2, p2));
        (, t) = Nox.safeAdd(t, Nox.fromExternal(h3, p3));
        ebool ok = Nox.eq(t, Nox.toEuint256(expected));
        euint256 r = Nox.select(ok, Nox.toEuint256(1), Nox.toEuint256(0));
        chainRes = r;
        Nox.allowThis(r);
        Nox.allowPublicDecryption(r);
    }
}
