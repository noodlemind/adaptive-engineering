import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extract as lexicalExtract } from './lexical-extractor.mjs';
import { importBindings, sourceMasks } from './occurrences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOCK_PATH = path.join(__dirname, 'grammars.lock');

export const MAX_IDENTIFIER_LENGTH = 160;
export const MAX_DEFS_PER_FILE = 512;
export const MAX_REFS_PER_FILE = 1024;
export const MAX_IMPORTS_PER_FILE = 256;

/** File extension → grammars.lock language key. Everything else is lexical. */
export const STRUCTURAL_LANGUAGES = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.java': 'java',
};

export function branchComplexity(content) {
  const m = String(content || '').match(/\b(?:if|for|while|case|catch|elif|except|when)\b|&&|\|\||\?\?/g);
  return (m ? m.length : 0) + 1;
}

function capName(name) {
  const s = String(name || '');
  return s.length > MAX_IDENTIFIER_LENGTH ? s.slice(0, MAX_IDENTIFIER_LENGTH) : s;
}

function firstLines(text, names) {
  const wanted = new Set(names);
  const found = new Map();
  if (!wanted.size) return found;
  const lines = text.split('\n');
  const token = /[A-Za-z_$][\w$]*/g;
  for (let i = 0; i < lines.length && found.size < wanted.size; i++) {
    token.lastIndex = 0;
    let m;
    while ((m = token.exec(lines[i])) !== null) {
      if (wanted.has(m[0]) && !found.has(m[0])) found.set(m[0], i + 1);
    }
  }
  if (found.size === wanted.size) return found;
  const starts = [0];
  for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  for (const name of wanted) {
    if (found.has(name)) continue;
    const at = text.indexOf(name);
    if (at === -1) {
      found.set(name, 0);
      continue;
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    found.set(name, lo + 1);
  }
  return found;
}

function lexicalNamedExports(rel, code) {
  const names = new Set();
  if (!/\.[cm]?[jt]sx?$/i.test(rel)) return names;
  const declarations = /\bexport\s+(?:(?:async|declare|abstract)\s+)*(?:function(?:\s*\*\s*|\s+)|class\s+|(?:const|let|var)\s+)([\w$]+)/g;
  const braces = /[{}]/g;
  let depth = 0, brace = braces.exec(code), declaration;
  while ((declaration = declarations.exec(code))) {
    while (brace && brace.index < declaration.index) {
      depth += brace[0] === '{' ? 1 : -1;
      brace = braces.exec(code);
    }
    if (depth === 0) names.add(declaration[1]);
  }
  return names;
}

export function lexicalV2(rel, content) {
  const masks = sourceMasks(rel, String(content || ''));
  const { symbols, imports, exported, references, limitsReached, importOccurrences } = lexicalExtract(rel, content, { masks });
  const kept = symbols.slice(0, MAX_DEFS_PER_FILE);
  const referenced = (references || []).slice(0, MAX_REFS_PER_FILE);
  const exportedSet = new Set(exported || []);
  const namedExports = lexicalNamedExports(rel, masks.code);
  const lines = firstLines(/\.(?:sql|tf)$/i.test(rel) ? masks.text : masks.code, [...kept, ...referenced]);
  const defs = kept.map((name) => ({
    name: capName(name),
    kind: 'symbol',
    line: lines.get(name) ?? 0,
    exported: exportedSet.has(name),
    ...(namedExports.has(name) ? { exportKind: 'named' } : {}),
  }));
  return {
    symbols: kept.map(capName),
    imports: imports.slice(0, MAX_IMPORTS_PER_FILE),
    importOccurrences,
    limitsReached,
    defs,
    refs: referenced.map((name) => ({ name: capName(name), line: lines.get(name) ?? 0 })),
    complexity: branchComplexity(content),
    tier: 'lexical',
  };
}

export function loadGrammarsLock({ lockPath = DEFAULT_LOCK_PATH } = {}) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!lock || typeof lock !== 'object' || !lock.grammars) return null;
    const rt = lock.runtime;
    if (!rt || typeof rt !== 'object' || typeof rt.package !== 'string' || typeof rt.file !== 'string') return null;
    if (!rt.loader || typeof rt.loader.file !== 'string' || typeof rt.loader.sha256 !== 'string') return null;
    return lock;
  } catch {
    return null;
  }
}

