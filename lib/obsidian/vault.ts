import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveVaultConfig } from "../user-config";

export interface VaultConfig {
  vaultPath: string;
  subfolder: string;
}

export interface WriteResult {
  absolutePath: string;
  filename: string;
  skipped: boolean;
  collisionResolved: boolean;
}

export interface WriteOptions {
  overwrite?: boolean;
  /**
   * Tweet ID for collision resolution. If provided and the target file
   * already exists but belongs to a different tweet, a short suffix derived
   * from this ID is appended to the filename to disambiguate.
   */
  uniqueKey?: string;
}

export function getVaultConfig(): VaultConfig {
  const resolved = resolveVaultConfig();
  return {
    vaultPath: resolved.vaultPath,
    subfolder: resolved.subfolder,
  };
}

export function resolveTargetDir(config: VaultConfig): string {
  const root = path.isAbsolute(config.vaultPath)
    ? config.vaultPath
    : path.resolve(process.cwd(), config.vaultPath);
  return path.join(root, config.subfolder);
}

/**
 * Ensure that `filename` resolves to a path strictly inside `dir`.
 * Throws otherwise. Prevents path-traversal via malformed filenames
 * reaching writeFile from anywhere in the codebase.
 */
function assertWithinDir(dir: string, filename: string): string {
  const normalizedDir = path.resolve(dir);
  const candidate = path.resolve(normalizedDir, filename);
  if (
    candidate !== normalizedDir &&
    !candidate.startsWith(normalizedDir + path.sep)
  ) {
    throw new Error(
      `Refusing to write outside vault dir (filename=${JSON.stringify(filename)})`,
    );
  }
  return candidate;
}

async function readTweetIdFromFile(fullPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(fullPath, "utf8");
    const sourceMatch = content.match(/^source:\s*"?(https?:\/\/\S+?)"?\s*$/m);
    if (!sourceMatch) return null;
    const idMatch = sourceMatch[1].match(/status\/(\d+)/);
    return idMatch ? idMatch[1] : null;
  } catch {
    return null;
  }
}

async function resolveCollision(
  dir: string,
  filename: string,
  uniqueKey: string,
): Promise<{ filename: string; resolved: boolean }> {
  const fullPath = path.join(dir, filename);
  try {
    await fs.access(fullPath);
  } catch {
    return { filename, resolved: false };
  }

  const existingId = await readTweetIdFromFile(fullPath);
  if (existingId === uniqueKey) {
    return { filename, resolved: false };
  }

  const base = filename.replace(/\.md$/, "");
  const suffix = uniqueKey.slice(-8);
  return { filename: `${base}_${suffix}.md`, resolved: true };
}


/**
 * Lit le contenu de la note existante pour ce tweet, si elle existe : d'abord
 * le nom canonique, sinon la variante suffixée créée par resolveCollision
 * (même nom, autre tweet). Utilisé pour préserver Summary/tags/status au
 * re-render (lib/obsidian/note-merge.ts).
 */
export async function readExistingNote(
  filename: string,
  uniqueKey: string,
  config: VaultConfig = getVaultConfig(),
): Promise<string | null> {
  const dir = resolveTargetDir(config);
  const candidates = [
    filename,
    `${filename.replace(/\.md$/, "")}_${uniqueKey.slice(-8)}.md`,
  ];
  for (const c of candidates) {
    const p = assertWithinDir(dir, c);
    try {
      const content = await fs.readFile(p, "utf8");
      const id = (content.match(/^source:\s*"?(https?:\/\/\S+?)"?\s*$/m)?.[1] ?? "").match(/status\/(\d+)/)?.[1];
      if (!id || id === uniqueKey) return content;
    } catch {
      // absent → candidat suivant
    }
  }
  return null;
}

export async function writeNote(
  filename: string,
  content: string,
  config: VaultConfig = getVaultConfig(),
  options: WriteOptions = {},
): Promise<WriteResult> {
  const dir = resolveTargetDir(config);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });

  let finalFilename = filename;
  let collisionResolved = false;

  if (options.uniqueKey) {
    const resolved = await resolveCollision(dir, filename, options.uniqueKey);
    finalFilename = resolved.filename;
    collisionResolved = resolved.resolved;
  }

  const absolutePath = assertWithinDir(dir, finalFilename);

  if (!options.overwrite) {
    try {
      await fs.access(absolutePath);
      return {
        absolutePath,
        filename: finalFilename,
        skipped: true,
        collisionResolved,
      };
    } catch {
      // file does not exist — proceed
    }
  }

  await fs.writeFile(absolutePath, content, "utf8");
  return {
    absolutePath,
    filename: finalFilename,
    skipped: false,
    collisionResolved,
  };
}
