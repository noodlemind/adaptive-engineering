#!/usr/bin/env node
// Builds the animated SVG walkthroughs in docs/diagrams/animated/ from the scene
// timelines below. Node built-ins only: no browser, video encoder or package install.
//
//   node scripts/build-doc-animations.mjs          write the SVGs
//   node scripts/build-doc-animations.mjs --check  exit 1 if a committed SVG is stale
//
// Each scene is a timeline, in seconds, of where the task token is, which stage is in
// focus and what the caption says. The output is a self-contained SVG animated with CSS
// keyframes. GitHub renders it as an image, it follows the reader's light or dark
// preference, and it shows a static summary when the reader prefers reduced motion.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/diagrams/animated');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n.toFixed(2)).toString();

// A track is a list of [seconds, css-declarations] points, rendered as keyframes.
function keyframes(name, points, duration) {
  const sorted = [];
  for (const [t, value] of points) {
    let at = Math.min(Math.max(t, 0), duration);
    const last = sorted[sorted.length - 1];
    if (last && at <= last[0]) at = last[0] + 0.001;
    sorted.push([Math.min(at, duration), value]);
  }
  if (!sorted.length || sorted[0][0] > 0) sorted.unshift([0, sorted[0]?.[1] ?? 'opacity:0']);
  if (sorted[sorted.length - 1][0] < duration) sorted.push([duration, sorted[sorted.length - 1][1]]);
  const body = sorted.map(([t, value]) => `${(t / duration * 100).toFixed(3)}%{${value}}`).join('');
  return `@keyframes ${name}{${body}}`;
}

