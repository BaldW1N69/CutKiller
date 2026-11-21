import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tr } from "@cutkiller/core";

/**
 * Shared-service mode: with CUTKILLER_WORKSPACE set, every path a user supplies
 * (rushes, EDL sources, outputs, MCP arguments) must stay inside that folder,
 * symlinks resolved. Unset (one person's own machine), paths are only resolved.
 */
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const w = env.CUTKILLER_WORKSPACE?.trim();
  return w ? realpathSync(resolve(w)) : undefined;
}

/** The absolute path, refused when it leaves the workspace (see workspaceRoot). */
export function confinePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const abs = resolve(path);
  const root = workspaceRoot(env);
  if (!root) return abs;
  // Real path of the longest existing prefix: a symlink cannot lead outside.
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  const real = join(existsSync(probe) ? realpathSync(probe) : probe, ...tail);
  if (real !== root && !real.startsWith(root + sep))
    throw new Error(
      tr(
        `path outside the workspace (CUTKILLER_WORKSPACE): ${path}`,
        `chemin hors de l'espace de travail (CUTKILLER_WORKSPACE) : ${path}`,
      ),
    );
  return real;
}
