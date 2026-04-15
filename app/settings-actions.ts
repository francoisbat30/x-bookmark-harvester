"use server";

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  loadUserConfig,
  saveUserConfig,
  resolveVaultConfig,
  type ResolvedVaultConfig,
} from "@/lib/user-config";

const execFileAsync = promisify(execFile);

export interface VaultPathInfo {
  vaultPath: string;
  subfolder: string;
  source: ResolvedVaultConfig["source"];
  resolvedAbsolute: string;
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
    // also check the vault root even if the subfolder doesn't exist yet
    try {
      const stat = await fs.stat(
        path.isAbsolute(resolved.vaultPath)
          ? resolved.vaultPath
          : path.resolve(process.cwd(), resolved.vaultPath),
      );
      exists = stat.isDirectory();
    } catch {
      exists = false;
    }
  }
  if (exists) {
    try {
      // probe writability by attempting to create (and remove) a marker file
      const probeDir = path.isAbsolute(resolved.vaultPath)
        ? resolved.vaultPath
        : path.resolve(process.cwd(), resolved.vaultPath);
      const probe = path.join(probeDir, `.xbm-probe-${Date.now()}`);
      await fs.writeFile(probe, "", "utf8");
      await fs.unlink(probe);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return {
    vaultPath: resolved.vaultPath,
    subfolder: resolved.subfolder,
    source: resolved.source,
    resolvedAbsolute: abs,
    exists,
    writable,
  };
}

export async function validateVaultPath(
  vaultPath: string,
  subfolder = "x-bookmarks",
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

  return {
    ok: true,
    resolvedAbsolute: path.join(trimmed, subfolder),
  };
}

export async function saveVaultPath(
  vaultPath: string,
  subfolder = "x-bookmarks",
): Promise<ValidationResult> {
  const validation = await validateVaultPath(vaultPath, subfolder);
  if (!validation.ok) return validation;

  const existing = await loadUserConfig();
  await saveUserConfig({
    vaultPath: vaultPath.trim(),
    subfolder: subfolder.trim() || existing?.subfolder || "x-bookmarks",
    updatedAt: new Date().toISOString(),
  });

  // Ensure the subfolder exists so that the rest of the app can write immediately.
  try {
    await fs.mkdir(validation.resolvedAbsolute!, { recursive: true });
  } catch {
    // validation already proved the parent is writable — ignore
  }

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
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$f.Description = 'Select the folder to store your X Bookmark vault';",
    "$f.ShowNewFolderButton = $true;",
    "$result = $f.ShowDialog();",
    "if ($result -eq 'OK') { [Console]::Out.Write($f.SelectedPath) } else { exit 2 }",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { timeout: 5 * 60 * 1000, windowsHide: true },
    );
    const picked = stdout.trim();
    if (!picked) return { supported: true, cancelled: true };
    return { supported: true, path: picked };
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 2) return { supported: true, cancelled: true };
    return {
      supported: false,
      error: err.message ?? "PowerShell dialog failed",
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
