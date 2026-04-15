/**
 * bookmark-graph skill CLI.
 *
 *   tsx --env-file=.env.local scripts/skill-graph.ts apply
 *   tsx --env-file=.env.local scripts/skill-graph.ts show
 *   tsx --env-file=.env.local scripts/skill-graph.ts reset
 *
 * Reads `.claude/skills/bookmark-graph/groups.yaml` and writes
 * `colorGroups` into `<vaultRoot>/.obsidian/graph.json`, merging with
 * any existing graph settings (force/display/etc.).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getVaultConfig, resolveTargetDir } from "../../lib/obsidian/vault";

const GROUPS_YAML = path.join(
  ".claude",
  "skills",
  "bookmark-graph",
  "groups.yaml",
);

interface GroupDef {
  name: string;
  query: string;
  color: string;
}

interface ObsidianColor {
  a: number;
  rgb: number;
}

interface ObsidianColorGroup {
  query: string;
  color: ObsidianColor;
}

function obsidianVaultDir(): string {
  return resolveTargetDir(getVaultConfig());
}

function graphJsonPath(): string {
  return path.join(obsidianVaultDir(), ".obsidian", "graph.json");
}

function hexToRgbInt(hex: string): number {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid hex color: "${hex}" (expected #rrggbb)`);
  }
  return parseInt(clean, 16);
}

function rgbIntToHex(rgb: number): string {
  return "#" + rgb.toString(16).padStart(6, "0");
}

async function loadGroupsYaml(): Promise<GroupDef[]> {
  let raw: string;
  try {
    raw = await fs.readFile(GROUPS_YAML, "utf8");
  } catch {
    throw new Error(
      `groups.yaml not found at ${GROUPS_YAML}. Run from the project root.`,
    );
  }
  const parsed = parseYaml(raw) as { groups?: GroupDef[] } | null;
  if (!parsed?.groups || !Array.isArray(parsed.groups)) {
    throw new Error("groups.yaml is missing a top-level `groups` array.");
  }
  for (const g of parsed.groups) {
    if (!g.query || !g.color) {
      throw new Error(
        `Invalid group entry (name=${g.name ?? "?"}) — query and color are required.`,
      );
    }
  }
  return parsed.groups;
}

async function loadGraphJson(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(graphJsonPath(), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function defaultGraph(): Record<string, unknown> {
  return {
    "collapse-filter": true,
    search: "",
    showTags: true,
    showAttachments: false,
    hideUnresolved: false,
    showOrphans: true,
    "collapse-color-groups": false,
    colorGroups: [],
    "collapse-display": false,
    showArrow: false,
    textFadeMultiplier: 0,
    nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1,
    "collapse-forces": false,
    centerStrength: 0.5,
    repelStrength: 10,
    linkStrength: 1,
    linkDistance: 250,
    scale: 1,
    close: false,
  };
}

async function writeGraphJson(data: Record<string, unknown>): Promise<string> {
  const target = graphJsonPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
  return target;
}

async function cmdApply(): Promise<void> {
  const groups = await loadGroupsYaml();
  const existing = await loadGraphJson();
  const merged: Record<string, unknown> = { ...defaultGraph(), ...existing };
  merged.colorGroups = groups.map<ObsidianColorGroup>((g) => ({
    query: g.query,
    color: { a: 1, rgb: hexToRgbInt(g.color) },
  }));
  merged.showTags = true; // ensure tag nodes are shown

  const target = await writeGraphJson(merged);
  console.log(
    `✓ Wrote ${groups.length} color group(s) to ${path.relative(process.cwd(), target)}`,
  );
  for (const g of groups) {
    console.log(`  ${g.color}  ${g.name}`);
  }
  console.log(
    "\nIf Obsidian is currently open on this vault, reload it (Ctrl+R) to pick up the new groups.",
  );
}

async function cmdShow(): Promise<void> {
  const json = await loadGraphJson();
  const groups = (json.colorGroups ?? []) as ObsidianColorGroup[];
  const target = graphJsonPath();
  if (groups.length === 0) {
    console.log(`No color groups configured in ${target}.`);
    return;
  }
  console.log(`\n${groups.length} color group(s) in ${path.relative(process.cwd(), target)}:\n`);
  for (const g of groups) {
    console.log(`  ${rgbIntToHex(g.color.rgb)}  ${g.query}`);
  }
  console.log();
}

async function cmdReset(): Promise<void> {
  const existing = await loadGraphJson();
  existing.colorGroups = [];
  const target = await writeGraphJson(existing);
  console.log(`✓ Cleared color groups in ${path.relative(process.cwd(), target)}`);
}

async function main() {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "apply":
      await cmdApply();
      return;
    case "show":
      await cmdShow();
      return;
    case "reset":
      await cmdReset();
      return;
    default:
      console.error("Usage: skill-graph.ts <apply|show|reset>");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