/** The single failure record for an unreadable lock — the loud signal shared
 * by the extractor (index meta) and the sync doctor probe. */
export const MISSING_LOCK_FAILURE = Object.freeze({
  language: 'lock',
  file: 'grammars.lock',
  reason: 'grammars.lock missing or unreadable — wasm integrity cannot be verified',
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function packageGrammarRoots() {
  return [path.join(__dirname, 'vendor'), path.join(path.resolve(__dirname, '..', '..'), 'node_modules')];
}

/** Default roots searched for `<package>/<file>` grammar wasm files. */
function defaultGrammarRoots() {
    const pkgRoot = path.resolve(__dirname, '..', '..');
  const roots = packageGrammarRoots();
  let cur = path.dirname(pkgRoot);
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(cur, 'node_modules'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

function resolveLoaderPath(roots, lock) {
  return findWasm(roots, lock.runtime.package, lock.runtime.loader.file);
}

function findWasm(roots, pkg, file) {
  for (const root of roots) {
    const full = path.join(root, pkg, file);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function grammarStatus({ grammarRoots, lockPath } = {}) {
  const lock = loadGrammarsLock({ lockPath });
  const roots = grammarRoots || defaultGrammarRoots();
  const status = {
    lock: Boolean(lock),
    runtime: { present: false, ok: false },
    loader: { present: false, ok: false },
    grammars: {},
    integrityFailures: [],
  };
  if (!lock) {
    status.integrityFailures.push({ ...MISSING_LOCK_FAILURE });
    return status;
  }
  const check = (language, spec) => {
    const full = findWasm(roots, spec.package, spec.file);
    if (!full) return { present: false, ok: false, version: spec.version };
    let bytes;
    try {
      bytes = fs.readFileSync(full);
    } catch {
      return { present: false, ok: false, version: spec.version };
    }
    const ok = sha256(bytes) === spec.sha256;
    if (!ok) status.integrityFailures.push({ language, file: spec.file, reason: 'sha256 mismatch vs grammars.lock' });
    return { present: true, ok, version: spec.version, path: full };
  };
  status.runtime = check('runtime', lock.runtime);
    status.loader = check('loader', { ...lock.runtime.loader, package: lock.runtime.package });
  for (const [language, spec] of Object.entries(lock.grammars)) {
    status.grammars[language] = check(language, spec);
  }
  return status;
}

const JS_DEF_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
];

function hasAncestorOfType(node, type, maxUp = 4) {
  let cur = node.parent;
  for (let i = 0; i < maxUp && cur; i++) {
    if (cur.type === type) return true;
    cur = cur.parent;
  }
  return false;
}

function defKind(type) {
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('enum')) return 'enum';
  if (type.includes('type_alias')) return 'type';
  if (type.includes('method') || type === 'constructor_declaration') return 'method';
  if (type.includes('record')) return 'record';
  if (type === 'variable_declarator') return 'const';
  if (type === 'annotation_type_declaration') return 'annotation';
  return 'function';
}

function nodeRange(node) {
  return {
    startLine: (node.startPosition?.row || 0) + 1,
    startColumn: (node.startPosition?.column || 0) + 1,
    endLine: (node.endPosition?.row || 0) + 1,
    endColumn: (node.endPosition?.column || 0) + 1,
  };
}

function nodeDetails(node) {
  const owners = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!/(?:class|function|method|interface|record|enum|constructor)_?(?:declaration|definition)?$/.test(parent.type)) continue;
    const name = parent.childForFieldName('name')?.text;
    if (name) owners.unshift(capName(name));
  }
  const parameters = node.childForFieldName('parameters')?.text;
  return { owner: owners.join('.'), range: nodeRange(node), ...(parameters ? { signature: parameters.slice(0, 512) } : {}) };
}

function importOccurrence(node, specifier, rel) {
  if (node.type === 'call_expression' && node.childForFieldName('function')?.text === 'require') {
    let declaration = node.parent;
    while (declaration && !['variable_declarator', 'lexical_declaration', 'variable_declaration', 'expression_statement', 'program', 'statement_block'].includes(declaration.type)) declaration = declaration.parent;
    const name = declaration?.type === 'variable_declarator' && declaration.childForFieldName('name');
    const value = declaration?.type === 'variable_declarator' && declaration.childForFieldName('value');
    const bindings = name && value?.id === node.id ? importBindings(rel, `const ${name.text} = ${value.text}`, specifier) : [];
    return { specifier, range: nodeRange(node), bindings, method: 'ast' };
  }
  let statement = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (['lexical_declaration', 'variable_declaration', 'expression_statement'].includes(parent.type)) { statement = parent; break; }
    if (['program', 'module', 'block'].includes(parent.type)) break;
  }
  return { specifier, range: nodeRange(node), bindings: importBindings(rel, statement.text, specifier), method: 'ast' };
}

const JS_FUNCTION_SCOPES = new Set(['function_declaration', 'function_expression', 'generator_function_declaration', 'generator_function', 'arrow_function', 'method_definition']);
const JS_BLOCK_SCOPES = new Set(['statement_block', 'catch_clause', 'for_statement', 'for_in_statement', 'switch_body']);

function bindingContains(node, identifier) {
  if (!node) return false;
  if (['identifier', 'shorthand_property_identifier_pattern'].includes(node.type)) return node.text === identifier;
  if (node.type === 'pair_pattern') return bindingContains(node.childForFieldName('value'), identifier);
  if (['assignment_pattern', 'object_assignment_pattern'].includes(node.type)) return bindingContains(node.childForFieldName('left'), identifier);
  if (['required_parameter', 'optional_parameter'].includes(node.type)) return bindingContains(node.childForFieldName('pattern') || node.childForFieldName('name'), identifier);
  if (['formal_parameters', 'object_pattern', 'array_pattern', 'rest_pattern'].includes(node.type)) return (node.namedChildren || []).some(child => bindingContains(child, identifier));
  return false;
}

function shadowedIdentifier(node, identifier, cache, importedDeclarations = new Set()) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!JS_FUNCTION_SCOPES.has(scope.type) && scope.type !== 'program' && !JS_BLOCK_SCOPES.has(scope.type)) continue;
    const key = `${scope.id}\0${identifier}`;
    if (!cache.has(key)) {
      const parameters = scope.childForFieldName('parameters') || scope.childForFieldName('parameter');
      let shadowed = bindingContains(parameters, identifier);
      if (scope.type === 'for_in_statement' && scope.children.some(child => ['let', 'const', 'var'].includes(child.type))) shadowed ||= bindingContains(scope.childForFieldName('left'), identifier);
      if (JS_FUNCTION_SCOPES.has(scope.type) && scope.childForFieldName('name')?.text === identifier) shadowed = true;
      if (!shadowed) for (const declaration of scope.descendantsOfType(['variable_declarator', 'function_declaration', 'class_declaration', 'for_in_statement'])) {
        if (importedDeclarations.has(declaration.id)) continue;
        const loop = declaration.type === 'for_in_statement';
        const hoisted = declaration.parent?.type === 'variable_declaration' || loop && declaration.children.some(child => child.type === 'var');
        if (loop && !hoisted) continue;
        const name = declaration.childForFieldName(loop ? 'left' : 'name');
        if (!bindingContains(name, identifier)) continue;
        let contained = true;
        for (let parent = declaration.parent; parent && parent.id !== scope.id; parent = parent.parent) {
          if (JS_FUNCTION_SCOPES.has(parent.type) || !hoisted && JS_BLOCK_SCOPES.has(parent.type)) { contained = false; break; }
        }
        if (contained) { shadowed = true; break; }
      }
      cache.set(key, Boolean(shadowed));
    }
    if (cache.get(key)) return true;
  }
  return false;
}

