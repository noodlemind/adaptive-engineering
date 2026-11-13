// Deterministic scoring for the review-recall eval. It reads assembled review
// records; it never runs a model or a reviewer. See README.md.

export const SCORE_SCHEMA = 'review-recall-score-v1';

const unitLine = value => Number.isSafeInteger(value) && value > 0;
const norm = file => String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
// The verified-out findings an assembled record lists under `suppressed`.
const refutedOf = record => (Array.isArray(record?.suppressed) ? record.suppressed : []).filter(f => /Refuted by decision-agent verification/.test(f?.reason || ''));

/** Pair findings with expected defects: same file, line within the window, closest first, one-to-one. */
export function matchFindings(defects, findings, { lineWindow = 8 } = {}) {
  const pairs = [];
  for (const [di, defect] of defects.entries()) {
    for (const [fi, finding] of findings.entries()) {
      if (norm(finding?.file) !== norm(defect.file) || !unitLine(finding?.line)) continue;
      const distance = Math.abs(finding.line - defect.line);
      if (distance <= lineWindow) pairs.push({ di, fi, distance });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance || a.di - b.di || a.fi - b.fi);
  const usedD = new Set(), usedF = new Set(), matched = [];
  for (const pair of pairs) {
    if (usedD.has(pair.di) || usedF.has(pair.fi)) continue;
    usedD.add(pair.di); usedF.add(pair.fi); matched.push(pair);
  }
  return { matched, missed: defects.filter((_, i) => !usedD.has(i)), unmatched: findings.filter((_, i) => !usedF.has(i)) };
}

/** Score one arm. `records` maps case id to its assembled review record (or null when the arm produced none). */
export function scoreArm({ cases, records, protocol }) {
  const lineWindow = protocol?.match?.lineWindow ?? 8;
  const perClass = new Map(), perCase = [];
  let expected = 0, found = 0, defectFindings = 0, cleanFindings = 0, unmatchedFindings = 0, refuted = 0, judged = 0;
  for (const item of cases) {
    const record = records?.[item.id] ?? null;
    const findings = Array.isArray(record?.findings) ? record.findings : [];
    for (const f of findings) if (f?.verification) judged += 1;
    const refutedHere = refutedOf(record);
    refuted += refutedHere.length; judged += refutedHere.length;
    if (!item.defects.length) {
      cleanFindings += findings.length;
      perCase.push({ id: item.id, kind: 'clean', reviewed: Boolean(record), findings: findings.length });
      continue;
    }
    const result = matchFindings(item.defects, findings, { lineWindow });
    expected += item.defects.length; found += result.matched.length;
    defectFindings += findings.length; unmatchedFindings += result.unmatched.length;
    for (const [i, defect] of item.defects.entries()) {
      const row = perClass.get(defect.flow_class) || { expected: 0, found: 0 };
      row.expected += 1;
      if (result.matched.some(pair => pair.di === i)) row.found += 1;
      perClass.set(defect.flow_class, row);
    }
    perCase.push({ id: item.id, kind: 'defects', reviewed: Boolean(record), expected: item.defects.length, found: result.matched.length, missed: result.missed.map(d => `${d.file}:${d.line}`), unmatched: result.unmatched.length });
  }
  const ratio = (a, b) => b ? Number((a / b).toFixed(3)) : null;
  return {
    schema: SCORE_SCHEMA,
    recall: ratio(found, expected), found, expected,
    perClassRecall: Object.fromEntries([...perClass].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, { ...v, recall: ratio(v.found, v.expected) }])),
    // Unmatched findings on defect cases may still be real; this is a lower bound on precision, not precision.
    precisionProxy: ratio(found, defectFindings), unmatchedFindings,
    cleanFindings, verifiedRefutedShare: ratio(refuted, judged),
    cases: perCase,
  };
}

/** Validate the frozen case file shape; returns a list of problems (empty when valid). */
export function validateCases(file) {
  const problems = [];
  if (file?.schema !== 'review-recall-cases-v1' || !Array.isArray(file.cases)) return ['cases.json needs schema review-recall-cases-v1 and a cases array'];
  const ids = new Set();
  for (const item of file.cases) {
    const label = item?.id || '(no id)';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item?.id || '')) problems.push(`${label}: invalid id`);
    if (ids.has(item?.id)) problems.push(`${label}: duplicate id`);
    ids.add(item?.id);
    if (!['development', 'held-out'].includes(item?.split)) problems.push(`${label}: split must be development or held-out`);
    for (const key of ['base', 'head']) if (!/^[a-f0-9]{40}$/.test(item?.[key] || '')) problems.push(`${label}: ${key} must be a full commit id`);
    if (!Array.isArray(item?.defects)) { problems.push(`${label}: defects must be an array`); continue; }
    for (const defect of item.defects) {
      if (typeof defect?.file !== 'string' || defect.file.startsWith('/') || defect.file.split('/').includes('..')) problems.push(`${label}: defect file must be repository-relative`);
      if (!unitLine(defect?.line)) problems.push(`${label}: defect line must be a positive integer`);
      if (typeof defect?.summary !== 'string' || !defect.summary.trim()) problems.push(`${label}: defect needs a summary`);
    }
  }
  if (!file.cases.some(c => c.defects?.length === 0)) problems.push('at least one clean control case is required');
  return problems;
}
