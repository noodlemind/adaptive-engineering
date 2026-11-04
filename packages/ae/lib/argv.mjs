const FLAGS_WITH_VALUES = new Set([
  '--autonomy',
  '--copilot-home',
  '--harness-home',
  '--ae-home',
  '--limit',
  '--intent-page',
  '--intent-page-size',
  '--phase',
  '--plan',
  '--attempt',
  '--editor',
  '--name',
  '--launcher',
  '--installation',
  '--user-data',
  '--config-root',
  '--plugins-root',
  '--query',
  '--target',
  '--workspace',
  '-c',
  '--collection',
  '--min-score',
  '--docid',
  '--path',
  '--lines',
  '--max-bytes',
    '--match',
  '--source',
  '--cursor',
  '--context-version',
  '--question-kind',
  '--generation',
  '--depth',
  '--file',
  '--adapter',
]);

export function fileInputHint(command) {
  const hints = {
    orient: 'Repeat --file <path> for each source.',
    agent: 'Repeat --file <path> for each source.',
    review: 'For review prepare, repeat --file <path> for each source. Review assemble accepts exactly one JSON document via --file <path>.',
    domain: 'For domain review prepare, repeat --file <path> for each source. Domain decisions and review assemble accept exactly one JSON document via --file <path>.',
  };
  return `${hints[command] || 'Use --file <path> with one input document.'} See ae help ${command}.`;
}

export function parseQueryFromArgv(argv, flags) {
  if (flags.query) return flags.query;
  const parts = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      parts.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!arg.includes('=') && FLAGS_WITH_VALUES.has(flagName)) i++;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!arg.includes('=') && FLAGS_WITH_VALUES.has(flagName)) i++;
      continue;
    }
    if (arg === '-v') continue;
    parts.push(arg);
  }

  return parts.join(' ').trim();
}