function shadowedRequire(node, imported, cache) {
  return imported.has('require') || shadowedIdentifier(node, 'require', cache);
}

function jsExportDetails(node) {
  let declaration = node;
  if (node.type === 'variable_declarator' && ['lexical_declaration', 'variable_declaration'].includes(node.parent?.type)) declaration = node.parent;
  const statement = declaration.parent;
  if (statement?.type !== 'export_statement' || statement.parent?.type !== 'program') return {};
  return { exportKind: statement.children.some(child => child.type === 'default') ? 'default' : 'named' };
}

function walkJs(root, rel) {
  const defs = [];
  for (const node of root.descendantsOfType(JS_DEF_TYPES)) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      const fnValue = value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'generator_function');
      const exported = hasAncestorOfType(node, 'export_statement');
      if (!fnValue && !exported) continue;
      defs.push({ name: nameNode.text, kind: fnValue ? 'function' : 'const', line: node.startPosition.row + 1, exported, ...jsExportDetails(node), ...nodeDetails(node) });
      continue;
    }
    defs.push({
      name: nameNode.text,
      kind: defKind(node.type),
      line: node.startPosition.row + 1,
      exported: hasAncestorOfType(node, 'export_statement'),
      ...jsExportDetails(node),
      ...nodeDetails(node),
    });
  }
  const imports = [];
  const importOccurrences = [];
  for (const node of root.descendantsOfType(['import_statement', 'export_statement'])) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    const source = node.childForFieldName('source');
    if (source) {
      const specifier = source.text.replace(/^['"`]|['"`]$/g, '');
      imports.push(specifier);
      importOccurrences.push(importOccurrence(node, specifier, rel));
    }
  }
  const refs = [];
  const bindingRefs = [];
  const importedDeclarations = new Set();
  const imported = new Set(importOccurrences.flatMap(occurrence => occurrence.bindings.map(binding => binding.local)));
  const shadowCache = new Map();
  for (const node of root.descendantsOfType(['call_expression', 'new_expression'])) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const target = node.childForFieldName(node.type === 'new_expression' ? 'constructor' : 'function');
    if (!target) continue;
    if (target.type === 'import' || target.type === 'identifier') {
      if (target.type === 'import' || target.text === 'require') {
        if (target.text === 'require' && shadowedRequire(node, imported, shadowCache)) continue;
        const args = node.childForFieldName('arguments');
        const arg = args?.namedChildren?.[0];
        if (arg && arg.type === 'string' && imports.length < MAX_IMPORTS_PER_FILE) {
          const specifier = arg.text.replace(/^['"`]|['"`]$/g, '');
          imports.push(specifier);
          const occurrence = importOccurrence(node, specifier, rel);
          importOccurrences.push(occurrence);
          if (occurrence.bindings.length && node.parent?.type === 'variable_declarator') importedDeclarations.add(node.parent.id);
        }
        continue;
      }
      refs.push({ name: target.text, line: node.startPosition.row + 1, ...nodeDetails(node) });
      bindingRefs.push([refs.at(-1), node, target.text]);
    } else if (target.type === 'member_expression') {
      const prop = target.childForFieldName('property');
      if (prop) refs.push({ name: prop.text, line: node.startPosition.row + 1, receiver: target.childForFieldName('object')?.text?.slice(0, MAX_IDENTIFIER_LENGTH) || null, ...nodeDetails(node) });
      if (prop) bindingRefs.push([refs.at(-1), node, target.childForFieldName('object')?.text]);
    }
  }
  const bindingCache = new Map();
  for (const occurrence of importOccurrences) for (const binding of occurrence.bindings) imported.add(binding.local);
  for (const [ref, node, local] of bindingRefs) {
    if (imported.has(local) && shadowedIdentifier(node, local, bindingCache, importedDeclarations)) ref.importBinding = 'shadowed';
  }
  return { defs, imports, importOccurrences, refs };
}

function walkPython(root, rel) {
  const defs = [];
  for (const node of root.descendantsOfType(['class_definition', 'function_definition'])) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    // "Exported" approximation: module-level and not underscore-private.
    const parent = node.parent?.type === 'decorated_definition' ? node.parent : node;
    const topLevel = parent.parent?.type === 'module';
    defs.push({
      name: nameNode.text,
      kind: node.type === 'class_definition' ? 'class' : 'function',
      line: node.startPosition.row + 1,
      exported: topLevel && !nameNode.text.startsWith('_'),
      ...nodeDetails(node),
    });
  }
  const imports = [];
  const importOccurrences = [];
  for (const node of root.descendantsOfType(['import_from_statement', 'import_statement'])) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    if (node.type === 'import_from_statement') {
      const mod = node.childForFieldName('module_name');
      if (mod) { imports.push(mod.text); importOccurrences.push(importOccurrence(node, mod.text, rel)); }
    } else {
      for (const name of node.namedChildren) {
        if (name.type === 'dotted_name' || name.type === 'aliased_import') {
          const specifier = name.type === 'aliased_import' ? name.childForFieldName('name')?.text || name.text : name.text;
          imports.push(specifier); importOccurrences.push(importOccurrence(node, specifier, rel));
        }
      }
    }
  }
  const refs = [];
  for (const node of root.descendantsOfType('call')) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const fn = node.childForFieldName('function');
    if (!fn) continue;
    if (fn.type === 'identifier') refs.push({ name: fn.text, line: node.startPosition.row + 1, ...nodeDetails(node) });
    else if (fn.type === 'attribute') {
      const attr = fn.childForFieldName('attribute');
      if (attr) refs.push({ name: attr.text, line: node.startPosition.row + 1, receiver: fn.childForFieldName('object')?.text?.slice(0, MAX_IDENTIFIER_LENGTH) || null, ...nodeDetails(node) });
    }
  }
  return { defs, imports, importOccurrences, refs };
}

