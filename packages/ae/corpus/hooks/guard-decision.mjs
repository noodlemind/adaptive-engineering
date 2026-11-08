#!/usr/bin/env node
import fs from 'node:fs';
import { guardNativeDecision } from './lib/decision-bridge.mjs';

try {
  const bytes = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error('Native decision hook payload exceeds its bound');
  const payload = JSON.parse(bytes);
  process.stdout.write(`${JSON.stringify(await guardNativeDecision(payload))}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: `AE decision authority unavailable: ${error.message}`, continue: false })}\n`);
}
