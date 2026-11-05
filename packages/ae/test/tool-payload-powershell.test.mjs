import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTerminalEffects, normalizeToolPayload } from '../corpus/hooks/lib/tool-payload.mjs';

for (const cmdlet of ['set-content', 'Set-Content', 'SET-CONTENT']) {
  test(`PowerShell writer ${cmdlet} retains its explicit mutation target`, () => {
    const command = `${cmdlet} -LiteralPath src/example.txt -Value changed`;
    const effects = analyzeTerminalEffects(command);
    assert.equal(effects.hasOpaque, false);
    assert.equal(effects.ambiguous, false);
    const normalized = normalizeToolPayload({
      workspace: process.cwd(), tool_name: 'run_in_terminal', tool_input: { command },
    });
    assert.equal(normalized.mutation, true);
    assert.deepEqual(normalized.targets, ['src/example.txt']);
  });
}

for (const command of [
  'Get-Item src/example.txt',
  'get-item -Path src/example.txt',
  'GET-ITEM -LiteralPath "src/example file.txt" -Force',
]) {
  test(`PowerShell metadata inspection remains read-only: ${command}`, () => {
    const normalized = normalizeToolPayload({
      workspace: process.cwd(), tool_name: 'execute/runInTerminal', tool_input: { command },
    });
    assert.equal(normalized.mutation, false);
    assert.equal(normalized.terminalEffects.hasOpaque, false);
  });
}

for (const command of [
  'CAT src/example.txt',
  '/bin/CAT src/example.txt',
  'RM src/example.txt',
  './Set-Content src/example.txt changed',
  '/tmp/Set-Content src/example.txt changed',
  './Get-Item src/example.txt',
  '/tmp/Get-Item src/example.txt',
  'Get-Item src/example.txt; node generator.mjs',
  'Get-Item $(node generator.mjs)',
  'Get-Item src/example.txt | ForEach-Object { Set-Content src/other.txt changed }',
]) {
  test(`PowerShell cmdlet recognition preserves opaque boundaries: ${command}`, () => {
    assert.equal(analyzeTerminalEffects(command).hasOpaque, true);
  });
}
