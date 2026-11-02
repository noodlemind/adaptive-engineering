# AE setup reliability audit — 2026-10-30

## Scope and evidence

This audit follows the mainstream reliability review and examines setup rather than
agent behavior: product initialization, orientation artifacts, runtime resolution,
installation and upgrade, editor discovery, doctor recovery, private/shared
configuration, version guidance and the supplied CI template. The baseline is local
`88152be1c077d49897f5d7adec1b92adbbd2ba05`, equivalent to published PR104 tree
`747b52e1090e4d6c76d6f1897c834a82e1bbcec1` at
`a1b28093dcc4e7eb83092d7905c60a024a43e1eb`.

Findings below describe the baseline. Repair status and exact qualification belong
to the final implementation and test receipts; an entry here does not independently
claim that its repair shipped. Static inspection and disposable Git/filesystem
fixtures establish the stated observations. No actual user's installation, editor
settings, repository trust, package registry or Java/TLC installation was changed.
Native Copilot/IntelliJ model behavior and exhaustive filesystem-failure
coverage require separate qualification; platform package results are distinguished below. The final implementation and exact
candidate qualification are recorded after the baseline findings below.

## Findings

| ID | Severity | Concrete failure | Root cause and required correction |
| --- | --- | --- | --- |
| S1 | P2 | Initialization introduces three untracked `.github/harness/*.yaml` files outside an unrelated source-only plan. | `lib/init-repo.mjs` writes shared configuration unconditionally. Select personal project storage for new private setup, explicitly choose shared configuration, and preserve established repository policy. |
| S2 | P2 | Hiding setup files with root `.gitignore` makes `.gitignore` the scope violation; hiding already tracked files does not suppress their edits. | Setup ownership and task scope are mixed. Do not waive shared policy or `.gitignore` from all plans. Resolve setup before the accepted product task and use local metadata for private artifacts. |
| S3 | P2 | `ae worktree` itself creates/changes root `.gitignore` with `.worktrees`. | `lib/worktree.mjs:ensureWorktreeIgnore` treats a machine-local checkout location as a shared product edit. Use safe Git-local exclude metadata, accounting for linked and separate Git directories. |
| S4 | P2 | Routine initialization/orientation leaves `.harness/.gitignore`, `run.mjs` and `repo-map.md` visible in Git status. | The ignore list in `lib/session.mjs` is incomplete. `.harness/**` is already excluded from Harness scope and product diff, so status noise and scope failures must not be conflated. Tool-owned runtime output should remain private. |
| S5 | P2 | A generated runner carrying a current version marker can retain obsolete installation advice. An unrelated unversioned `run.mjs` can be overwritten. | `lib/resolve-harness-bin.mjs:writeHarnessRunner` uses marker presence as freshness and otherwise rewrites blindly. Recognize owned generators, compare current generated content, preserve unrelated files, and refuse unsafe targets. Doctor must use the same status check. |
| S6 | P2 | A selected custom Copilot home receives installed assets while VS Code is configured to discover the default home. Doctor can then report that default discovery as valid. | `lib/vscode-settings.mjs` hardcodes `~/.copilot/{agents,instructions,skills,hooks}` and `doctor.mjs:vscodeDiscoveryConfigured` checks the same default. Derive discovery paths from the selected home and test actual installation output, including paths with spaces and existing unrelated locations. |
| S7 | P2 | README/tool contract promise a `.harness-version` or product `devDependency` pin, but generated runner can execute the global installation instead. | No runtime reader for `.harness-version` was found. Resolver prefers global overrides/shims/runtime/PATH; workspace runner does not resolve the product dependency. Remove unsupported pin claims or implement explicit, tested selection and compatibility. Do not imply arbitrary teammate-version compatibility. |
| S8 | P2 | The supplied verification workflow tries to download an unpublished registry package, then expects committed legacy plans and fresh CI trust/evidence. | `.github/workflow-templates/harness-plan-verification.yml` assumes a distribution/authority contract that current AE does not provide. Use an explicit reviewed archive/source setup contract, or retire the unsupported template. Do not automatically approve repository commands in CI. |
| S9 | P2 | Failed runtime upgrade can leave a new CLI entry point alongside old library files. | `lib/install-harness-bin.mjs` copies directly into final `.ae-bin` before the final installation lock is published. Stage and qualify a complete runtime with recoverable publication, or record a failed-install state that refuses mixed execution and gives deterministic repair. |
| S10 | P2 | Invalid VS Code JSONC or a nonobject root allowed apparent installation success or threw after hydration; legacy array-shaped discovery settings could silently discard selected locations during serialization. | Preflight every discovered profile before hydration, require a bounded regular JSONC object, preserve authored bytes, return `E_VSCODE_SETTINGS` (exit 5), and convert valid legacy location arrays to serializable object mappings. |
| S11 | P2 | A custom AE state home or derived project store inside the product checkout reintroduced private setup as product changes despite local-mode selection. | Reject physically in-checkout storage before initialization, promotion or authority selection; resolve existing ancestors, symlink aliases, the actual Git root and the derived project-store identity. |

