import path from 'node:path';

export default async function* timings(events) {
  let summary = null;
  const terminal = {};
  for await (const { type, data } of events) {
    if (type === 'test:complete' && data.nesting === 0 && data.file && path.resolve(data.name) === path.resolve(data.file)) {
      yield JSON.stringify({ kind: 'file', file: path.basename(data.file), durationMs: data.details.duration_ms, passed: data.details.passed === true }) + '\n';
    }
    if (type === 'test:summary' && !data.file) {
      summary = { kind: 'summary', counts: data.counts, durationMs: data.duration_ms, success: data.success };
    }
    // Node20 reports its terminal counters as root diagnostics instead of the
    // test:summary event. Child diagnostics and partial summaries prove nothing.
    if (type === 'test:diagnostic' && data.nesting === 0 && !data.file) {
      const match = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/.exec(data.message);
      if (match) terminal[match[1]] = Number(match[2]);
    }
  }
  if (!summary && ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'].every(key => Object.hasOwn(terminal, key))) {
    summary = {
      kind: 'summary',
      counts: { tests: terminal.tests, suites: terminal.suites, passed: terminal.pass, failed: terminal.fail, cancelled: terminal.cancelled, skipped: terminal.skipped, todo: terminal.todo },
      durationMs: terminal.duration_ms,
      success: terminal.fail === 0 && terminal.cancelled === 0,
    };
  }
  if (summary) yield JSON.stringify(summary) + '\n';
}
