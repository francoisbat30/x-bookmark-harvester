/**
 * User-scoped settings for this app (the vault path, etc.).
 * Persisted to <appDataDir>/config.json so it survives restarts and is
 * never stored inside the vault itself.
 *
 * `loadUserConfigSync` reads synchronously so the rest of the code can
 * keep calling `getVaultConfig()` without touching async — this is fine
 * because every caller is server-side (Node).
 */
import {
  promises as fsPromises,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { appDataDir } from "./platform";

export interface UserConfig {
  /** Absolute path to the root of the Obsidian vault. */
  vaultPath: string;
  /** Subfolder inside the vault where bookmark notes are written. */
  subfolder: string;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

export interface ResolvedVaultConfig {
  vaultPath: string;
  subfolder: string;
  source: "user-config" | "env" | "default";
}

function configFilePath(): string {
  return path.join(appDataDir(), "config.json");
}

function parseConfig(raw: string): UserConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<UserConfig>;
    if (
      typeof parsed.vaultPath === "string" &&
      parsed.vaultPath.length > 0 &&
      typeof parsed.subfolder === "string"
    ) {
      return {
        vaultPath: parsed.vaultPath,
        subfolder: parsed.subfolder,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function loadUserConfigSync(): UserConfig | null {
  const p = configFilePath();
  if (!existsSync(p)) return null;
  try {
    return parseConfig(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export async function loadUserConfig(): Promise<UserConfig | null> {
  try {
    const raw = await fsPromises.readFile(configFilePath(), "utf8");
    return parseConfig(raw);
  } catch {
    return null;
  }
}

export async function saveUserConfig(config: UserConfig): Promise<void> {
  const p = configFilePath();
  await fsPromises.mkdir(path.dirname(p), { recursive: true });
  await fsPromises.writeFile(p, JSON.stringify(config, null, 2), "utf8");
}

/**
 * Synchronous variant used during module init when the server boots.
 */
export function saveUserConfigSync(config: UserConfig): void {
  const p = configFilePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2), "utf8");
}

export async function clearUserConfig(): Promise<void> {
  try {
    await fsPromises.unlink(configFilePath());
  } catch {
    // already gone
  }
}

/**
 * Resolve the effective vault config using the precedence:
 *   1. user-config (persisted via the UI)
 *   2. OBSIDIAN_VAULT_PATH / OBSIDIAN_BOOKMARKS_SUBFOLDER env vars
 *   3. ./vault default
 */
export function resolveVaultConfig(): ResolvedVaultConfig {
  const userConfig = loadUserConfigSync();
  if (userConfig) {
    return {
      vaultPath: userConfig.vaultPath,
      subfolder: userConfig.subfolder,
      source: "user-config",
    };
  }
  const envPath = process.env.OBSIDIAN_VAULT_PATH;
  const envSub = process.env.OBSIDIAN_BOOKMARKS_SUBFOLDER;
  if (envPath) {
    return {
      vaultPath: envPath,
      subfolder: envSub || "x-bookmarks",
      source: "env",
    };
  }
  return {
    vaultPath: "./vault",
    subfolder: envSub || "x-bookmarks",
    source: "default",
  };
}
