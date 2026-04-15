import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getVaultConfig, resolveTargetDir } from "../../lib/obsidian/vault";

export interface BookmarkFrontmatter {
  title: string;
  author: string;
  author_name?: string;
  date: string;
  source: string;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  tags: string[];
  status: "raw" | "enriched";
  entities?: string[];
  graphed?: boolean;
}

export interface ParsedBookmark {
  filePath: string;
  filename: string;
  frontmatter: BookmarkFrontmatter;
  body: string;
  tweetId: string | null;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]+?)\r?\n---\r?\n?/;

export function extractFrontmatter(content: string): {
  frontmatter: BookmarkFrontmatter;
  body: string;
} {
  const m = content.match(FRONTMATTER_RE);
  if (!m) throw new Error("No YAML frontmatter found");
  const fm = parseYaml(m[1]) as BookmarkFrontmatter;
  if (!fm.tags) fm.tags = [];
  if (!fm.status) fm.status = "raw";
  return { frontmatter: fm, body: content.slice(m[0].length) };
}

export function serializeBookmark(
  fm: BookmarkFrontmatter,
  body: string,
): string {
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trim();
  return `---\n${yaml}\n---\n\n${body.replace(/^\s+/, "")}`;
}

export function tweetIdFromSource(source: string | undefined): string | null {
  if (!source) return null;
  const m = source.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

export function vaultDir(): string {
  return resolveTargetDir(getVaultConfig());
}

export function rawDir(): string {
  return path.join(vaultDir(), ".raw");
}

export function taxonomyPath(): string {
  return path.join(vaultDir(), ".taxonomy.yaml");
}

export function entitiesPath(): string {
  return path.join(vaultDir(), ".entities.yaml");
}

export function digestsDir(): string {
  return path.join(vaultDir(), "digests");
}

export async function listBookmarks(): Promise<ParsedBookmark[]> {
  const dir = vaultDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ParsedBookmark[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    try {
      const content = await fs.readFile(full, "utf8");
      const { frontmatter, body } = extractFrontmatter(content);
      out.push({
        filePath: full,
        filename: entry,
        frontmatter,
        body,
        tweetId: tweetIdFromSource(frontmatter.source),
      });
    } catch (e) {
      console.warn(`  skip ${entry}: ${(e as Error).message}`);
    }
  }
  return out;
}

export interface TaxonomyEntry {
  aliases?: string[];
  description?: string;
  parent?: string;
}

export interface Taxonomy {
  tags: Record<string, TaxonomyEntry>;
}

export async function loadTaxonomy(): Promise<Taxonomy> {
  try {
    const raw = await fs.readFile(taxonomyPath(), "utf8");
    const parsed = parseYaml(raw) as Taxonomy | null;
    if (!parsed || typeof parsed !== "object" || !parsed.tags) {
      return { tags: {} };
    }
    return parsed;
  } catch {
    return { tags: {} };
  }
}

export async function saveTaxonomy(tax: Taxonomy): Promise<void> {
  const content = `# X Bookmark taxonomy — managed by /bookmark-tags skill\n${stringifyYaml(tax, { lineWidth: 0 })}`;
  await fs.writeFile(taxonomyPath(), content, "utf8");
}

export function normalizeTagName(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/^#/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function canonicalize(tag: string, tax: Taxonomy): string {
  const t = normalizeTagName(tag);
  if (tax.tags[t]) return t;
  for (const [canonical, entry] of Object.entries(tax.tags)) {
    if ((entry.aliases ?? []).includes(t)) return canonical;
  }
  return t;
}

export type EntityType =
  | "model"
  | "framework"
  | "tool"
  | "paper"
  | "benchmark"
  | "dataset"
  | "company"
  | "hardware"
  | "person"
  | "product"
  | "other";

export interface EntityEntry {
  aliases?: string[];
  type?: EntityType;
  description?: string;
}

export interface EntityTaxonomy {
  entities: Record<string, EntityEntry>;
}

export async function loadEntities(): Promise<EntityTaxonomy> {
  try {
    const raw = await fs.readFile(entitiesPath(), "utf8");
    const parsed = parseYaml(raw) as EntityTaxonomy | null;
    if (!parsed || typeof parsed !== "object" || !parsed.entities) {
      return { entities: {} };
    }
    return parsed;
  } catch {
    return { entities: {} };
  }
}

export async function saveEntities(tax: EntityTaxonomy): Promise<void> {
  const content = `# X Bookmark entity taxonomy — managed by /bookmark-graph skill\n${stringifyYaml(tax, { lineWidth: 0 })}`;
  await fs.writeFile(entitiesPath(), content, "utf8");
}

export function canonicalizeEntity(
  name: string,
  tax: EntityTaxonomy,
): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (tax.entities[trimmed]) return trimmed;
  const lowerMap = new Map<string, string>();
  for (const [canonical, entry] of Object.entries(tax.entities)) {
    lowerMap.set(canonical.toLowerCase(), canonical);
    for (const alias of entry.aliases ?? []) {
      lowerMap.set(alias.toLowerCase(), canonical);
    }
  }
  const found = lowerMap.get(trimmed.toLowerCase());
  if (found) return found;
  return trimmed;
}