const JAVA_DEF_TYPES = [
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
  'method_declaration',
  'constructor_declaration',
];

function walkJava(root, rel) {
  const defs = [];
  for (const node of root.descendantsOfType(JAVA_DEF_TYPES)) {
    if (defs.length >= MAX_DEFS_PER_FILE) break;
    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
    defs.push({
      name: nameNode.text,
      kind: defKind(node.type),
      line: node.startPosition.row + 1,
      exported: Boolean(modifiers && /\bpublic\b/.test(modifiers.text)),
      ...nodeDetails(node),
    });
  }
  const imports = [];
  const importOccurrences = [];
  for (const node of root.descendantsOfType('import_declaration')) {
    if (imports.length >= MAX_IMPORTS_PER_FILE) break;
    const specifier = node.text.replace(/^import\s+(static\s+)?/, '').replace(/;?\s*$/, '');
    imports.push(specifier); importOccurrences.push(importOccurrence(node, specifier, rel));
  }
  const refs = [];
  for (const node of root.descendantsOfType(['method_invocation', 'object_creation_expression'])) {
    if (refs.length >= MAX_REFS_PER_FILE) break;
    const target = node.childForFieldName(node.type === 'method_invocation' ? 'name' : 'type');
    if (target) refs.push({ name: target.text, line: node.startPosition.row + 1, receiver: node.childForFieldName('object')?.text?.slice(0, MAX_IDENTIFIER_LENGTH) || null, ...nodeDetails(node) });
  }
  return { defs, imports, importOccurrences, refs };
}