// Opacity that is 1 inside each [start, end] window and fades over `fade` seconds.
function windowsTrack(windows, fade = 0.25) {
  const merged = [];
  for (const [start, end] of [...windows].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    // Back-to-back windows stay lit instead of blinking off and on.
    if (last && start <= last[1] + 0.01) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const points = [[0, 'opacity:0']];
  for (const [start, end] of merged) {
    points.push([start, 'opacity:0'], [start + fade, 'opacity:1'], [end - fade, 'opacity:1'], [end, 'opacity:0']);
  }
  return points;
}

function wrapLines(text, size, x, y, cls, lineHeight = 1.3) {
  const lines = Array.isArray(text) ? text : [text];
  const top = y - ((lines.length - 1) * size * lineHeight) / 2;
  return lines.map((line, i) => `<text class="${cls}" x="${num(x)}" y="${num(top + i * size * lineHeight)}">${esc(line)}</text>`).join('');
}

function render(scene) {
  const { id, title, description, width, height, duration, nodes, edges = [], steps, marks = [], legend = [], staticCaption } = scene;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const css = [];
  const body = [];
  const center = (ref) => {
    if (typeof ref === 'string') {
      const n = byId.get(ref);
      if (!n) throw new Error(`${id}: unknown node ${ref}`);
      // The token rides the top edge so it never covers a box's text.
      return { x: n.x + n.w / 2, y: n.y };
    }
    return ref;
  };

  // Edges sit under the nodes.
  for (const e of edges) {
    const cls = `edge${e.kind ? ` edge-${e.kind}` : ''}`;
    body.push(`<path class="${cls}" d="${e.d}" marker-end="url(#${id}-arrow${e.kind ? `-${e.kind}` : ''})"/>`);
    if (e.label) body.push(`<text class="edge-label${e.kind ? ` edge-label-${e.kind}` : ''}" x="${e.label.x}" y="${e.label.y}"${e.label.anchor ? ` text-anchor="${e.label.anchor}"` : ''}>${esc(e.label.text)}</text>`);
  }

  // Focus windows per node, derived from the steps.
  const focus = new Map(nodes.map((n) => [n.id, []]));
  steps.forEach((step, i) => {
    const end = i + 1 < steps.length ? steps[i + 1].t : duration - 0.6;
    for (const f of step.focus || []) {
      if (!focus.has(f)) throw new Error(`${id}: focus on unknown node ${f}`);
      focus.get(f).push([step.t, end]);
    }
  });

  for (const n of nodes) {
    const kind = n.kind || 'neutral';
    const rx = n.shape === 'pill' ? n.h / 2 : 12;
    body.push(`<g class="node node-${kind}">`);
    body.push(`<rect class="box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}"/>`);
    const windows = focus.get(n.id);
    if (windows.length) {
      const name = `${id}-hl-${n.id}`;
      css.push(`.${name}{animation:${name} ${duration}s linear infinite}`, keyframes(name, windowsTrack(windows), duration));
      body.push(`<rect class="hl ${name}" x="${n.x - 3}" y="${n.y - 3}" width="${n.w + 6}" height="${n.h + 6}" rx="${rx + 3}"/>`);
    }
    const cx = n.x + n.w / 2;
    if (n.sub) {
      const subLines = Array.isArray(n.sub) ? n.sub : [n.sub];
      const titleY = n.y + n.h / 2 - (subLines.length * 13) / 2 + 2;
      body.push(wrapLines(n.label, 15, cx, titleY, 'title'));
      body.push(wrapLines(subLines, 11.5, cx, titleY + 13 + ((subLines.length - 1) * 11.5 * 1.3) / 2 + 4, 'sub'));
    } else {
      body.push(wrapLines(n.label, 15, cx, n.y + n.h / 2 + 5, 'title'));
    }
    if (n.owner) body.push(`<text class="owner owner-${kind}" x="${n.x + 10}" y="${n.y + 15}">${esc(n.owner)}</text>`);
    body.push('</g>');
  }

  // Marks: badges and cards that appear for a window of time.
  for (const m of marks) {
    const name = `${id}-mk-${m.id}`;
    css.push(`.${name}{animation:${name} ${duration}s linear infinite}`, keyframes(name, windowsTrack(m.windows), duration));
    body.push(`<g class="mark ${name}${m.final ? ' final' : ''}">${m.svg}</g>`);
  }

  // The task token moves between step positions.
  const tokName = `${id}-tok`;
  const tokPoints = [];
  const tokOpacity = [[0, 'opacity:0']];
  let prev = null;
  steps.forEach((step) => {
    if (!step.at) return;
    const p = center(step.at);
    const pos = (q) => `transform:translate(${num(q.x)}px,${num(q.y)}px)`;
    if (!prev) {
      tokPoints.push([0, pos(p)], [step.t, pos(p)]);
      tokOpacity.push([step.t, 'opacity:0'], [step.t + 0.3, 'opacity:1']);
    } else {
      tokPoints.push([step.t, pos(prev)], [step.t + (step.move ?? 0.7), pos(p)]);
    }
    prev = p;
  });
  tokOpacity.push([duration - 0.9, 'opacity:1'], [duration - 0.4, 'opacity:0']);
  css.push(`.${tokName}{animation:${tokName} ${duration}s ease-in-out infinite}`, keyframes(tokName, tokPoints, duration));
  css.push(`.${tokName}-o{animation:${tokName}-o ${duration}s linear infinite}`, keyframes(`${tokName}-o`, tokOpacity, duration));
  body.push(`<g class="${tokName}-o anim"><g class="${tokName}"><circle class="tok-glow" r="15"/><circle class="tok" r="8"/></g></g>`);

  // Captions, one per step that has one.
  const capY = height - 26;
  steps.forEach((step, i) => {
    if (!step.caption) return;
    const end = i + 1 < steps.length ? steps[i + 1].t : duration - 0.6;
    const name = `${id}-cap-${i}`;
    css.push(`.${name}{animation:${name} ${duration}s linear infinite}`, keyframes(name, windowsTrack([[step.t, end]], 0.3), duration));
    body.push(`<text class="caption anim ${name}" x="${width / 2}" y="${capY}">${esc(step.caption)}</text>`);
  });
  body.push(`<text class="caption static" x="${width / 2}" y="${capY}">${esc(staticCaption)}</text>`);

  // Progress bar along the bottom edge.
  css.push(`.${id}-bar{animation:${id}-bar ${duration}s linear infinite}`, keyframes(`${id}-bar`, [[0, 'transform:scaleX(0)'], [duration, 'transform:scaleX(1)']], duration));

  const legendSvg = legend.map((l, i) => {
    const x = width - 24 - (legend.length - i) * 112;
    return `<g class="node-${l.kind}"><rect class="box" x="${x}" y="20" width="14" height="14" rx="4"/><text class="legend" x="${x + 20}" y="31">${esc(l.label)}</text></g>`;
  }).join('');

  const style = `
:root{--bg:#ffffff;--panel:#f6f8fa;--ink:#1f2328;--muted:#59636e;--line:#afb8c1;--eng:#0969da;--eng-t:#ddf4ff;--har:#1a7f37;--har-t:#dafbe1;--rev:#8250df;--rev-t:#fbefff;--you:#9a6700;--you-t:#fff8c5;--deny:#cf222e;--deny-t:#ffebe9;--ok:#1a7f37;--neutral:#59636e;--neutral-t:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--ink:#e6edf3;--muted:#9198a1;--line:#656c76;--eng:#4493f8;--eng-t:#0c2d6b;--har:#3fb950;--har-t:#0f2e1a;--rev:#ab7df8;--rev-t:#2b1c4a;--you:#d29922;--you-t:#3b2a06;--deny:#f85149;--deny-t:#4c1a1a;--ok:#3fb950;--neutral:#9198a1;--neutral-t:#161b22}}
svg{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.bg{fill:var(--bg)}
.heading{fill:var(--ink);font-size:18px;font-weight:600}
.legend{fill:var(--muted);font-size:12px}
.box{stroke-width:1.5}
.node-engineer .box{fill:var(--eng-t);stroke:var(--eng)}
.node-harness .box{fill:var(--har-t);stroke:var(--har)}
.node-review .box{fill:var(--rev-t);stroke:var(--rev)}
.node-you .box{fill:var(--you-t);stroke:var(--you)}
.node-neutral .box{fill:var(--neutral-t);stroke:var(--line)}
.node-deny .box{fill:var(--deny-t);stroke:var(--deny)}
.hl{fill:none;stroke-width:3.5;opacity:0}
.node-engineer .hl{stroke:var(--eng)}.node-harness .hl{stroke:var(--har)}.node-review .hl{stroke:var(--rev)}.node-you .hl{stroke:var(--you)}.node-neutral .hl{stroke:var(--ink)}.node-deny .hl{stroke:var(--deny)}
.title{fill:var(--ink);font-size:15px;font-weight:600;text-anchor:middle}
.sub{fill:var(--muted);font-size:11.5px;text-anchor:middle}
.owner{font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.owner-engineer{fill:var(--eng)}.owner-harness{fill:var(--har)}.owner-review{fill:var(--rev)}.owner-you{fill:var(--you)}.owner-neutral{fill:var(--muted)}
.edge{fill:none;stroke:var(--line);stroke-width:1.6}
.edge-loop{stroke:var(--deny);stroke-dasharray:5 4}
.edge-feed{stroke:var(--har);stroke-dasharray:5 4}
.arrow{fill:var(--line)}.arrow-loop{fill:var(--deny)}.arrow-feed{fill:var(--har)}
.edge-label{fill:var(--muted);font-size:11px}
.edge-label-loop{fill:var(--deny)}.edge-label-feed{fill:var(--har)}
.tok{fill:var(--you);stroke:var(--bg);stroke-width:2}
.tok-glow{fill:var(--you);opacity:.25}
.mark{opacity:0}
.badge-deny{fill:var(--deny)}.badge-ok{fill:var(--ok)}
.badge-text{fill:#ffffff;font-size:13px;font-weight:700;text-anchor:middle}
.chip-text{fill:var(--ink);font-size:11.5px;font-weight:600;text-anchor:middle}
.chip-sub{fill:var(--muted);font-size:10.5px;text-anchor:middle}
.caption{fill:var(--ink);font-size:14.5px;text-anchor:middle;opacity:0}
.static{opacity:0}
.bar-track{fill:var(--panel)}
.bar{fill:var(--you);transform-box:fill-box;transform-origin:left center}
@media (prefers-reduced-motion:reduce){
  *{animation:none !important}
  .anim,.hl,.bar{opacity:0 !important}
  .static,.mark.final{opacity:1 !important}
}
${css.join('\n')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc">
<title id="${id}-title">${esc(title)}</title>
<desc id="${id}-desc">${esc(description)}</desc>
<defs>
<style>${style}</style>
<marker id="${id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow" d="M0 0L10 5L0 10z"/></marker>
<marker id="${id}-arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-loop" d="M0 0L10 5L0 10z"/></marker>
<marker id="${id}-arrow-feed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrow-feed" d="M0 0L10 5L0 10z"/></marker>
</defs>
<rect class="bg" width="${width}" height="${height}" rx="14"/>
<text class="heading" x="24" y="33">${esc(title)}</text>
${legendSvg}
${body.join('\n')}
<rect class="bar-track" x="0" y="${height - 6}" width="${width}" height="6"/>
<rect class="bar ${id}-bar" x="0" y="${height - 6}" width="${width}" height="6"/>
</svg>
`;
}

const badge = (x, y, kind, text) => `<circle class="badge-${kind}" cx="${x}" cy="${y}" r="13"/><text class="badge-text" x="${x}" y="${y + 4.5}">${esc(text)}</text>`;
const chip = (x, y, w, kind, text, sub) => `<g class="node-${kind}"><rect class="box" x="${x}" y="${y}" width="${w}" height="${sub ? 38 : 26}" rx="8"/><text class="chip-text" x="${x + w / 2}" y="${y + 17}">${esc(text)}</text>${sub ? `<text class="chip-sub" x="${x + w / 2}" y="${y + 31}">${esc(sub)}</text>` : ''}</g>`;
const label = (x, y, cls, text) => `<text class="${cls}" x="${x}" y="${y}">${esc(text)}</text>`;

// ---------------------------------------------------------------------------
// Scene 1: one Deliver task, from request to evidence-bound report.
// ---------------------------------------------------------------------------
const W1 = 960;
const col = (i) => 40 + i * 230;
const R1 = 110;
const R2 = 262;
const BW = 190;
const BH = 84;
const deliver = {
  id: 'deliver-loop',
  title: 'A Deliver task, step by step',
  description: 'Animated walkthrough of an AE Deliver task. The Harness orients the task. An edit attempted before the plan is locked is denied by the host hook. The Engineer writes the plan and the Harness locks it and grants the implement gate. The Engineer works, independent reviewers assess the diff, and ae verify runs the named checks. A failing check sends the task back to work; after repair and fresh review the checks pass on the final bytes. The Engineer decides what the task taught, the Harness stores it, and the report carries the evidence.',
  width: W1,
  height: 440,
  duration: 26,
  legend: [{ kind: 'engineer', label: 'Engineer' }, { kind: 'harness', label: 'Harness (ae)' }, { kind: 'review', label: 'Reviewers' }],
  staticCaption: 'Orient, lock intent, gate, work, review, verify, compound, report. A failing check sends the task back to work.',
  nodes: [
    { id: 'you', x: 40, y: 50, w: 150, h: 34, shape: 'pill', kind: 'you', label: 'Your request' },
    { id: 'orient', x: col(0), y: R1, w: BW, h: BH, kind: 'harness', owner: 'Harness', label: '1 Orient', sub: ['context pack: specs, plans,', 'past learnings'] },
    { id: 'plan', x: col(1), y: R1, w: BW, h: BH, kind: 'engineer', owner: 'Engineer + Harness', label: '2 Lock intent', sub: ['goal, criteria, named checks;', 'Harness locks and hashes specs'] },
    { id: 'gate', x: col(2), y: R1, w: BW, h: BH, kind: 'harness', owner: 'Harness + host hook', label: '3 Gate', sub: ['implement gate granted;', 'no gate, no edit'] },
    { id: 'work', x: col(3), y: R1, w: BW, h: BH, kind: 'engineer', owner: 'Engineer', label: '4 Work', sub: ['edits inside the plan scope,', 'focused tests as it goes'] },
    { id: 'review', x: col(3), y: R2, w: BW, h: BH, kind: 'review', owner: 'Independent', label: '5 Review', sub: ['specialists assess', 'the exact diff'] },
    { id: 'verify', x: col(2), y: R2, w: BW, h: BH, kind: 'harness', owner: 'Harness', label: '6 Verify', sub: ['ae verify runs named checks,', 'no shell, on these bytes'] },
    { id: 'compound', x: col(1), y: R2, w: BW, h: BH, kind: 'engineer', owner: 'Engineer + Harness', label: '7 Compound', sub: ['what did this teach?', 'stored outside the repo'] },
    { id: 'report', x: col(0), y: R2, w: BW, h: BH, kind: 'harness', owner: 'Engineer + Harness', label: '8 Report', sub: ['what changed + evidence;', 'completion recorded'] },
  ],
  edges: [
    { d: `M115 84 L115 ${R1 - 2}` },
    { d: `M${col(0) + BW} ${R1 + BH / 2} L${col(1) - 2} ${R1 + BH / 2}` },
    { d: `M${col(1) + BW} ${R1 + BH / 2} L${col(2) - 2} ${R1 + BH / 2}` },
    { d: `M${col(2) + BW} ${R1 + BH / 2} L${col(3) - 2} ${R1 + BH / 2}` },
    { d: `M${col(3) + BW / 2} ${R1 + BH} L${col(3) + BW / 2} ${R2 - 2}` },
    { d: `M${col(3)} ${R2 + BH / 2} L${col(2) + BW + 2} ${R2 + BH / 2}` },
    { d: `M${col(2)} ${R2 + BH / 2} L${col(1) + BW + 2} ${R2 + BH / 2}` },
    { d: `M${col(1)} ${R2 + BH / 2} L${col(0) + BW + 2} ${R2 + BH / 2}` },
    { kind: 'loop', d: `M${col(2) + BW - 30} ${R2} C${col(2) + BW - 10} ${R2 - 40}, ${col(3) - 20} ${R1 + BH + 30}, ${col(3) + 30} ${R1 + BH + 2}`, label: { x: col(2) + BW - 44, y: R2 - 18, text: 'check fails: repair', anchor: 'end' } },
    { kind: 'feed', d: `M${col(0)} ${R2 + BH / 2} C${col(0) - 26} ${R2 + BH / 2}, ${col(0) - 26} ${R1 + BH / 2}, ${col(0) - 2} ${R1 + BH / 2}`, label: { x: col(0) + 12, y: (R1 + BH + R2) / 2 + 4, text: 'learnings feed the next task' } },
  ],
  marks: [
    { id: 'deny', windows: [[3.6, 6.4]], svg: `${badge(col(2) + BW - 8, R1 + 6, 'deny', '✕')}${chip(col(2) + 18, R1 - 40, 154, 'deny', 'edit denied: no gate')}` },
    { id: 'granted', windows: [[8.0, 25.4]], svg: badge(col(2) + BW - 8, R1 + 6, 'ok', '✓') },
    { id: 'fail', windows: [[13.6, 16.0]], svg: `${badge(col(2) + BW - 8, R2 + 6, 'deny', '✕')}${chip(col(2) + 28, R2 + BH + 10, 134, 'deny', 'behavior: failed')}` },
    { id: 'pass', windows: [[19.0, 25.4]], svg: `${badge(col(2) + BW - 8, R2 + 6, 'ok', '✓')}${chip(col(2) + 28, R2 + BH + 10, 134, 'harness', 'behavior: passed')}` },
    { id: 'learned', windows: [[21.0, 25.4]], svg: chip(col(1) + 25, R2 + BH + 10, 140, 'engineer', 'learning recorded') },
  ],
  steps: [
    { t: 0.2, at: 'you', focus: ['you'], caption: 'You ask the Engineer for an outcome. A change runs in Deliver mode.' },
    { t: 1.8, at: 'orient', focus: ['orient'], caption: 'The Harness orients the task: a small context pack of specs, plans and past learnings.' },
    { t: 3.6, at: 'gate', focus: ['gate'], move: 0.9, caption: 'An edit before the plan is locked? The host hook denies it.' },
    { t: 6.4, at: 'plan', focus: ['plan'], caption: 'The Engineer writes the plan. The Harness locks it and records a hash of each spec.' },
    { t: 8.0, at: 'gate', focus: ['gate'], caption: 'Plan locked, implement gate granted. Now edits inside the scope are allowed.' },
    { t: 9.6, at: 'work', focus: ['work'], caption: 'The Engineer edits within the plan scope and runs focused tests as it goes.' },
    { t: 11.4, at: 'review', focus: ['review'], caption: 'Independent reviewers assess the exact diff. The author never reviews itself.' },
    { t: 13.2, at: 'verify', focus: ['verify'], caption: 'ae verify runs the named checks. One fails, so the task is not done.' },
    { t: 15.6, at: 'work', focus: ['work'], move: 0.9, caption: 'Back to work. A failing or missing check is never a pass.' },
    { t: 17.0, at: 'review', focus: ['review'], caption: 'The diff changed, so the old review is stale. Review runs again.' },
    { t: 18.6, at: 'verify', focus: ['verify'], caption: 'Checks pass on the final bytes. The evidence is bound to them.' },
    { t: 20.6, at: 'compound', focus: ['compound'], caption: 'The Engineer decides what the task taught. The Harness stores it outside your repo.' },
    { t: 22.6, at: 'report', focus: ['report'], caption: 'The report carries the evidence. The next task starts with what this one learned.' },
  ],
};

// ---------------------------------------------------------------------------
// Scene 2: how the Engineer grows as verified tasks compound.
// ---------------------------------------------------------------------------
const grows = {
  id: 'engineer-grows',
  title: 'How the Engineer grows',
  description: 'Animated walkthrough of capability growth in AE. The Engineer starts with the Harness and nothing else. Each verified task leaves a private episode; /consolidate turns episodes into learnings that orient injects into the next task. When a task needs an independent reviewer the catalog lacks, the gap is recorded and, under direct or standing authorization, /create-primitive adds the smallest separate role. A procedure that keeps recurring becomes a durable skill only with verified promotion evidence.',
  width: 960,
  height: 500,
  duration: 28,
  legend: [{ kind: 'engineer', label: 'Engineer' }, { kind: 'harness', label: 'Harness (ae)' }, { kind: 'you', label: 'You' }],
  staticCaption: 'Verified work leaves episodes, episodes become learnings, and gaps become skills or specialists, within the authority you grant.',
  nodes: [
    { id: 'tasks', x: 30, y: 70, w: 160, h: 34, shape: 'pill', kind: 'you', label: 'Tasks you ask for' },
    { id: 'engineer', x: 260, y: 100, w: 220, h: 92, kind: 'engineer', owner: 'Engineer', label: 'Engineer', sub: ['your host model,', 'one shared contract'] },
    { id: 'kernel', x: 260, y: 220, w: 220, h: 72, kind: 'harness', owner: 'Harness', label: 'orient · gate · verify', sub: 'records evidence' },
    { id: 'episodes', x: 600, y: 90, w: 150, h: 70, kind: 'harness', owner: 'Private', label: 'Episodes', sub: 'from a publish decision' },
    { id: 'learnings', x: 790, y: 90, w: 150, h: 70, kind: 'harness', owner: 'Knowledge store', label: 'Learnings', sub: 'written only by ae' },
    { id: 'gap', x: 600, y: 214, w: 150, h: 70, kind: 'neutral', owner: 'Gap', label: 'Missing capability', sub: '/ensure-capability' },
    { id: 'authority', x: 790, y: 214, w: 150, h: 70, kind: 'you', owner: 'You', label: 'Authority', sub: 'direct or standing grant' },
    { id: 'toolbelt', x: 260, y: 318, w: 680, h: 76, kind: 'neutral', owner: 'Capabilities the Engineer has acquired', label: '' },
  ],
  edges: [
    { d: 'M190 87 C225 87, 230 120, 258 128' },
    { d: 'M370 192 L370 218' },
    { d: 'M480 130 L598 125' },
    { kind: 'feed', d: 'M750 125 L788 125' },
    { kind: 'feed', d: 'M865 88 C865 70, 400 70, 380 96', label: { x: 620, y: 64, text: 'orient brings matching learnings into the next task', anchor: 'middle' } },
    { d: 'M480 170 C540 190, 560 240, 598 248' },
    { d: 'M750 249 L788 249' },
    { d: 'M865 284 L865 316' },
  ],
  marks: [
    { id: 'day1', windows: [[0.2, 3.0]], svg: `<text class="sub" x="600" y="368" text-anchor="middle">Nothing acquired yet: the Engineer and the Harness are a complete setup.</text>` },
    { id: 't1', windows: [[1.4, 5.2]], svg: chip(30, 120, 160, 'you', 'Task 1: fix importer') },
    { id: 'v1', windows: [[3.2, 5.2]], svg: badge(470, 112, 'ok', '✓') },
    { id: 'ep1', windows: [[4.2, 27.4]], final: true, svg: chip(604, 168, 72, 'harness', 'episode 1') },
    { id: 'l1', windows: [[6.4, 27.4]], final: true, svg: chip(794, 168, 72, 'harness', 'learning 1') },
    { id: 't2', windows: [[8.4, 18.6]], svg: chip(30, 120, 160, 'you', 'Task 2: payment retry') },
    { id: 'need', windows: [[10.4, 14.6]], svg: chip(30, 166, 160, 'deny', 'needs a security reviewer') },
    { id: 'grant', windows: [[12.4, 14.6], [21.6, 27.4]], final: true, svg: badge(928, 222, 'ok', '✓') },
    { id: 'sec', windows: [[14.6, 27.4]], final: true, svg: chip(286, 344, 190, 'review', 'security reviewer', 'specialist, once the host loads it') },
    { id: 'v2', windows: [[16.4, 18.6]], svg: badge(470, 112, 'ok', '✓') },
    { id: 'ep2', windows: [[17.0, 27.4]], final: true, svg: chip(678, 168, 72, 'harness', 'episode 2') },
    { id: 'l2', windows: [[18.0, 27.4]], final: true, svg: chip(868, 168, 72, 'harness', 'learning 2') },
    { id: 't3', windows: [[19.6, 25.0]], svg: chip(30, 120, 160, 'you', 'Task 3: same procedure') },
    { id: 'evidence', windows: [[20.6, 24.4]], svg: chip(612, 296, 138, 'neutral', 'promotion evidence') },
    { id: 'skill', windows: [[22.8, 27.4]], final: true, svg: chip(496, 344, 190, 'engineer', 'retry-safety skill', 'candidate until its evals pass') },
    { id: 'more', windows: [[24.4, 27.4]], final: true, svg: chip(706, 344, 200, 'neutral', 'next: whatever the work proves', 'never acquired speculatively') },
  ],
  steps: [
    { t: 0.2, focus: ['engineer', 'kernel'], caption: 'Day one: one Engineer and the Harness. No skills or specialists are acquired yet.' },
    { t: 1.4, at: 'tasks', focus: ['tasks'], caption: 'Task 1 arrives. The Engineer delivers it through the Harness gates.' },
    { t: 2.6, at: 'engineer', focus: ['engineer', 'kernel'], caption: 'Checks pass on the final bytes, so the task is verified.' },
    { t: 4.0, at: 'episodes', focus: ['episodes'], caption: 'If the task taught something, the Engineer records a private episode. It stays on your machine.' },
    { t: 6.0, at: 'learnings', focus: ['learnings'], caption: '/consolidate turns episodes into learnings. Only ae commands write that store.' },
    { t: 8.0, at: 'tasks', focus: ['tasks'], move: 1.0, caption: 'Task 2 arrives.' },
    { t: 9.2, at: 'engineer', focus: ['engineer', 'learnings'], caption: 'Orient brings the learnings that match it into the task context.' },
    { t: 10.4, at: 'gap', focus: ['gap'], caption: 'The task needs an independent security reviewer the catalog does not have.' },
    { t: 12.4, at: 'authority', focus: ['authority'], caption: 'Acquisition needs your direct authorization or a standing grant that covers it.' },
    { t: 14.4, at: { x: 381, y: 344 }, focus: ['toolbelt'], caption: '/create-primitive adds the smallest separate role. It is used only once the host has loaded it.' },
    { t: 16.0, at: 'engineer', focus: ['engineer', 'kernel'], caption: 'With the new reviewer available, Task 2 is reviewed independently and verified.' },
    { t: 17.0, at: 'episodes', focus: ['episodes', 'learnings'], caption: 'Another episode, another learning. Knowledge compounds from verified work.' },
    { t: 19.4, at: 'tasks', focus: ['tasks'], move: 1.0, caption: 'Task 3 repeats a procedure that earlier tasks needed too.' },
    { t: 20.6, at: { x: 681, y: 296 }, focus: ['gap'], caption: 'A repeated procedure becomes a durable skill only with verified promotion evidence.' },
    { t: 21.6, at: 'authority', focus: ['authority'], caption: 'Creating it still needs authority that covers it.' },
    { t: 22.8, at: { x: 591, y: 344 }, focus: ['toolbelt'], caption: 'It starts as a candidate and becomes active only after its trigger and outcome evals pass.' },
    { t: 24.4, at: 'engineer', focus: ['engineer'], caption: 'The Engineer grows from proven work, within the authority you granted.' },
  ],
};

// ---------------------------------------------------------------------------
// Scene 3: the decision-agent judges an exact action and issues a receipt.
// ---------------------------------------------------------------------------
const DX = (i) => 30 + i * 232;
const decision = {
  id: 'decision-receipt',
  title: 'The decision-agent and its receipts',
  description: 'Animated walkthrough of a decision-agent judgment. The Engineer proposes an exact action. The Harness prepares a bounded request that freezes the action, source hashes, consent revision and budgets. The host runs the read-only decision-agent role, on a small model where the host allows it. The Harness records the observed native reply as a receipt tied to that exact action. When the tool call arrives, the hook allows it only if the receipt matches and every remaining Harness guard passes. A changed argument does not match the receipt and needs a fresh judgment.',
  width: 960,
  height: 440,
  duration: 22,
  legend: [{ kind: 'engineer', label: 'Engineer' }, { kind: 'harness', label: 'Harness (ae)' }, { kind: 'review', label: 'decision-agent' }],
  staticCaption: 'A receipt approves one exact action. It never grants trust, user authority or scope, and never replaces named checks.',
  nodes: [
    { id: 'propose', x: DX(0), y: 96, w: 200, h: 92, kind: 'engineer', owner: 'Engineer', label: 'Propose action', sub: ['tool, full input, cwd', 'and the sources it reads'] },
    { id: 'prepare', x: DX(1), y: 96, w: 200, h: 92, kind: 'harness', owner: 'Harness', label: 'Prepare', sub: ['freeze action, source hashes,', 'consent revision, budgets'] },
    { id: 'judge', x: DX(2), y: 96, w: 200, h: 92, kind: 'review', owner: 'Host role, read-only', label: 'decision-agent', sub: ['small model where the host', 'allows; else inherits'] },
    { id: 'record', x: DX(3), y: 96, w: 200, h: 92, kind: 'harness', owner: 'Harness', label: 'Record receipt', sub: ['observed native reply', 'bound to the exact action'] },
    { id: 'call', x: DX(1), y: 250, w: 200, h: 92, kind: 'engineer', owner: 'Engineer', label: 'Tool call', sub: 'the host runs the action' },
    { id: 'hook', x: DX(2) + 116, y: 250, w: 200, h: 92, kind: 'harness', owner: 'Host hook + Harness', label: 'Guard', sub: ['receipt matches and', 'every other guard passes'] },
  ],
  edges: [
    { d: `M${DX(0) + 200} 142 L${DX(1) - 2} 142` },
    { d: `M${DX(1) + 200} 142 L${DX(2) - 2} 142` },
    { d: `M${DX(2) + 200} 142 L${DX(3) - 2} 142` },
    { d: `M${DX(0) + 100} 188 C${DX(0) + 100} 296, ${DX(1) - 60} 296, ${DX(1) - 2} 296` },
    { d: `M${DX(1) + 200} 296 L${DX(2) + 114} 296` },
    { kind: 'feed', d: `M${DX(3) + 100} 190 C${DX(3) + 100} 240, ${DX(2) + 300} 236, ${DX(2) + 290} 248`, label: { x: DX(3) + 108, y: 244, text: 'receipt' } },
  ],
  marks: [
    { id: 'action1', windows: [[0.6, 13.6]], svg: chip(DX(0), 56, 280, 'neutral', 'Bash: node --test test/payment.test.mjs') },
    { id: 'frozen', windows: [[2.6, 13.6]], svg: chip(DX(1) + 20, 196, 160, 'harness', 'request frozen') },
    { id: 'verdict', windows: [[4.8, 13.6]], svg: chip(DX(2) + 30, 196, 140, 'review', 'verdict: allow') },
    { id: 'receipt', windows: [[7.0, 13.6]], svg: chip(DX(3) + 20, 196, 160, 'harness', 'receipt for that action') },
    { id: 'allow', windows: [[10.6, 13.6]], svg: `${badge(DX(2) + 304, 258, 'ok', '✓')}${chip(DX(2) + 136, 350, 160, 'harness', 'allowed, receipt consumed')}` },
    { id: 'action2', windows: [[14.0, 21.4]], svg: chip(DX(0), 56, 280, 'deny', 'Bash: node --test test/  (changed argument)') },
    { id: 'deny', windows: [[16.2, 21.4]], svg: `${badge(DX(2) + 304, 258, 'deny', '✕')}${chip(DX(2) + 126, 350, 180, 'deny', 'receipt does not apply')}` },
  ],
  steps: [
    { t: 0.6, at: 'propose', focus: ['propose'], caption: 'The Engineer proposes one exact action: the tool, its full input and where it runs.' },
    { t: 2.6, at: 'prepare', focus: ['prepare'], caption: 'The Harness freezes that action with source hashes, consent revision and budgets.' },
    { t: 4.6, at: 'judge', focus: ['judge'], caption: 'The host runs the read-only decision-agent, on a small model where the host allows it.' },
    { t: 6.8, at: 'record', focus: ['record'], caption: 'The Harness records the observed reply as a receipt tied to that exact action.' },
    { t: 8.8, at: 'call', focus: ['call'], move: 1.0, caption: 'The Engineer makes the tool call with the identical arguments.' },
    { t: 10.4, at: 'hook', focus: ['hook'], caption: 'The receipt matches and every remaining guard passes, so the call is allowed.' },
    { t: 13.8, at: 'propose', focus: ['propose'], move: 1.0, caption: 'Now one argument changes.' },
    { t: 15.0, at: 'call', focus: ['call'], move: 0.8, caption: 'The new call is not the action that was judged.' },
    { t: 16.2, at: 'hook', focus: ['hook'], caption: 'No receipt matches it, so it needs a fresh judgment. A later denial always wins.' },
    { t: 18.6, focus: ['judge', 'hook'], caption: 'A receipt never grants trust, user authority or wider scope, and never replaces named checks.' },
  ],
};

const scenes = [deliver, grows, decision];
const check = process.argv.includes('--check');
let stale = 0;
if (!check) fs.mkdirSync(outDir, { recursive: true });
for (const scene of scenes) {
  const file = path.join(outDir, `${scene.id}.svg`);
  const svg = render(scene);
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== svg) { stale += 1; console.error(`stale: ${path.relative(root, file)}`); }
  } else {
    fs.writeFileSync(file, svg);
    console.log(`${path.relative(root, file)} ${Buffer.byteLength(svg)} bytes`);
  }
}
if (stale) process.exit(1);
