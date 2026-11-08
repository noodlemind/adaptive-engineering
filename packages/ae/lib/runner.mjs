import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024; // 2 Mi UTF-16 code units (string length), not bytes
export const DEFAULT_KILL_GRACE_MS = 2000;
export const DEFAULT_GROUP_REAP_TIMEOUT_MS = 5000;
const GROUP_REAP_POLL_MS = 50;

function createBoundedSink(maxBuffer) {
  let buffer = '';
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      buffer += chunk;
      if (buffer.length > maxBuffer) {
        const cut = buffer.lastIndexOf('\n', maxBuffer);
        // A hard cut must not leave a lone high surrogate at the end.
        buffer = cut === -1 ? buffer.slice(0, maxBuffer).replace(/[\uD800-\uDBFF]$/, '') : buffer.slice(0, cut + 1);
        truncated = true;
      }
    },
    get text() {
      return buffer;
    },
    get truncated() {
      return truncated;
    },
  };
}

function createHeadTailSink(maxBuffer) {
  const headLimit = Math.ceil(maxBuffer / 2);
  const tailLimit = Math.floor(maxBuffer / 2);
  let buffer = '';
  let head = '';
  let tail = '';
  let totalChars = 0;
  let truncated = false;
  const takeHead = text => text.slice(0, headLimit).replace(/[\uD800-\uDBFF]$/, '');
  const takeTail = text => tailLimit ? text.slice(-tailLimit).replace(/^[\uDC00-\uDFFF]/, '') : '';
  const omittedChars = () => truncated ? totalChars - head.length - tail.length : 0;
  return {
    push(chunk) {
      const text = String(chunk);
      totalChars += text.length;
      if (truncated) {
        tail = takeTail(tail + text);
        return;
      }
      buffer += text;
      if (buffer.length > maxBuffer) {
        head = takeHead(buffer);
        tail = takeTail(buffer);
        buffer = '';
        truncated = true;
      }
    },
    get text() {
      return truncated ? `${head}\n…truncated: ${omittedChars()} characters omitted…\n${tail}` : buffer;
    },
    get truncated() {
      return truncated;
    },
    get omittedChars() {
      return omittedChars();
    },
  };
}

function defaultKill(pid, signal, platform) {
  if (platform === 'win32') {
    // Do not use a shell. taskkill is the Windows process-tree stop; Node has no tree-kill API.
    // TerminateProcess leaves descendants holding git and file locks, and the next test waits forever.
    try {
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: DEFAULT_GROUP_REAP_TIMEOUT_MS, windowsHide: true });
      return {
        status: result.status === 0 && !result.error && !result.signal ? 'confirmed' : 'failed',
        exitCode: result.status ?? null,
        signalName: result.signal ?? null,
        errorCode: result.error?.code ?? null,
      };
    } catch (error) {
      return { status: 'failed', exitCode: null, signalName: null, errorCode: error.code || null };
    }
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function defaultGroupAlive(pid, platform) {
  if (platform === 'win32') return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    return false;
  }
}