### Reproductions and limits

**S1–S4:** A clean temporary Git product repository with a plan allowing only
`src/app.js` yields three scope violations after real `runInitRepo`:
`.github/harness/checks.yaml`, `policy.yaml`, and `routing.yaml`. Adding a root
`.gitignore` that hides `.github/harness/` and `.harness/` changes the result to the
single violation `.gitignore`. Force-tracking checks before ignoring and editing
retains both `checks.yaml` and `.gitignore` as changed product files. No
`.harness/**` path enters `collectChangedFiles`; that exclusion already exists.

**S5:** The baseline source contains no live `@devkit/harness` or
`npx @devkit/harness` recovery command. The current `INSTALL_FIX_HINT` uses a
checkout installation of `ae-harness`. The reported obsolete text can survive in a
previously generated product runner because its marker is accepted without
checking the rest of its content. The repair exercises stale generated content, including obsolete installation
advice, and preserves unrelated or newer runners. Source inspection alone cannot
identify the exact file from the user's machine; the implemented migration applies
to the recognized versioned generator contract.

**S6:** Baseline `mergeVSCodeSettings({})` emits default home locations and accepts
no selected-home input. The real `doctor-target-recovery.test.mjs` custom-home
fixture previously verified that V3 passed after configuration without asserting
that its discovery path equals the custom installed home. Both sides agreed on the
same incorrect default; this is an example of a passing test that misses the
product contract.

**S7:** Source search for `harness-version` finds the README and tool contract,
not runtime consumption. The old example pins version `0.13.0` although the current
package is `0.14.0`; updating the numeral alone would not fix selection.

**S8:** This finding is static. The package README explicitly says the package is
not published; the supplied template uses `npm install --global
"ae-harness@${HARNESS_VERSION}"`. It searches only changed `docs/plans/*.md`,
although fresh plans live in the external project store. It does not provision
human-approved execution authority, current review or accepted plan evidence for
the new runner. No live workflow or registry request was run for this audit.

**S9:** A tiny disposable package with `bin/ae.mjs` and `lib/helper.mjs` was
installed through the real `installHarnessBin`. Its source was changed, and an
injected `ENOSPC` was raised on the second actual `copyFileSync` call. The command
threw; reading the final installed directory returned new CLI bytes and old helper
bytes. This proves the partial-publication behavior under a selected I/O failure,
not that a real machine experienced disk exhaustion. The fixture was removed.

The local S9 repair stages the complete runtime and preserved unowned siblings,
then publishes the directory under the existing per-home lock. A small contained
journal binds stage/backup directory identities. Copy failures leave the old
runtime intact; publication failures restore it, and a later install can recover
a retained interrupted retirement. Invalid recovery metadata is retained and
refused. The new three positive failure reproductions initially failed 0/3; after
repair, the expanded five transaction tests and existing installation boundaries,
real CLI install/upgrade and lock-ownership selections passed 56/56 on Linux
Node24. That selected run does not establish a final-revision full-suite or Windows
result. Directory publication may briefly make the runtime absent; it does not
guarantee uninterrupted dynamic imports by an already-running process. Copilot
corpus and editor settings installation remain separate operations rather than a
single cross-directory transaction.

## Architecture direction

The highest-leverage change is one explicit setup identity: selected runtime,
selected customization home, selected state home and selected project authority.
Every setup and runtime consumer must resolve that same identity, and diagnostics
must describe the actual selected sources. Copies, marker strings and a successful
install command do not establish host activation or completed task proof.

1. New private setup stores project authority and private artifacts outside the
   product change set. Shared team authority is an explicit reviewed choice.
2. Existing shared policy is honored. Malformed, redirected or conflicting sources
   cannot silently choose another source or establish approval.
3. Approval remains user-local and binds the selected authority. It does not
   transfer through Git, certify transitive scripts or provide OS containment.
