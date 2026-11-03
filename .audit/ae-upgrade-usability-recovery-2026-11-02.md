# Upgrade and delivery recovery

## Problem and acceptance

An existing workspace can report `trusted: true`, shared authority and zero named checks. Earlier guidance sent the user back to manual configuration. Engineer could not acquire an implement gate without checks, while the same gate was required to edit the missing shared check declarations. Review recording was incorrectly described as unavailable too. Successful installation and isolated command tests did not establish a usable delivery journey.

The acceptance target is a working path for existing trusted workspaces and fresh private workspaces, with no changes to an already usable configuration and no request for approval before a concrete command policy is prepared. CI turnaround is part of that developer experience.

## Implementation decisions

1. Keep configuration trust and check readiness separate. Upgrade, initialization, orientation, trust status and plan-start refusals report the selected check source and recovery action. Configured commands are not a behavioral verification pass.
2. Extend the existing `ae checks` surface with one configuration-only operation. A schema-1 decision supplies the observed source digest, named command declarations and rationale. It upserts only the selected check file, preserves other YAML and comments, refuses stale or redirected sources, and preserves concurrent successors. It never executes the declarations or approves trust.
3. Admit only that installed, workspace-bound writer before an implement gate. After a check change, bounded inspection and plan repair remain available; execution, arbitrary edits and agent trust approval do not gain permission. Copilot, Claude Code, Codex and Cursor use the same operation. The existing headless tool and two typed MCP tools cover the same recovery.
4. Engineer inspects actual test assertions, chooses the execution checkout, prepares concrete declarations, shows the changed commands for any necessary person approval, and resumes the authorized task afterward. Existing usable checks are left alone. Review recording is independent of executable-check readiness; final proof still needs meaningful checks and current review.
5. Refuse an unconfigured repository subfolder when shared configuration exists at its Git root, with an explicit root retry. Do not silently inherit parent authority or enlarge execution scope. Preserve independently configured nested projects.
6. A named Node test run must execute its assertions even when launched from another Node test process. Drop the inherited internal runner marker rather than accepting a skipped nested run as a pass.
7. Version the repaired runtime as `0.14.1`, so installed upgrades can distinguish it from `0.14.0`.
8. Reuse only normalized Git repository identity during explicit synchronous read phases: gate result computation, orientation fact collection, read-only status validation and retention configuration lookup. Key observations by workspace and the sanitized child environment. Keep storage aliases, competing authority sources, policy, trust, HEAD and changed files live. End the phase before executable checks, journal append/prune, final context capture or gate/evidence publication; reject asynchronous callbacks and deactivate retained contexts.
9. Healthy pre-hook control operations do not need a policy CLI bootstrap. Observe policy when a critical/destructive candidate or mutating gate path needs a decision instead. Preserve session identity, changed-binding and out-of-plan checks before the healthy control return, and fail closed on denial-path observation failures.

## CI changes and measurement

The preceding green candidate used about 717 seconds for the complete Linux suite. Four Windows shards took 1740–2176 seconds each; aggregate qualification finished at roughly 38 minutes. Package Windows Git regression selection took about 601 seconds before the archive drive. The old scheduling inventory covered only 221 of 298 source files.

Refresh scheduling weights from all 298 measured passing file results. Run the complete source suite in four Linux and twelve Windows shards, with the existing aggregate names retained. Run package archive qualification in parallel with the same nine Git regression suites; split the Windows regression inventory across three batches for each Node version. Require exact source revision, platform, runtime, every expected shard and every expected file before the aggregate passes. Node 20 reporting must supply complete terminal counters as well as actual file completion.

No tests or security assertions are removed. The slowest measured Windows file is about 731 seconds, so file-level scheduling alone cannot justify a sub-ten-minute full qualification promise. New elapsed times and queue effects must be measured on this PR before claiming the improvement.

Runtime profiling also exposed repeated work beneath the schedule. The intent-lock recipe made 799 Git calls after batching its identical 13-file fixture setup, including 505 origin reads during project-store resolution. Retention configuration lookups for event and run-journal logging accounted for 330 origin reads. The read-phase optimization reduced the same successful recipe to 462 Git calls (42.2% fewer), including 168 origin reads, with the identical tracked tree and all 13 sibling specs. It retains no mutable authority or retention verdict. Healthy controls previously started three policy CLI processes across the pre-hook chain; regression tests require zero while denied mutations still refresh policy and approval. These are measured process counts, not a Windows elapsed-time guarantee; hosted qualification remains required.

## Validation plan

- Existing trusted shared empty configuration: upgrade preserves policy and approval while reporting missing readiness; real hook admission permits concrete preparation; trust becomes stale; one fixture-simulated person approval permits the actual plan/start, failing-before/passing-after behavioral check, review assembly, verification, compounding and completion.
- Existing populated configuration: upgrade preserves exact bytes and approval, without repeating setup.
- Fresh private configuration: discovery and preparation use the external selected source and create no shared overlay or agent approval.
- Closed command grammar on all four native/Copilot adapters; equivalent headless and MCP recovery; execution and authority-injection negatives remain denied.
- Stale digests, competing sources, redirected files and concurrent successors refuse without overwriting user changes.
- The nested Node test regression proves assertions actually ran and rejected the unchanged behavior.
- Complete Linux/Windows source inventory and Ubuntu/Windows Node 20/24 package qualification remain required.
- Read phases must reobserve changed origins on the next public call; aliases, selected homes, competing sources and policy/check bytes must remain live within a phase. HEAD, diff and domain observations must bypass identity-only reuse, including nested validators and asynchronous continuations.
- Native pre-hook admission and denial cases must retain their permissions and existing execution deadlines while unnecessary policy process starts disappear.

## Evidence limits

Disposable fixtures exercise real CLI operations, hooks and behavioral assertions. Their synthetic review rows test the review protocol and do not attest to native model identity or judgment. No user's project trust is approved by this change. Live editor/model qualification remains distinct from these automated journeys. Exact-head CI results belong in the PR description after execution; this document does not claim pending runs passed.
