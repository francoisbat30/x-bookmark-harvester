/**
 * Cross-platform per-user paths for this app.
 *
 * Windows → %APPDATA%\x-bookmark-harvester
 * macOS   → ~/Library/Application Support/x-bookmark-harvester
 * Linux   → $XDG_CONFIG_HOME/x-bookmark-harvester (default ~/.config)
 *
 * Override with X_BOOKMARK_HOME for tests or custom installs.
 */
import path from "node:path";
import os from "node:os";

export const APP_NAME = "x-bookmark-harvester";

export function appDataDir(): string {
  const override = process.env.X_BOOKMARK_HOME;
  if (override) return override;

  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(base, APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.join(xdg, APP_NAME);
}
