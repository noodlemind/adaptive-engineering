# Installed adaptive lifecycle evaluation

Run from the repository root:

```sh
node packages/ae/scripts/prove-adaptive-lifecycle.mjs
node --test packages/ae/test/adaptive-lifecycle.test.mjs
```

The evaluator creates an npm tarball, installs it offline, and runs the installed CLI in disposable product, host, enterprise and state roots. `--keep` retains those roots and prints their directory for inspection. The source corpus is never pruned; the reducer explicitly refuses the source package. Every CLI child has a read probe that rejects access to the original source corpus.

The test command can also write its complete JSON proof using `AE_LIFECYCLE_REPORT=/absolute/report.json`; `AE_LIFECYCLE_KEEP=1` retains its fixture roots for inspection.

The proof script accepts `--case full`, `--case minimal` or `--case sparse` for a targeted installed-package check. Its report names the evaluated cases explicitly. The default script and test both run all three cases.

| Case | Retained capability | Required behavior |
| --- | --- | --- |
| Full | Complete packaged corpus, with consent selecting the enterprise review provider | Use the selected external provider and preserve full source assets |
| Minimal | Explicit core workflow dependency closure; Engineer and decision roles only | Acquire a missing specialist and finish verified review, tour and learning |
| Bootstrap | Four skills: Engineer, ensure-plan, create-primitive and ensure-capability; two agent roles; no eligible existing reviewer | Acquire and source-load missing architecture and code-review skills; create, activate and use the native reviewer to complete verification, tour, readiness and learning |

The payment fixture contains a real duplicate-charge defect. Its behavioral checks must reject that defect before the repair can pass. The lifecycle also tests separate inclusion/ongoing consent, fresh-process discovery, bounded cache misses, observed native decision receipts, changed-source and revoked-consent invalidation, same-context review refusal, source-linked rendered tours, explicit teaching, and both external skill and observed reviewer recurrence across distinct verified tasks. Replaying one learning publication cannot create another task use.

Newly created native specialists start unavailable with `pending-reload` activation. The fixture admits one exact invocation attempt using an observed action decision, rejects receipt replay, and requires a correlated native completion before availability changes. It retains the current approved source digest while reporting the native loader's source hash as unverified. Full and minimal cases reuse the selected enterprise reviewer. The bootstrap case excludes that provider, verifies the missing-provider prerequisite, then creates and activates a reviewer whose actual selected native path supplies the observed review results. Authored provenance alone is rejected. It also creates and reads skills, whose exact source can become available without native role reload.

The bootstrap case preserves those four skills' references, shared plan operations and diagram references, native hooks/adapters, and knowledge schemas. Recall, memory publication and review validation execute in the installed CLI; their optional prose skills are absent until acquired. Architecture and code review are the two absent workflow skills this task actually acquires. Other absent procedures, such as model setup or document review, are outside this payment task. The separate forward test evaluates whether an Engineer selects the required workflow; deterministic CLI coverage alone cannot establish model routing behavior.

Native completion and resource-read payloads are deterministic adapter fixtures. They do not establish live editor activation, host transcript authenticity, model judgment quality or causal resource effectiveness. Those limits remain in the JSON report.

For a separate clean-agent forward test, import `prepareForwardAdaptiveFixture` from `lifecycle.mjs` with an absolute source `packageRoot`, a new disposable `directory`, and `corpus: 'full'`, `'minimal'` or `'sparse'`. Give the new agent only its returned `prompt` and selected installed assets. Keep evaluator source, repair constants and report assertions outside the agent's supplied context. The generic task prompt contains the business requirement and selected setup, without revealing expected routing decisions. Record its actual calls and outcome separately from this deterministic evaluation.
