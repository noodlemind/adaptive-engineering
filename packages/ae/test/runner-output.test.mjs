import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { runProcess } from '../lib/runner.mjs';

const BUDGET = 4000;

test('head-tail capture preserves short stdout and stderr exactly', async () => {
  const result = await runProcess({
    argv: [process.execPath, '-e', "process.stdout.write('ready\\n'); process.stderr.write('warning\\n');"],
    maxBuffer: BUDGET,
    bufferMode: 'head-tail',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.stdout, 'ready\n');
  assert.equal(result.stderr, 'warning\n');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.outputTruncation, { stdout: { omittedChars: 0 }, stderr: { omittedChars: 0 } });
});

for (const length of [9000, 2 * 1024 * 1024]) {
  test(`head-tail capture keeps late failures after ${length} characters in both streams`, async () => {
    const head = 'CHECK_SETUP_START\n';
    const stdoutTail = '\nSTDOUT_LATE_ASSERTION\n';
    const stderrTail = '\nSTDERR_LATE_ASSERTION\n';
    const stdout = `${head}${'x'.repeat(length)}${stdoutTail}`;
    const stderr = `${head}${'y'.repeat(length)}${stderrTail}`;
    let stdoutChars = 0;
    let stderrChars = 0;
    const result = await runProcess({
      argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(head)} + 'x'.repeat(${length}) + ${JSON.stringify(stdoutTail)}, () => process.stderr.write(${JSON.stringify(head)} + 'y'.repeat(${length}) + ${JSON.stringify(stderrTail)}, () => process.exit(7)));`],
      maxBuffer: BUDGET,
      bufferMode: 'head-tail',
      onStdout: chunk => { stdoutChars += chunk.length; },
      onStderr: chunk => { stderrChars += chunk.length; },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(result.truncated, true);
    for (const [stream, original, tail] of [['stdout', stdout, stdoutTail], ['stderr', stderr, stderrTail]]) {
      assert.ok(result[stream].startsWith(head));
      assert.ok(result[stream].endsWith(tail));
      assert.match(result[stream], /truncated: \d+ characters omitted/);
      assert.equal(result.outputTruncation[stream].omittedChars, original.length - BUDGET);
      assert.ok(result[stream].length <= BUDGET + 80, 'only the bounded payload plus an omission marker is retained');
    }
    assert.equal(stdoutChars, stdout.length, 'stream callbacks still see the complete stdout');
    assert.equal(stderrChars, stderr.length, 'stream callbacks still see the complete stderr');
  });
}

test('head-tail capture does not split a Unicode character at either retained boundary', async () => {
  const script = "process.stdout.write('h'.repeat(1999) + '💥' + 'x'.repeat(6000) + '💥' + 't'.repeat(1999));";
  const result = await runProcess({ argv: [process.execPath, '-e', script], maxBuffer: BUDGET, bufferMode: 'head-tail' });
  assert.doesNotMatch(result.stdout, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(result.outputTruncation.stdout.omittedChars, 6004);
});

for (const outcome of ['timed-out', 'cancelled']) {
  test(`head-tail capture preserves diagnostic context for ${outcome} runs`, async () => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    const controller = new AbortController();
    const diagnostic = `setup\n${'x'.repeat(9000)}\nLAST_OBSERVED_DIAGNOSTIC\n`;
    const result = await runProcess({
      argv: ['fixture-check'],
      bufferMode: 'head-tail',
      maxBuffer: BUDGET,
      timeoutMs: outcome === 'timed-out' ? 20 : undefined,
      signal: controller.signal,
      platform: 'linux',
      spawnFn: () => {
        queueMicrotask(() => child.stdout.emit('data', diagnostic));
        return child;
      },
      killFn: () => queueMicrotask(() => child.emit('close', null, 'SIGTERM')),
      onStdout: () => { if (outcome === 'cancelled') controller.abort(); },
    });
    assert.equal(result.status, outcome);
    assert.equal(result.exitCode, null);
    assert.equal(result.signalName, 'SIGTERM');
    assert.ok(result.stdout.endsWith('LAST_OBSERVED_DIAGNOSTIC\n'));
    assert.equal(result.truncated, true);
  });
}

test('prefix capture never ends on a lone high surrogate when no newline fits', async () => {
  // 'a' then astral characters: an odd budget lands between the two halves of a pair.
  const result = await runProcess({
    argv: [process.execPath, '-e', "process.stdout.write('a' + '\\u{1F600}'.repeat(50));"],
    maxBuffer: 6,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, 'a\u{1F600}\u{1F600}');
  assert.doesNotMatch(result.stdout, /[\uD800-\uDBFF]$/);
});
