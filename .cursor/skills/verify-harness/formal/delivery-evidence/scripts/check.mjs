#!/usr/bin/env node
// Checks the delivery-evidence Mermaid state diagram against rules.json with the state-model
// starter that AE ships in create-primitive. This library owns that asset, so the pilot imports
// it; other products copy it. Writes state-model.json, report.md and chart.mmd to
// HARNESS_CHECK_ARTIFACT_DIR when Harness runs it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as stateModel from '../../../../../../packages/ae/corpus/skills/create-primitive/assets/state-model/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = path.join(here, '..', 'workflow.mmd');
export const RULES_FILE = path.join(here, '..', 'rules.json');
const spec = stateModel.validateRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')));
export const RULES = Object.fromEntries(spec.rules.map(rule => [rule.id, rule.says]));

/** Parse workflow.mmd and refuse actions the rules file does not name. Returns the edges. */
export function parseStateDiagram(text) {
  const { edges } = stateModel.parseStateDiagram(text);
  for (const edge of edges) if (edge.action && !spec.actions.includes(edge.action)) throw new Error(`unknown action: ${edge.action}`);
  return edges;
}

export const checkWorkflow = edges => stateModel.checkModel(edges, spec);

export function run(modelPath = MODEL) {
  return stateModel.run({ modelPath, rulesPath: RULES_FILE }).receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const result = stateModel.run({ modelPath: MODEL, rulesPath: RULES_FILE });
  const dir = process.env.HARNESS_CHECK_ARTIFACT_DIR;
  if (dir) stateModel.writeArtifacts(dir, result);
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
  if (!result.receipt.passed) process.exitCode = 1;
}