4. Shared policy edits remain normal scoped product edits. Runtime bookkeeping
   does not weaken plan scope, review freshness or proof binding.
5. Runtime refresh is ownership-aware and reports the actual executable selected.
   Recovery never downloads a renamed/unpublished package speculatively.
6. Qualification follows actual installed commands in isolated homes, not only
   matching helper implementations: fresh install, rerun, upgrade, clone, linked
   worktree, separate Git directory, missing runtime, custom home, invalid source,
   unrelated user files and interrupted publication.

## Remaining qualification boundaries

The source audit is broad within setup, but it is not an assertion that every
platform, editor or filesystem failure has been exercised. Cross-platform package
jobs must run the exact final candidate. Native model sessions must separately
show that the selected editor loads the selected files and preserves the intended
human authority boundary. A failed or untrusted named verification result cannot
be promoted to a passing completion record.


## Implemented setup contract

The source qualification revision is
`089afa7ae42be16e7e554490e4458dc2691b22aa`. Its runtime/package source is
`a73dc1a6c9d25dd9c4001994a32334ee18280f2b`; the final source revision adds a
metadata-invocation and selected-home fixture regression coverage without changing the package payload. The
published PR104 implementation snapshot is `b6d8ecb5723b0e781bdc30bfcc879de7b0d239d6`, tree
`2bdadae8987f7edb8baeded3fa2a845812af5741`. Later report-only changes do not
constitute a new runtime qualification.

| Finding | Implemented behavior | Evidence boundary |
| --- | --- | --- |
| S1–S2 | New `ae init-repo` selects private authority under the external project store. It reports selected paths and whether anything belongs in a product commit. Existing shared authority remains selected. | Actual personal initialization and orientation leave fresh product Git status and plan scope clean. Shared configuration remains ordinary reviewed scope. |
| S3–S4 | Git-local excludes keep runtime state and worktree directories private. Routine initialization/worktree setup does not edit the product's root `.gitignore`; a non-Git workspace retains local ignore compatibility. | Primary, linked and separate-Git-directory fixtures exercise safe metadata resolution and unsafe-target refusal. Git ignores do not hide modifications to already tracked files. |
| S5 | Runner version 8 refreshes recognized stale generated bytes using current `ae-harness` checkout guidance. Unsafe, unrelated and newer runners are preserved/refused. Doctor uses the same content-aware status. Explicit unavailable runtime selection fails instead of silently choosing another installation. | Generated runner execution and recovery are exercised. Windows npm `.cmd` discovery resolves the standard package entry directly without enabling a shell; native Windows qualification remains separate. |
| S6 | Installer and doctor derive agent, skill, instruction and hook locations from the selected Copilot home, preserving unrelated authored locations. | Actual custom-home install/recovery checks inspect generated settings rather than accepting agreement on a fixed default path. |
| S7 | Unsupported `.harness-version` and automatic product-dependency pin claims are removed. Documentation describes actual runtime selection. | This corrects a claim; it does not implement a new version selector or promise arbitrary-version compatibility. |
| S8 | The old automatic verification template becomes explicit manual plan diagnostics using a caller-selected qualified archive and SHA-256. It neither approves trust nor runs named product checks, and claims no delivery proof. | Template/contract checks pass. A production trusted CI delivery workflow still needs separately reviewed authority and portable evidence design. |
| S9 | Runtime files are fully staged before directory publication, using existing cooperative locking and an identity-bound recovery journal. Copy failure preserves old bytes; failed publication restores or retains recoverable state. | Injected copy/publish/rollback failures and real installed upgrade drives. Runtime-directory publication is not a transaction covering all corpus and editor writes. |
| S10 | Settings are validated across all discovered profiles before hydration. Malformed, redirected, nonregular, oversized or nonobject sources fail explicitly and preserve authored bytes. Valid legacy location arrays become object mappings before serialization. | Invalid JSON, array and null roots, multiple profiles, selected homes and legacy setting shapes are exercised. Concurrent arbitrary edits by another process are not a transactional guarantee. |
| S11 | Selected state homes and derived project stores must remain physically outside the product checkout, including parent-checkout and symlink-alias cases. | Reproduced direct/nested/aliased/derived storage failures now refuse before setup publication. |

`ae init-repo --shared` explicitly promotes personal authority into reviewable
`.github/harness/` files, preserving a private backup and reporting the exact commit
inventory, including optional `config.yaml`. Existing differing shared files,
unexpected files in the private authority directory, unsafe paths and conflicting
sources are refused. Incomplete publication can be retried only while the already
published bytes match. The source-mode change invalidates prior approval; no
approval is copied into the repository or into a teammate's home.

