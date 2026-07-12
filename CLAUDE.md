# CLAUDE.md
Single source of truth: docs/SPEC.md (internal spec + worklog; the root README.md is the public overview). Before ANY edit, read §7 (constraints),
§12 (guardrails G1–G10, session protocol, build order), §13 (STATE, decisions, worklog).
Follow the §12 session protocol: plan first, small verified steps, MANDATORY
append-only worklog entry + STATE update at session end. Never contradict a
logged decision (D-001…D-011) without flagging it as a decision-change request.
Implementation plan: docs/PLAN.md (approved 2026-07-12, session S3) — phases,
contract design w/ per-function ACL map, test pyramid, risk register.
Any iExec-tooling friction → one line in feedback.md immediately (G9).
