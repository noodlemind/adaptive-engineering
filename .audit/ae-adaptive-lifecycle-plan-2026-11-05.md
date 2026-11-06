# Adaptive capability lifecycle implementation

## Accepted intent and authorization

The user explicitly authorized implementation of the enhancements discussed in this session: consented onboarding discovery of existing skills/agents/instructions; persistent discovery state and scoped ongoing refresh; a native decision agent with host-owned model selection and no external decision API; internal action approval and review/repair before human review; on-demand specialist acquisition; evidence-backed cross-session memory and recurring skill recommendations; and a source-linked visual change tour at human handoff. Preserve the complete shipped corpus. Evaluate a separately constructed minimal corpus at final verification. This authorization covers necessary corpus, runtime, host projection, tests, documentation, and an isolated reviewable PR; it does not authorize merge, release, or changing the user's actual host installation.

## Primitive boundary and overlap

Reuse existing resources/config/host setup/orient/review/compound operations. Add deterministic catalog and receipt/state operations to Harness. Add one internal decision-agent role for separate contextual judgment. Extend existing workflow skills and references; do not add public workflow wrappers or a command family. Existing static resource inventory, source-bound activation, review packets, personal writers, knowledge authority, and diagram receipts provide the foundation. First-needed specialist acquisition is distinct from promotion of repeated procedures into durable skills.

## Implementation phases

1. Persist user-owned discovery/standing-consent policy and a host-aware capability catalog. Refresh approved roots on setup, session orientation, cache miss, and resource changes. Keep exclusions and revocation effective. Route external resources consistently; bounded startup performs no model call.
2. Add native decision-agent contracts and durable action/readiness receipts, freshness and budget checks. Bind verdicts to the exact action, workspace, relevant source versions and consent revision. Treat host interception coverage explicitly. Do not add an inference endpoint or remove host permissions.
3. Support approved personal agent/instruction acquisition through native writers with expected-digest replacement checks, minimum tool authority and honest reload status. Resolve review providers from eligible installed capabilities; absence produces an acquisition path rather than silently accepting self-review or demanding a specific bundled agent.
4. Integrate recurrence candidates and evidence/resource identities into orientation and compounding. Preserve explicit instruction/correction authority and provisional inferred lessons. Reuse existing governance and scoped standing authorization.
5. Make visual change tours part of new human-review handoffs: behavioral delta, bounded application context, diagram-to-code reading order, verification and residual review questions, bound to reviewed source versions. Descriptive views are not formal proof.
6. Exercise complete and disposable minimal corpus installations through real CLI/host adapter paths. Keep live model/editor qualification separate from deterministic and agent-forward tests.

## Acceptance criteria

- AC1: User inclusion and ongoing discovery consent persist across processes; excluded or revoked resources cannot be selected; project content cannot broaden consent.
- AC2: Canonical external skills, agents and instructions in supported selected host roots are discovered, freshness checked, and surfaced as bounded relevant candidates without replacing the shipped corpus.
- AC3: Missing capabilities cause one bounded consented refresh, then an explicit acquire/blocked decision; native decisions use host agents and require no model API.
- AC4: First-needed specialists can be created, validated and subsequently resolved under authorized scope; unavailable native activation reports pending reload rather than fabricated invocation.
- AC5: Action decisions and review readiness are separate, exact-source-bound, budgeted and invalidated by changes/revocation; failed required checks cannot become ready.
- AC6: Repeated verified work and user corrections survive sessions and surface a reasoned reuse/update/create recommendation; inferred memory cannot silently replace explicit instructions.
- AC7: New review handoffs include a current, source-linked visual tour; stale or incomplete tours remain visible and cannot establish readiness.
- AC8: A packaged reduced-corpus fixture completes discovery, acquisition, review, verification, learning and tour handoff with external providers, while the full corpus remains unchanged in coverage.
- AC9: Existing full-corpus installation/upgrade/host/review/plan/knowledge contracts pass relevant regressions. No new parent-level command family or external inference dependency.

## Verification

Use TDD for runtime changes: observe the relevant new negative/behavior test fail before implementation. Run focused module and CLI integration tests, package/host/prompt checks, and the existing harness test suite. Add a rerunnable installed minimal-corpus evaluation with meaningful negative controls (missing provider, stale verdict/tour, revoked consent). Run independent code review of the final diff and forward-test Engineer guidance without leaking expected answers. Document actual results, native host/model limitations, and a visual review tour in this record and PR.

## Scope

packages/ae/lib/, packages/ae/corpus/, packages/ae/test/, packages/ae/eval/, packages/ae/scripts/, docs/adaptive-engineering.md, docs/diagrams/, AGENTS.md, README.md and this audit record. Generated exports change only through the existing generator. No dependency upgrades or unrelated refactors.

## Status

Implementation and frozen-source local bootstrap qualification complete; PR platform regression qualification is in progress. The original corpus remains present: 28 skills, 23 agents (including the new internal decision role), and 5 instructions.

Independent adversarial integration review identified and verified fixes for permission expansion, scoped publication races, pending-role activation, authored reviewer provenance, custom-profile hook binding, nested delegation, network aliases, and retained state capacity. Focused current-source integration suites pass, including native/Copilot writer and activation checks, actual observed review output, memory publication, and retained task/resource recurrence. Adapter events in these suites are labeled fixtures; they do not establish live editor or loaded-definition qualification.

The clean four-skill forward model trial repaired the payment retry defect (baseline 2/4 passed; treatment 4/4 passed), consulted supplied enterprise conventions, rendered a source-linked tour, and correctly retained failed verification/readiness because this environment has no named native reviewer/decision-role invocation. No invocation or completion record was invented. The installed matrix separately exercises full, reduced, and four-skill bootstrap packages, including required missing-provider acquisition. No release or merge is implied.

## Frozen-source bootstrap results

The fresh installed four-skill proof passed all 13 checks. Both authored and full installed corpus digests remained unchanged. It acquired and actually source-read missing `architect` and `code-review` skills, reported the absent reviewer, created a native specialist, rejected uncorrelated activation, consumed an exact first-invocation receipt, and retained observed activation and packet-bound reviewer results. Self-review and authored-only provenance were rejected. Behavioral verification detected the seeded defect before the fix. A current tour and passed proof supported the internal readiness result.

Two distinct verified tasks produced exact approved memory publications, source-bound skill recurrence and independently retained native specialist recurrence. The following session received a bounded visible recommendation; rich evidence remains expandable without exceeding orientation's render budget. Exclusion and consent revocation tests passed. These are native adapter fixtures, not live model/editor or loaded-definition qualification.

The exact local report is retained in [ae-adaptive-lifecycle-evaluation-2026-11-06.json](ae-adaptive-lifecycle-evaluation-2026-11-06.json), bound to implementation commit `27cc98446ce22b7a6bdaa0a9637c9068e196d806`. Default CI runs all three installed corpus cases. PR #114 carries current platform-check status and the ordered visual review tour.

The subsequent clean-revision default matrix at `6cffe2a94a717309ec6def648e23d66b622495b5` passed all three installed cases: full 11/11, reduced 11/11, and four-skill bootstrap 13/13. Both corpus-preservation checks passed. Its exact [matrix report](ae-adaptive-lifecycle-matrix-2026-11-06.json) is retained separately. Later compatibility followups preserve approved delegation across native/Copilot upgrades and initial consent, validate effective personal projections, restore safe lifecycle JSON authoring, and use the established Windows npm launcher. Their dedicated regressions and the latest-head platform checks qualify those deltas without relabeling the earlier reports.
