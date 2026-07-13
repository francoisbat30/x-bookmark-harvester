import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTriageList } from "../lib/triage";

let dir: string;
const OLD_ENV = process.env.XBM_STATE_DIR;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-triage-"));
  process.env.XBM_STATE_DIR = dir;
});

afterEach(async () => {
  if (OLD_ENV === undefined) delete process.env.XBM_STATE_DIR;
  else process.env.XBM_STATE_DIR = OLD_ENV;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadTriageList", () => {
  it("parse id + commentaire, ignore # et lignes vides", async () => {
    await fs.writeFile(
      path.join(dir, "triage-skip.txt"),
      "# entête\n\n123  @auteur — raison\n456\nabc pas un id\n  789   x\n",
      "utf8",
    );
    const ids = await loadTriageList("triage-skip.txt");
    expect([...ids].sort()).toEqual(["123", "456", "789"]);
  });

  it("fichier absent → ensemble vide (triage optionnel)", async () => {
    const ids = await loadTriageList("triage-light.txt");
    expect(ids.size).toBe(0);
  });
});