export function runProcess({
  argv,
  cwd,
  env,
  timeoutMs,
  signal,
  cancellationFile,
  onStdout,
  onStderr,
  onSpawn,
  maxBuffer = DEFAULT_MAX_BUFFER,
  bufferMode = 'prefix',
  spawnFn = spawn,
  now = () => Date.now(),
  platform = process.platform,
  killFn = defaultKill,
  groupAliveFn,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  groupReapTimeoutMs = DEFAULT_GROUP_REAP_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === 'string')) {
    throw new TypeError('runProcess: argv must be a non-empty array of strings');
  }
  if (bufferMode !== 'prefix' && bufferMode !== 'head-tail') {
    throw new TypeError('runProcess: bufferMode must be prefix or head-tail');
  }
  if (bufferMode === 'head-tail' && (!Number.isInteger(maxBuffer) || maxBuffer < 1)) {
    throw new TypeError('runProcess: head-tail maxBuffer must be a positive integer');
  }
  if (cancellationFile !== undefined && (typeof cancellationFile !== 'string' || !path.isAbsolute(cancellationFile))) {
    throw new TypeError('runProcess: cancellationFile must be an absolute owned path');
  }

  return new Promise((resolve) => {
    const start = now();
    const [cmd, ...args] = argv;
    const createSink = bufferMode === 'head-tail' ? createHeadTailSink : createBoundedSink;
    const stdoutSink = createSink(maxBuffer);
    const stderrSink = createSink(maxBuffer);

    let settled = false;
    let child;
    let childClosed = false;
    let treeTermination = { status: 'unknown' };
    let cancellationNotice = { requested: false };
    let provenanceError = null;
    let timeoutTimer = null;
    let killGraceTimer = null;
    let groupReapTimer = null;
    let settleDeadlineTimer = null;
        let outcomeStatus = null;

        const groupAlive = groupAliveFn || (killFn === defaultKill ? defaultGroupAlive : null);
    const watchGroupDeath = platform !== 'win32' && typeof groupAlive === 'function';

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
            if (killGraceTimer) clearTimeout(killGraceTimer);
      if (groupReapTimer) clearTimeout(groupReapTimer);
      if (settleDeadlineTimer) clearTimeout(settleDeadlineTimer);
    }

        function settleAfterGroupDeath(partial) {
      const deadline = now() + groupReapTimeoutMs;
      const poll = () => {
        if (settled) return;
        let alive;
        try {
          alive = groupAlive(child.pid, platform);
        } catch {
          alive = false;
        }
        if (!alive || now() >= deadline) {
          finish(partial);
          return;
        }
        groupReapTimer = setTimeout(poll, GROUP_REAP_POLL_MS);
      };
      poll();
    }

    function finish(partial) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: partial.status,
        exitCode: partial.exitCode ?? null,
        signalName: partial.signalName ?? null,
        durationMs: now() - start,
        stdout: stdoutSink.text,
        stderr: stderrSink.text,
        truncated: stdoutSink.truncated || stderrSink.truncated,
        ...(onSpawn ? { pid: child?.pid ?? null, groupId: platform === 'win32' ? null : child?.pid ?? null, provenanceError } : {}),
        groupReaped: !child?.pid || (watchGroupDeath ? (() => { try { return !groupAlive(child.pid, platform); } catch { return false; } })() : platform === 'win32'
          ? treeTermination.status === 'confirmed' ? childClosed : treeTermination.status === 'failed' ? false : null
          : null),
        ...(platform === 'win32' ? { treeTermination } : {}),
        ...(cancellationFile ? { cancellationNotice } : {}),
        ...(bufferMode === 'head-tail' ? {
          outputTruncation: {
            stdout: { omittedChars: stdoutSink.omittedChars },
            stderr: { omittedChars: stderrSink.omittedChars },
          },
        } : {}),
      });
    }

    if (signal?.aborted) {
      finish({ status: 'cancelled' });
      return;
    }

    try {
      child = spawnFn(cmd, args, {
        cwd,
        env: cancellationFile ? { ...(env ?? process.env), HARNESS_RUN_CANCEL_FILE: cancellationFile } : env,
        shell: false,
        detached: platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish({ status: 'failed' });
      return;
    }

        function safeKill(sig) {
      if (!Number.isInteger(child.pid) || child.pid <= 0) return;
      try {
        const termination = killFn(child.pid, sig, platform);
        if (platform === 'win32' && ['confirmed', 'failed'].includes(termination?.status)) treeTermination = termination;
      } catch (error) {
        if (platform === 'win32') treeTermination = { status: 'failed', errorCode: error.code || null };
      }
    }

    function terminateTree(status) {
      if (outcomeStatus) return; // already terminating for the other reason
      outcomeStatus = status;
      let cooperative = false;
      if (platform === 'win32' && cancellationFile && Number.isInteger(child.pid) && child.pid > 0) {
        try {
          fs.writeFileSync(cancellationFile, JSON.stringify({ version: 1, pid: child.pid }), { flag: 'wx', mode: 0o600 });
          cancellationNotice = { requested: true };
          cooperative = true;
        } catch (error) {
          cancellationNotice = { requested: false, errorCode: error.code || null };
        }
      }
      if (cooperative) killGraceTimer = setTimeout(() => safeKill('SIGTERM'), killGraceMs);
      else safeKill('SIGTERM');
            settleDeadlineTimer = setTimeout(() => {
        finish({ status, exitCode: null, signalName: null });
      }, killGraceMs + groupReapTimeoutMs);
      if (platform === 'win32') return; // taskkill /F is already unconditional
      if (!Number.isInteger(child.pid) || child.pid <= 0) return; // nothing to escalate against
            killGraceTimer = setTimeout(() => {
        safeKill('SIGKILL');
      }, killGraceMs);
    }

    function onAbort() {
      terminateTree('cancelled');
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminateTree('timed-out'), timeoutMs);
    }

    child.on('error', () => {
      finish({ status: outcomeStatus || 'failed' });
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

        child.stdout?.on('data', (chunk) => {
      stdoutSink.push(chunk);
      if (onStdout) {
        try {
          onStdout(chunk);
        } catch {
          // caller's callback failed — swallow, buffered stdout is unaffected
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrSink.push(chunk);
      if (onStderr) {
        try {
          onStderr(chunk);
        } catch {
          // caller's callback failed — swallow, buffered stderr is unaffected
        }
      }
    });

    child.on('close', (exitCode, signalName) => {
      childClosed = true;
            if (settleDeadlineTimer) {
        clearTimeout(settleDeadlineTimer);
        settleDeadlineTimer = null;
      }
      const partial = {
        status: outcomeStatus || (exitCode === 0 ? 'ok' : 'failed'),
        exitCode,
        signalName,
      };
            if (outcomeStatus && watchGroupDeath && Number.isInteger(child.pid) && child.pid > 0) {
        settleAfterGroupDeath(partial);
      } else {
        finish(partial);
      }
    });
    if (onSpawn && Number.isInteger(child.pid) && child.pid > 0) {
      try { onSpawn({ pid: child.pid, groupId: platform === 'win32' ? null : child.pid }); }
      catch (error) {
        provenanceError = String(error?.message || 'Spawn provenance could not be retained').slice(0, 240);
        terminateTree('failed');
      }
    }
  });
}
