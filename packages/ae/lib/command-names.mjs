/**
 * The `ae` command registry's table. `registry.mjs` fills it as it registers
 * each command and re-exports `hasCommand`. It lives in this leaf module so a
 * reader below the command graph (the re-check display of run-journal
 * commands) can ask whether a name is a registered command without importing
 * the whole graph, which would close an import cycle. Until `registry.mjs` is
 * evaluated the table is empty and vouches for no name.
 */
export const REGISTRY = new Map();

export function hasCommand(name) {
  return REGISTRY.has(name);
}
