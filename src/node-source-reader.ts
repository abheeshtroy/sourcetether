import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { SourceReader } from "./sourcetether.js";

/**
 * Creates a synchronous reader confined to one project root. Missing files,
 * unreadable paths, traversal, and symlink escapes all return undefined.
 * Intended for a trusted local workspace; it is not a defense against
 * adversarial concurrent filesystem mutation.
 */
export function createProjectSourceReader(projectRoot: string): SourceReader {
  let resolvedProjectRoot: string | undefined;
  try {
    resolvedProjectRoot = realpathSync(projectRoot);
  } catch {
    return () => undefined;
  }

  return (projectRelativePath: string): string | undefined => {
    if (isAbsolute(projectRelativePath)) return undefined;

    try {
      const candidatePath = resolve(resolvedProjectRoot, projectRelativePath);
      if (!isInsideProject(resolvedProjectRoot, candidatePath)) return undefined;

      const resolvedCandidate = realpathSync(candidatePath);
      if (!isInsideProject(resolvedProjectRoot, resolvedCandidate)) return undefined;

      return readFileSync(resolvedCandidate, "utf8");
    } catch {
      return undefined;
    }
  };
}

function isInsideProject(projectRoot: string, candidatePath: string): boolean {
  return candidatePath === projectRoot || candidatePath.startsWith(`${projectRoot}${sep}`);
}
