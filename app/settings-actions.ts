"use server";

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  saveUserConfig,
  resolveVaultConfig,
  type ResolvedVaultConfig,
} from "@/lib/user-config";

const execFileAsync = promisify(execFile);

export interface VaultPathInfo {
  /** Absolute, fully-resolved path where bookmarks will be written. */
  resolvedAbsolute: string;
  source: ResolvedVaultConfig["source"];
  exists: boolean;
  writable: boolean;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  resolvedAbsolute?: string;
}

export interface BrowseResult {
  supported: boolean;
  cancelled?: boolean;
  path?: string;
  error?: string;
}

function resolveAbsolute(vaultPath: string, subfolder: string): string {
  const root = path.isAbsolute(vaultPath)
    ? vaultPath
    : path.resolve(process.cwd(), vaultPath);
  return path.join(root, subfolder);
}

export async function getCurrentVaultPath(): Promise<VaultPathInfo> {
  const resolved = resolveVaultConfig();
  const abs = resolveAbsolute(resolved.vaultPath, resolved.subfolder);
  let exists = false;
  let writable = false;
  try {
    const stat = await fs.stat(abs);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }
  if (exists) {
    try {
      const probe = path.join(abs, `.xbm-probe-${Date.now()}`);
      await fs.writeFile(probe, "", "utf8");
      await fs.unlink(probe);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return {
    resolvedAbsolute: abs,
    source: resolved.source,
    exists,
    writable,
  };
}

export async function validateVaultPath(
  vaultPath: string,
): Promise<ValidationResult> {
  const trimmed = vaultPath.trim();
  if (!trimmed) {
    return { ok: false, error: "Path is empty" };
  }
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error: "Path must be absolute (e.g. C:\\Users\\you\\Documents\\Vault)",
    };
  }

  try {
    const stat = await fs.stat(trimmed);
    if (!stat.isDirectory()) {
      return { ok: false, error: "Path exists but is not a directory" };
    }
  } catch {
    return { ok: false, error: "Path does not exist" };
  }

  // probe writability
  try {
    const probe = path.join(trimmed, `.xbm-probe-${Date.now()}`);
    await fs.writeFile(probe, "", "utf8");
    await fs.unlink(probe);
  } catch {
    return { ok: false, error: "Directory exists but is not writable" };
  }

  return { ok: true, resolvedAbsolute: trimmed };
}

export async function saveVaultPath(
  vaultPath: string,
): Promise<ValidationResult> {
  const validation = await validateVaultPath(vaultPath);
  if (!validation.ok) return validation;

  await saveUserConfig({
    vaultPath: vaultPath.trim(),
    // Single-folder UX: the picked directory IS the target. We always set
    // subfolder to "" so resolveTargetDir returns the picked path as-is.
    subfolder: "",
    updatedAt: new Date().toISOString(),
  });

  return validation;
}

/**
 * Open a native folder dialog. Windows uses a PowerShell one-liner,
 * macOS uses osascript, Linux uses zenity. If none works, returns
 * { supported: false } so the UI can fall back to a text input.
 */
export async function browseForVaultPath(): Promise<BrowseResult> {
  try {
    if (process.platform === "win32") {
      return await browseWindows();
    }
    if (process.platform === "darwin") {
      return await browseMac();
    }
    return await browseLinux();
  } catch (e) {
    return {
      supported: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function browseWindows(): Promise<BrowseResult> {
  // Windows Forms requires Single-Threaded Apartment mode; without -Sta
  // the FolderBrowserDialog silently hangs forever. -NonInteractive was
  // previously set and also contributed to the hang — it's dropped here.
  // -EncodedCommand sidesteps all shell-escaping concerns for the script.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$f.Description = 'Select your Obsidian vault folder'",
    "$f.ShowNewFolderButton = $true",
    "$result = $f.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::Out.Write($f.SelectedPath)",
    "  exit 0",
    "}",
    "exit 2",
  ].join("\n");
  // -EncodedCommand expects a UTF-16 LE base64 string (Microsoft docs).
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Sta",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { timeout: 90_000, windowsHide: true },
    );
    const picked = stdout.trim();
    if (!picked) return { supported: true, cancelled: true };
    return { supported: true, path: picked };
  } catch (e) {
    const err = e as { code?: number; killed?: boolean; message?: string };
    if (err.code === 2) return { supported: true, cancelled: true };
    if (err.killed) {
      return {
        supported: false,
        error: "Folder picker timed out (90s)",
      };
    }
    return {
      supported: false,
      error: err.message ?? "Folder picker failed",
    };
  }
}

async function browseMac(): Promise<BrowseResult> {
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-e",
        'try\n  set chosen to choose folder with prompt "Select the folder to store your X Bookmark vault"\n  return POSIX path of chosen\non error number -128\n  return ""\nend try',
      ],
      { timeout: 5 * 60 * 1000 },
    );
    const picked = stdout.trim();
    if (!picked) return { supported: true, cancelled: true };
    return { supported: true, path: picked };
  } catch (e) {
    return {
      supported: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function browseLinux(): Promise<BrowseResult> {
  try {
    const { stdout } = await execFileAsync(
      "zenity",
      [
        "--file-selection",
        "--directory",
        "--title=Select the folder to store your X Bookmark vault",
      ],
      { timeout: 5 * 60 * 1000 },
    );
    const picked = stdout.trim();
    if (!picked) return { supported: true, cancelled: true };
    return { supported: true, path: picked };
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 1) return { supported: true, cancelled: true };
    return {
      supported: false,
      error: "zenity not available — install it or paste the path manually",
    };
  }
}