const WALKERS = {
  javascript: walkJs,
  typescript: walkJs,
  tsx: walkJs,
  python: walkPython,
  java: walkJava,
};

function capResult(walked, rel) {
  const defs = walked.defs.slice(0, MAX_DEFS_PER_FILE).map((d) => ({ ...d, name: capName(d.name), id: `${rel}#${d.owner ? `${d.owner}.` : ''}${capName(d.name)}@${d.line}:${d.range?.startColumn || 1}` }));
  const imports = [...new Set(walked.imports)].slice(0, MAX_IMPORTS_PER_FILE);
  const refs = walked.refs.slice(0, MAX_REFS_PER_FILE).map((r) => ({ ...r, name: capName(r.name) }));
  const symbols = [...new Set(defs.map((d) => d.name))];
  const importOccurrences = (walked.importOccurrences || []).slice(0, MAX_IMPORTS_PER_FILE);
  return { symbols, imports, importOccurrences, defs, refs, limitsReached: { defs: walked.defs.length >= MAX_DEFS_PER_FILE, refs: walked.refs.length >= MAX_REFS_PER_FILE, imports: walked.imports.length >= MAX_IMPORTS_PER_FILE, importOccurrences: (walked.importOccurrences?.length || 0) > MAX_IMPORTS_PER_FILE } };
}

export function makeStructuralExtract({ parseForLanguage, counters = { parseFailures: 0, parsed: 0, errorFiles: 0 } }) {
  const extract = (rel, content) => {
    const language = STRUCTURAL_LANGUAGES[path.extname(rel).toLowerCase()];
    if (!language) return lexicalV2(rel, content);
    const text = String(content || '');
    let tree = null;
    try {
      tree = parseForLanguage(language, text);
    } catch {
      counters.parseFailures += 1;
      return lexicalV2(rel, content);
    }
    if (!tree || !tree.rootNode) return lexicalV2(rel, content);
    try {
      const walked = WALKERS[language](tree.rootNode, rel);
      const hasErrors = Boolean(tree.rootNode.hasError);
      counters.parsed += 1;
      if (hasErrors) counters.errorFiles += 1;
      return { ...capResult(walked, rel), complexity: branchComplexity(text), tier: 'treesitter', hasErrors };
    } catch {
      counters.parseFailures += 1;
      return lexicalV2(rel, content);
    } finally {
      try {
        tree.delete?.();
      } catch {
        // freeing the wasm-side tree is best-effort
      }
    }
  };
  return { extract, counters };
}

