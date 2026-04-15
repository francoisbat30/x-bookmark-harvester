/**
 * bookmark-tags skill CLI.
 *
 *   tsx --env-file=.env.local scripts/skill-tags.ts list
 *   tsx --env-file=.env.local scripts/skill-tags.ts audit
 *   tsx --env-file=.env.local scripts/skill-tags.ts merge <from> <into>
 *   tsx --env-file=.env.local scripts/skill-tags.ts alias <canonical> <alias1> [<alias2>...]
 *   tsx --env-file=.env.local scripts/skill-tags.ts describe <tag> "<description>"
 *   tsx --env-file=.env.local scripts/skill-tags.ts show <tag>
 */
import { promises as fs } from "node:fs";
import {
  listBookmarks,
  loadTaxonomy,
  saveTaxonomy,
  serializeBookmark,
} from "./utils";

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[m][n];
}

async function collectCounts(): Promise<{
  counts: Record<string, number>;
  files: Record<string, string[]>;
}> {
  const bookmarks = await listBookmarks();
  const counts: Record<string, number> = {};
  const files: Record<string, string[]> = {};
  for (const b of bookmarks) {
    for (const t of b.frontmatter.tags ?? []) {
      counts[t] = (counts[t] ?? 0) + 1;
      (files[t] ??= []).push(b.filename);
    }
  }
  return { counts, files };
}

async function cmdList(): Promise<void> {
  const { counts } = await collectCounts();
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log("No tags in the vault yet.");
    return;
  }
  console.log(`\n${entries.length} distinct tag(s):\n`);
  for (const [tag, count] of entries) {
    console.log(`  ${String(count).padStart(4)}  ${tag}`);
  }
  console.log();
}

async function cmdAudit(): Promise<void> {
  const { counts } = await collectCounts();
  const tags = Object.keys(counts);
  if (tags.length < 2) {
    console.log("Not enough tags to audit.");
    return;
  }
  const pairs: Array<{ a: string; b: string; dist: number }> = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const d = levenshtein(tags[i], tags[j]);
      if (d > 0 && d <= 2) pairs.push({ a: tags[i], b: tags[j], dist: d });
    }
  }
  if (pairs.length === 0) {
    console.log("No suspicious tag pairs found (Levenshtein distance <= 2).");
    return;
  }
  pairs.sort((a, b) => a.dist - b.dist);
  console.log(`\n${pairs.length} suspicious pair(s):\n`);
  for (const p of pairs) {
    const aWin = counts[p.a] >= counts[p.b];
    const keep = aWin ? p.a : p.b;
    const drop = aWin ? p.b : p.a;
    console.log(
      `  ${p.a} (${counts[p.a]})  <->  ${p.b} (${counts[p.b]})   [dist=${p.dist}]  → suggest: merge ${drop} into ${keep}`,
    );
  }
  console.log("\nRun: npm run skill:tags -- merge <from> <into>\n");
}

async function cmdMerge(from: string, into: string): Promise<void> {
  if (from === into) {
    console.error("from and into are the same");
    process.exit(1);
  }
  const bookmarks = await listBookmarks();
  let count = 0;
  for (const b of bookmarks) {
    const tags = b.frontmatter.tags ?? [];
    if (!tags.includes(from)) continue;
    const next = Array.from(
      new Set(tags.map((t) => (t === from ? into : t))),
    );
    b.frontmatter.tags = next;
    await fs.writeFile(
      b.filePath,
      serializeBookmark(b.frontmatter, b.body),
      "utf8",
    );
    count++;
  }

  const tax = await loadTaxonomy();
  if (!tax.tags[into]) tax.tags[into] = {};
  const entry = tax.tags[into];
  entry.aliases = Array.from(new Set([...(entry.aliases ?? []), from]));
  delete tax.tags[from];
  await saveTaxonomy(tax);

  console.log(
    `✓ Merged "${from}" → "${into}" in ${count} file(s). Taxonomy updated.`,
  );
}

async function cmdAlias(
  canonical: string,
  ...aliases: string[]
): Promise<void> {
  const tax = await loadTaxonomy();
  if (!tax.tags[canonical]) tax.tags[canonical] = {};
  const entry = tax.tags[canonical];
  entry.aliases = Array.from(
    new Set([...(entry.aliases ?? []), ...aliases]),
  );
  await saveTaxonomy(tax);
  console.log(
    `✓ Registered aliases for "${canonical}": ${entry.aliases.join(", ")}`,
  );
}

async function cmdDescribe(tag: string, description: string): Promise<void> {
  const tax = await loadTaxonomy();
  if (!tax.tags[tag]) tax.tags[tag] = {};
  tax.tags[tag].description = description;
  await saveTaxonomy(tax);
  console.log(`✓ Described "${tag}": ${description}`);
}

async function cmdShow(tag: string): Promise<void> {
  const { counts, files } = await collectCounts();
  const tax = await loadTaxonomy();
  const entry = tax.tags[tag];
  console.log(`\n  tag: ${tag}`);
  console.log(`  usage: ${counts[tag] ?? 0} file(s)`);
  if (entry?.aliases?.length) {
    console.log(`  aliases: ${entry.aliases.join(", ")}`);
  }
  if (entry?.description) {
    console.log(`  description: ${entry.description}`);
  }
  if (entry?.parent) {
    console.log(`  parent: ${entry.parent}`);
  }
  if ((files[tag] ?? []).length) {
    console.log(`  files:`);
    for (const f of files[tag]) console.log(`    - ${f}`);
  }
  console.log();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      await cmdList();
      return;
    case "audit":
      await cmdAudit();
      return;
    case "merge":
      if (rest.length < 2) {
        console.error("Usage: merge <from> <into>");
        process.exit(1);
      }
      await cmdMerge(rest[0], rest[1]);
      return;
    case "alias":
      if (rest.length < 2) {
        console.error("Usage: alias <canonical> <alias1> [<alias2>...]");
        process.exit(1);
      }
      await cmdAlias(rest[0], ...rest.slice(1));
      return;
    case "describe":
      if (rest.length < 2) {
        console.error('Usage: describe <tag> "<description>"');
        process.exit(1);
      }
      await cmdDescribe(rest[0], rest.slice(1).join(" "));
      return;
    case "show":
      if (rest.length < 1) {
        console.error("Usage: show <tag>");
        process.exit(1);
      }
      await cmdShow(rest[0]);
      return;
    default:
      console.error(
        "Usage: skill-tags.ts <list|audit|merge|alias|describe|show> [args]",
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
