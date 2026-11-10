#!/usr/bin/env node
// Checks the delivery-evidence Mermaid state diagram against rules.json with the state-model
// starter that AE ships in create-primitive. This library owns that asset, so the pilot imports
// it; other products copy it. Writes state-model.json, report.md and chart.mmd to
// HARNESS_CHECK_ARTIFACT_DIR when Harness runs it, else to a private temporary directory.
// Exits 1 when a rule breaks or a broken variant is missed, and 2 on bad input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as stateModel from '../../../../../../packages/ae/corpus/skills/create-primitive/assets/state-model/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = path.join(here, '..', 'workflow.mmd');
export const RULES_FILE = path.join(here, '..', 'rules.json');

let loaded;
/** The validated rules file, read on first use so bad input reaches the exit-2 handler below. */
export const rules = () => (loaded ??= stateModel.validateRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'))));

/** Parse workflow.mmd and refuse actions the rules file does not name. Returns the edges. */
export function parseStateDiagram(text) {
  const { edges } = stateModel.parseStateDiagram(text);
  for (const edge of edges) if (edge.action && !rules().actions.includes(edge.action)) throw new Error(`unknown action: ${edge.action}`);
  return edges;
}

export const checkWorkflow = edges => stateModel.checkModel(edges, rules());

export function run(modelPath = MODEL) {
  return stateModel.run({ modelPath, rulesPath: RULES_FILE }).receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const result = stateModel.run({ modelPath: MODEL, rulesPath: RULES_FILE });
    const dir = stateModel.artifactDir(undefined);
    stateModel.writeArtifacts(dir, result);
    process.stderr.write(`artifacts: ${dir}\n`);
    process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
    if (!result.receipt.passed) process.exitCode = 1;
  } catch (error) {
    // Bad input is exit 2, as in the starter, so it is never mistaken for a broken rule.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