export async function createTreesitterExtract({ grammarRoots, lockPath, loaderPath } = {}) {
  const counters = { parseFailures: 0, parsed: 0, errorFiles: 0 };
  const lexicalOnly = (reason, integrityFailures = []) => ({
    ...makeStructuralExtract({ parseForLanguage: () => null, counters }),
    tier: 'lexical',
    reason,
    available: [],
    missingGrammars: Object.keys(loadGrammarsLock({ lockPath })?.grammars || {}),
    integrityFailures,
    webTreeSitter: null,
    grammarVersions: {},
  });

  const lock = loadGrammarsLock({ lockPath });
    if (!lock) return lexicalOnly('grammars.lock missing or unreadable', [{ ...MISSING_LOCK_FAILURE }]);

  const roots = grammarRoots || defaultGrammarRoots();
  const integrityFailures = [];

    const loaderFull = loaderPath || resolveLoaderPath(roots, lock);
  if (!loaderFull) return lexicalOnly('web-tree-sitter loader not installed (optional)');
  let loaderBytes;
  try {
    loaderBytes = fs.readFileSync(loaderFull);
  } catch {
    return lexicalOnly('web-tree-sitter loader unreadable');
  }
  if (sha256(loaderBytes) !== lock.runtime.loader.sha256) {
    return lexicalOnly('loader integrity mismatch', [
      { language: 'loader', file: lock.runtime.loader.file, reason: 'sha256 mismatch vs grammars.lock' },
    ]);
  }

    const runtimePath = findWasm(roots, lock.runtime.package, lock.runtime.file);
  if (!runtimePath) return lexicalOnly('web-tree-sitter runtime not installed (optional)');
  let runtimeBytes;
  try {
    runtimeBytes = fs.readFileSync(runtimePath);
  } catch {
    return lexicalOnly('web-tree-sitter runtime unreadable');
  }
  if (sha256(runtimeBytes) !== lock.runtime.sha256) {
    const failure = { language: 'runtime', file: lock.runtime.file, reason: 'sha256 mismatch vs grammars.lock' };
    return lexicalOnly('runtime integrity mismatch', [failure]);
  }

  let Parser;
  let Language;
  try {
    ({ Parser, Language } = await import(pathToFileURL(loaderFull).href));
    await Parser.init({ wasmBinary: runtimeBytes });
  } catch {
    return lexicalOnly('web-tree-sitter init failed');
  }

  const languages = new Map();
  const grammarVersions = {};
  const missingGrammars = [];
  for (const [language, spec] of Object.entries(lock.grammars)) {
    const wasmPath = findWasm(roots, spec.package, spec.file);
    if (!wasmPath) {
      missingGrammars.push(language);
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(wasmPath);
    } catch {
      missingGrammars.push(language);
      continue;
    }
    if (sha256(bytes) !== spec.sha256) {
      integrityFailures.push({ language, file: spec.file, reason: 'sha256 mismatch vs grammars.lock' });
      continue; // loud lexical fallback for this grammar — recorded, surfaced by doctor S1
    }
    try {
      languages.set(language, await Language.load(bytes));
      grammarVersions[language] = spec.version;
    } catch {
      integrityFailures.push({ language, file: spec.file, reason: 'wasm failed to instantiate' });
    }
  }

  if (!languages.size) {
    const out = lexicalOnly(missingGrammars.length ? 'no grammar wasm installed (optional)' : 'no grammar verified', integrityFailures);
    out.missingGrammars = missingGrammars;
    return out;
  }

  const parser = new Parser();
  let current = null;
  const parseForLanguage = (language, text) => {
    const lang = languages.get(language);
    if (!lang) return null;
    if (current !== language) {
      parser.setLanguage(lang);
      current = language;
    }
    return parser.parse(text);
  };

  return {
    ...makeStructuralExtract({ parseForLanguage, counters }),
    tier: 'treesitter',
    available: [...languages.keys()],
    missingGrammars,
    integrityFailures,
    webTreeSitter: lock.runtime.version,
    grammarVersions,
  };
}
