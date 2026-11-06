import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileNoFollow, writeFileContained } from './fs-safe.mjs';
import { ensureHarnessDir } from './session.mjs';
import { preparationIsCurrent, reviewHash, stableJson } from './review-preparation.mjs';
import { renderDiagram } from './diagrams/render.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const ID = /^[a-f0-9]{64}$/;
const componentId = /^[a-z][a-z0-9-]{0,63}$/;
const fail = message => Object.assign(new Error(`review tour: ${message}`), { code: 'E_USAGE', exit: 2, hint: 'ae help review' });
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000 || /[\0]/.test(value)) throw fail(`${label} requires bounded nonempty text`);
  return value.trim();
}
function list(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 128) throw fail(`${label} requires ${minimum}–128 entries`);
  return value;
}
function readJson(root, rel) {
  try { return JSON.parse(readFileNoFollow(path.join(root, rel), { root, maxBytes: 1024 * 1024 }) || 'null'); } catch { return null; }
}
function write(root, rel, content) {
  if (Buffer.byteLength(content) > 4 * 1024 * 1024 || !ensureHarnessDir(root) || !writeFileContained(root, rel, content)) throw fail(`cannot publish ${rel}`);
}
function sourceRef(workspace, ref) {
  if (!ref || typeof ref.path !== 'string' || !ref.path || /[\\\0\r\n<>\[\]()#]/.test(ref.path) || path.isAbsolute(ref.path) || path.win32.isAbsolute(ref.path) || path.posix.normalize(ref.path) !== ref.path || ref.path.split('/').includes('..') || ref.path.startsWith('.harness/')) throw fail('source path must name a regular product file');
  const bytes = readFileNoFollow(path.join(workspace, ref.path), { root: workspace, encoding: null, maxBytes: 1024 * 1024 });
  if (bytes === null || bytes.includes(0)) throw fail(`source is absent, unsafe or unreadable: ${ref.path}`);
  const lines = bytes.toString('utf8').split(/\r?\n/);
  if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > lines.length) throw fail(`source line is invalid: ${ref.path}`);
  if (ref.symbol !== undefined && (!text(ref.symbol, 'symbol') || /[\r\n]/.test(ref.symbol) || !lines[ref.line - 1].includes(ref.symbol))) throw fail(`source symbol is absent at the named line: ${ref.path}:${ref.line}`);
  return { path: ref.path, line: ref.line, ...(ref.symbol === undefined ? {} : { symbol: ref.symbol }), sha256: digest(bytes) };
}

function normalizeInput(workspace, packet, input) {
  if (!input || input.schema !== 1 || input.packet !== packet.id) throw fail('input must bind schema 1 and the exact review packet');
  const refs = new Map();
  const capture = ref => { const value = sourceRef(workspace, ref); refs.set(value.path, { path: value.path, sha256: value.sha256 }); return value; };
  const components = list(input.context?.components, 'context.components').map(value => {
    if (!componentId.test(value?.id || '') || !['changed', 'context'].includes(value.role)) throw fail('context component needs a unique id and changed/context role');
    return { id: value.id, label: text(value.label, 'component label'), role: value.role, source: capture(value.source) };
  });
  const ids = new Set(components.map(value => value.id));
  if (ids.size !== components.length || !components.some(value => value.role === 'changed')) throw fail('context requires unique components and a changed component');
  const edges = list(input.context?.edges, 'context.edges').map(value => {
    if (!ids.has(value?.from) || !ids.has(value?.to) || !['observed', 'inferred'].includes(value.kind)) throw fail('context edge must name existing components and observed/inferred evidence');
    return { from: value.from, to: value.to, claim: text(value.claim, 'edge claim'), kind: value.kind, evidence: list(value.evidence, 'edge evidence').map(capture) };
  });
  const readingOrder = list(input.readingOrder, 'readingOrder').map(value => {
    if (!ids.has(value?.component)) throw fail('reading step must name a context component');
    return { step: text(value.step, 'reading step'), component: value.component, code: list(value.code, 'reading code').map(capture), tests: list(value.tests, 'reading tests', 0).map(capture) };
  });
  const covered = new Set(readingOrder.flatMap(value => [...value.code, ...value.tests].map(ref => ref.path)));
  const required = packet.preparation.refs.filter(ref => ref.origin === 'product' && ref.state === 'regular' && packet.scope.changedFiles?.includes(ref.path));
  if (required.some(ref => !covered.has(ref.path))) throw fail('reading order omits a changed source or test');
  const verification = list(input.verification, 'verification').map(value => ({ claim: text(value.claim, 'verification claim'), refs: list(value.refs, 'verification refs').map(capture) }));
  return { input: { schema: 1, packet: packet.id, purpose: text(input.purpose, 'purpose'), before: text(input.before, 'before'), after: text(input.after, 'after'), context: { summary: text(input.context?.summary, 'context summary'), components, edges }, readingOrder, verification, risks: list(input.risks, 'risks', 0).map(value => text(value, 'risk')), questions: list(input.questions, 'questions', 0).map(value => text(value, 'review question')) }, sources: [...refs.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

function assertPacketCurrent({ workspace, packet, currentScope, plan, home, copilotHome }) {
  const { id, createdAt, ...value } = packet || {};
  if (!ID.test(id || '') || reviewHash(value) !== id) throw fail('review packet is missing or tampered');
  if (stableJson(currentScope) !== stableJson(packet.scope) || !preparationIsCurrent(workspace, packet.preparation, { plan, home, copilotHome })) throw fail('review packet or source scope is stale');
}

const markdownText = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[`\[\]]/g, '\\$&');
const diagramLabel = value => value.replace(/["\r\n<>]/g, ' ').slice(0, 180);
function diagramOf(input) {
  const nodes = new Map(input.context.components.map((value, index) => [value.id, `N${index}`]));
  return ['flowchart TD', ...input.context.components.map(value => `  ${nodes.get(value.id)}["${diagramLabel(value.label)} (${value.role})"]`), ...input.context.edges.map(value => `  ${nodes.get(value.from)} -->|"${diagramLabel(value.claim)}${value.kind === 'inferred' ? ' (inferred)' : ''}"| ${nodes.get(value.to)}`)].join('\n');
}
function markdownOf(input, packet, markdownPath, diagram, workspace, recordRoot) {
  const link = ref => `[${markdownText(ref.path)}:${ref.line}${ref.symbol ? ` ${markdownText(ref.symbol)}` : ''}](${path.relative(path.dirname(path.join(recordRoot, markdownPath)), path.join(workspace, ref.path)).replace(/\\/g, '/').replace(/ /g, '%20')}#L${ref.line})`;
  const lines = ['# Change review tour', '', markdownText(input.purpose), '', `Review packet: \`${packet.id}\`. Head: \`${packet.scope.head || 'captured source scope'}\`.`, '', '## Behavioral change', '', `Before: ${markdownText(input.before)}`, '', `After: ${markdownText(input.after)}`, '', '## Application context', '', markdownText(input.context.summary), '', 'Descriptive, source-linked interpretation; rendered edges are review judgments, not execution or formal proof.', '', '```mermaid', diagram, '```', ''];
  for (const component of input.context.components) lines.push(`- ${markdownText(component.label)} (${component.role}): ${link(component.source)}`);
  for (const edge of input.context.edges) lines.push(`- ${markdownText(edge.from)} → ${markdownText(edge.to)}: ${markdownText(edge.claim)} (${edge.kind}); ${edge.evidence.map(link).join(', ')}`);
  lines.push('', '## Reading order', '');
  input.readingOrder.forEach((value, index) => lines.push(`${index + 1}. ${markdownText(value.step)} Code: ${value.code.map(link).join(', ')}. Tests: ${value.tests.map(link).join(', ') || 'none in this step'}.`));
  lines.push('', '## Verification evidence', '', ...input.verification.map(value => `- ${markdownText(value.claim)} ${value.refs.map(link).join(', ')}`), '', '## Risks and assumptions', '', ...(input.risks.length ? input.risks.map(value => `- ${markdownText(value)}`) : ['No residual risks declared.']), '', '## Human review questions', '', ...(input.questions.length ? input.questions.map(value => `- ${markdownText(value)}`) : ['No open questions declared.']), '');
  return lines.join('\n');
}

/** Author and render an immutable tour. The caller must rederive currentScope. */
export async function createReviewTour({ workspace, recordRoot = workspace, packet, input, currentScope, plan, home, copilotHome, dryRun = false }) {
  const options = { workspace, packet, currentScope, plan, home, copilotHome };
  assertPacketCurrent(options);
  const normalized = normalizeInput(workspace, packet, input);
  const diagram = diagramOf(normalized.input);
  const rendered = await renderDiagram({ source: diagram });
  assertPacketCurrent(options);
  if (stableJson(normalizeInput(workspace, packet, input).sources) !== stableJson(normalized.sources)) throw fail('source changed during rendering');
  const contentId = reviewHash({ packet: packet.id, ...normalized, diagram });
  const directory = `.harness/reviews/tours/${contentId}`;
  const markdownPath = `${directory}/tour.md`, svgPath = `${directory}/context.svg`;
  const markdown = markdownOf(normalized.input, packet, markdownPath, diagram, workspace, recordRoot);
  const value = { schema: 1, packet: packet.id, scope: packet.scope, ...normalized, diagram, markdownPath, svgPath, markdownSha256: digest(markdown), svgSha256: digest(rendered.svg) };
  const record = { ...value, id: reviewHash(value), recordedAt: new Date().toISOString() };
  const recordPath = `${directory}/record.json`;
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw fail('tour record exceeds the 1 MiB storage/read limit; narrow the tour');
  if (!dryRun) {
    write(recordRoot, markdownPath, markdown); write(recordRoot, svgPath, rendered.svg);
    write(recordRoot, recordPath, serialized);
    write(recordRoot, `.harness/reviews/tours/latest/${packet.id}.json`, `${JSON.stringify({ id: record.id, recordPath })}\n`);
  }
  return { ...record, recordPath, persisted: !dryRun };
}

export function validateReviewTour({ workspace, recordRoot = workspace, packet, currentScope, plan, home, copilotHome }) {
  let record = null;
  try {
    assertPacketCurrent({ workspace, packet, currentScope, plan, home, copilotHome });
    const pointer = readJson(recordRoot, `.harness/reviews/tours/latest/${packet.id}.json`);
    if (!ID.test(pointer?.id || '') || !/^\.harness\/reviews\/tours\/[a-f0-9]{64}\/record\.json$/.test(pointer?.recordPath || '')) throw fail('current tour is missing');
    record = readJson(recordRoot, pointer.recordPath);
    if (!record) throw fail('tour record is missing');
    const { id, recordedAt, ...value } = record;
    if (id !== pointer.id || reviewHash(value) !== id || record.packet !== packet.id || stableJson(record.scope) !== stableJson(packet.scope)) throw fail('tour record is tampered or bound to another packet');
    const expectedDirectory = path.posix.dirname(pointer.recordPath);
    if (record.markdownPath !== `${expectedDirectory}/tour.md` || record.svgPath !== `${expectedDirectory}/context.svg`) throw fail('tour artifact paths are invalid');
    const current = normalizeInput(workspace, packet, record.input);
    if (stableJson(current.sources) !== stableJson(record.sources) || diagramOf(current.input) !== record.diagram) throw fail('tour context sources changed');
    for (const [file, expected] of [[record.markdownPath, record.markdownSha256], [record.svgPath, record.svgSha256]]) {
      const bytes = readFileNoFollow(path.join(recordRoot, file), { root: recordRoot, encoding: null, maxBytes: 4 * 1024 * 1024 });
      if (!bytes || digest(bytes) !== expected) throw fail('tour artifact bytes changed or disappeared');
    }
    return { pass: true, id, packet: packet.id, recordPath: pointer.recordPath, markdownPath: record.markdownPath, svgPath: record.svgPath, sources: record.sources, message: 'Current source-linked review tour' };
  } catch (error) { return { pass: false, id: record?.id || null, message: error.message }; }
}