Private and shared configuration use one selected source rather than a permissive
layered overlay. Checks, readiness, policy, routing, configuration, hooks,
orientation and evidence resolve that same authority. Invalid present sources
cannot fall back to absent or permissive policy. Shared policy edits remain
subject to the accepted product plan and ordinary reapproval.

## Integration corrections discovered during qualification

1. **Explicit state-home propagation.** Introducing real external personal
   authority exposed delivery context and handoff paths that implicitly selected a
   different home. Context records, task handoffs and headless delivery now carry
   the same selected state home into authority and proof validation. This fixes
   current authority selection without weakening stale-context checks.
2. **Source provenance.** Fixtures and corpus navigation distinguish the selected
   personal authority path, actual installed/bundled primitive sources and product
   code. Tests that previously relied on implicit policy location were updated to
   establish the source they intend to test. A declaration or a matching filename
   is still not an activation or review-invocation attestation.
3. **Promotion completeness.** The exact shared inventory includes optional
   `config.yaml` in preview, publication and existing shared setup. Unexpected
   private entries and conflicting shared entries cannot disappear silently during
   promotion. Published source bytes and retained backup are checked.
4. **Operation-scoped identity reuse.** One read-only validation reuses the
   project-store identity through the existing Git observation cache. The key
   includes workspace and selected home. It does not cache policy bytes, suppress
   competing authority detection or carry an observation into later operations.
   Regression checks mutate policy, change home and introduce a competing source
   within the cached operation; each remains visible.
5. **Metadata invocation validation.** The corpus invocation validator now accepts
   supported `ae --version` and `ae -V` metadata examples. Typographical unknown
   commands and unknown flags still fail. This is a test-validator correction,
   not additional product-command permission.

## Exact candidate qualification

