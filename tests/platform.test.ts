import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appDataDir } from "../lib/platform";

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appDataDir", () => {
  it("honors X_BOOKMARK_HOME override", () => {
    vi.stubEnv("X_BOOKMARK_HOME", "/custom/override");
    expect(appDataDir()).toBe("/custom/override");
  });

  it("returns a path that contains the app name when no override", () => {
    vi.stubEnv("X_BOOKMARK_HOME", "");
    expect(appDataDir()).toContain("x-bookmark-harvester");
  });
});
