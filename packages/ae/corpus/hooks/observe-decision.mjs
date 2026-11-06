#!/usr/bin/env node
import fs from 'node:fs';
import { observeNativeDecision } from './lib/decision-bridge.mjs';

try {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Decision completion event exceeds its bound');
  process.stdout.write(`${JSON.stringify(await observeNativeDecision(JSON.parse(input)))}\n`);
} catch (error) {
  // Observation failure never grants authority. Record reports missing evidence.
  process.stdout.write(`${JSON.stringify({ observed: false, reason: error.message })}\n`);
}
