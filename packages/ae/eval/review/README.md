# Review recall eval (scaffold)

This eval measures whether AE code review finds the defects that matter, learning from how specialist review services judge themselves: by the bugs they catch before merge and the noise they add.

It is a scaffold. The cases, protocol and scorer are frozen and tested; no arm has been run.

## Cases

`cases.json` holds pre-fix heads of merged AE pull requests (#121, #122, #124) whose defects an external reviewer found after AE's own review. Each expected defect names the file and line from that review thread, a flow class from [flow tracing](../../corpus/skills/code-review/references/flow-tracing.md), and a one-line summary. Every defect was confirmed and fixed in the pull request. Two clean controls review the merged results; they carry no known defect, which is not proof that none exists.

Every case is development data. The probe lists in flow tracing were learned from these same pull requests, so recall on them measures fit to lessons the corpus already encodes. Held-out cases must come from defects found after the corpus is frozen, ideally in another repository; a test fails if corpus text quotes a held-out defect.

## Arms

`protocol.json` compares arms incrementally on one model, host and budget: the review at main `ced3f9f1`, then the flow ledger, the packet impact section, decision-agent verification and learned review rules, each added to the last.

## Scoring

`score.mjs` matches each assembled finding to an expected defect by file and a line window (8 lines), one to one, closest first. It reports recall, recall per flow class, a precision lower bound on defect cases, findings on clean controls, and the share of judged findings the decision agent refuted.

## Run

```bash
node eval/review/run.mjs                       # dry run: validates cases and commits, prints the trial plan
node eval/review/run.mjs --score <records-dir> # scores <dir>/<arm>/<case>.json review records
```

`--live` is a placeholder: run each arm in a host with `ae review prepare` and `ae review assemble`, save each assembled record, then score the directory. No model runs in CI.