| Item | Observation |
| --- | --- |
| Qualified archive | `qualified-candidate/ae-harness-0.14.0.tgz`; 35,699,161 bytes. |
| Archive SHA-256 | `e724db8e6ae8d27915487c03c15bca5229add933e5ef4045705ad759ab3629cd` |
| Payload exclusions | Archive identity records empty JAR and pstack-parser payload lists. No runtime tool acquisition is part of setup. |
| Installed setup drive | The exact archive was installed offline with Node 20.0.0 into disposable homes. Personal init/orient remained clean; real check authority worked; shared promotion retained a backup and made prior approval stale; a teammate clone was untrusted; an eligible registered linked worktree inherited approval; actual selected-home installation and upgraded runtime executed. Receipt: `installed-qualified-receipt.json`. |
| Installed personal delivery | 28 actual commands completed from offline installation through initialization, fixture authority, accepted plan, gate, product edit, independent fixture review collection, behavioral verification, explicit no-learning decision, completion and current-completion validation. Verification contained 12 passed checks and one advisory structural skip; the final product diff contained only the intended source edit. Receipt: `personal-delivery-qualified-receipt.json`. |
| Retained fixture evidence | 28 evidence files were saved before removing the disposable fixture, including accepted plan, exact authority, product source, review packet, installed package identity and completion-related records; `snapshot-manifest.json` identifies saved files. Approval was granted only to synthetic disposable fixture authority, never the actual user checkout. |
| Broad setup integration selection | `setup-final-integration.log`: 152 tests, 139 passed, zero failed, 13 skipped. This selection overlaps other focused and full-suite runs and must not be added to their totals. |
| Oldest Node source selection | Node20.0.0 authority selection/regression file:13/13 passed, with a terminal summary in `node20-authority-single.log`. A separate multi-file run produced incomplete output and is not counted as a complete source qualification. Exact installed setup and delivery drives above independently establish the stated Node20.0.0 runtime results. |
| Complete source suite | Node24.22.1 on frozen source089afa7: **3,895 tests;3,833 passed,20 failed,42 skipped;exit1**,698.877 seconds. All20 actual failure names and process-identity-unavailable causes match untouched PR104 baseline34ccbf0 (27 selected baseline cases:7 passed,20 failed; not a complete baseline suite). Zero additional failures. Log SHA-256: `484b7e21e1d19c2ddec9c666342ee89c7bd1e388f779e7eae58e6723f456e577`. No control was weakened to obtain a green result. |
| Current GitHub qualification | Frozen published source `b6d8ecb5723b0e781bdc30bfcc879de7b0d239d6`: all four Linux/Windows Node20/24 package jobs passed ([run41064689952](https://github.com/noodlemind/prompt-library/actions/runs/41064689952)); documentation passed. Full Linux/Windows source workflows were still running at this observation. Later report/template-description-only commits have separate checks. |

Earlier 56/56 installer selection, 17/17 derived-home selection, 136/136 domain
selection and earlier oldest-Node selections are useful scoped historical evidence.
They ran on earlier implementation revisions; they are not substituted for final
candidate or complete-source results, and their overlapping totals are not summed.

The earlier `full-suite-64145ce`, `full-suite-4c627a2`, `full-suite-a23a102`,
context/home/authority full-run attempts and any runs affected by `ENOSPC` are
interrupted or invalidated diagnostics, not successful complete qualifications.
Disk exhaustion was corrected before the completed `full-qualified.tap` diagnostic rerun (3,895 tests;3,832 passed,21 failed,42 skipped). Its extra failure was an obsolete orientation fixture selecting the parent process home; the correction preserves stale-source and wrong-home refusal, and the affected orientation suite passed12/12. The authoritative final `full-exact-final.tap` rerun used clean, unchanged source089afa7 and produced the20-baseline-only result above. No incomplete or disk-exhausted run supplies final qualification.

## Evidence identity

The final classification accounts for20 actual failure blocks and matches their
names and causes to the untouched baseline. The baseline selected log SHA-256 is
`4c0c7aa4be4693218b299d9e13d89699273379f9bc8c63ebe44defd69526a806`.
This compares affected baseline cases; it does not assert a complete baseline suite.

The saved personal-delivery receipt SHA-256 is
`17c8b28484633fcbae085c3e2873d5ded7392bd200799202a62cec8c07845708`.
The actual independent fixture reviewer was a separate Codex invocation. AE
retained declared provenance rather than a native-host attestation. Development
checkout trust was never self-approved and no machine completion receipt for this
real checkout is claimed.

## Practical limits and next qualification

- Ordinary checks authorize declared commands under the user's process authority;
  they do not inspect all transitive script behavior or provide OS sandboxing.
  Correctness confidence comes from relevant behavioral checks, acceptance proof,
  review and current bindings rather than the approval action alone.
- Runtime state can remain physically under `.harness/` for compatibility while
  Git-local excludes keep fresh private setup out of product changes. Existing
  tracked files are not silently untracked or deleted. Converting legacy tracked
  setup requires an explicit reviewed repository change.
- A teammate's clone receives shared definitions, not another person's approval
  or private plans. A different AE version may need an upgrade; automatic version
  pin enforcement remains outside this change.
- Runtime publication can briefly make the active directory unavailable. It does
  not guarantee seamless dynamic imports by already-running processes or atomic
  installation across runtime, corpus and editor settings. Unknown or unsafe
  recovery state remains visible rather than being deleted automatically.
- Installed command and hook fixtures do not establish native Copilot/IntelliJ
  model behavior. IntelliJ customization installation still does not establish
  native lifecycle hook support. The manual CI diagnostics template is not a
  trusted delivery/completion workflow.

The next promotion step is **one release-qualified native first-delivery journey**,
with the same archive as the CLI control. Start with Windows VS Code/Copilot and
measure actual user intervention rather than adding more setup abstractions.

1. Run fresh personal setup, one-file bug delivery and interruption/resume on the
   exact candidate. Observe actual skill loading, selected-home discovery,
   mutation admission, required review, named proof and completion in the editor.
2. Repeat with shared team setup, a second user clone and an eligible linked
   worktree. Change pinned authority once and confirm an explicit new human
   decision is required; routine recovery should remain agent-owned.
3. Exercise stale intent, missing runtime, invalid settings, conflicting
   configuration and failed behavior. Record every human intervention, retry,
   false refusal and completion claim. Safety negatives must refuse with an
   actionable explanation, and an unsupported host must state its limits.
4. Promote only with zero authority violations or false completion claims,
   successful intended scope/evidence handling and no manual edits to internal
   lifecycle state. Set automation-rate and intervention targets from repeated
   measured native runs; the deterministic fixture success above is not that
   measurement.

The pivotal assumption is that accepting a concrete project execution authority
once per relevant authority change is sufficient for ordinary delivery while AE
owns routine recovery. Test it through these native runs: count whether a person
must repeatedly reconstruct setup, repair hidden state or expand a product plan
merely to accommodate AE bookkeeping.
