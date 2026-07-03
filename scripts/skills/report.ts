/**
 * Report skill — generates `00 Report.md` at the root of the bookmarks folder:
 * global KPIs of the saved corpus (volumes by tag/author/month, statuses,
 * engagement). Meant to be re-run after each sync so the report stays fresh.
 *
 *   npm run skill:report
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { listBookmarks, vaultDir, type ParsedBookmark } from "./utils";

const REPORT_FILENAME = "00 Report.md";

function pct(part: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((part / total) * 100)}%`;
}

function bar(count: number, max: number, width = 20): string {
  if (max === 0) return "";
  return "█".repeat(Math.max(1, Math.round((count / max) * width)));
}

function countBy<T>(items: T[], key: (item: T) => string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    for (const k of key(item)) {
      if (!k) continue;
      map.set(k, (map.get(k) ?? 0) + 1);
    }
  }
  return map;
}

function sortedDesc(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function main() {
  const all = (await listBookmarks()).filter(
    (b) => b.filename !== REPORT_FILENAME,
  );
  const now = new Date();
  // "sv-SE" => YYYY-MM-DD HH:mm, rendu en heure locale suisse
  const generated = new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Zurich",
  }).format(now);

  const enriched = all.filter((b) => b.frontmatter.status === "enriched");
  const raw = all.filter((b) => b.frontmatter.status === "raw");

  // --- tags (skip the universal x-bookmark marker) ---
  const tagCounts = countBy(all, (b) =>
    (b.frontmatter.tags ?? []).filter((t) => t !== "x-bookmark"),
  );
  const tags = sortedDesc(tagCounts);
  const maxTag = tags[0]?.[1] ?? 0;

  // --- authors ---
  const authors = sortedDesc(countBy(all, (b) => [b.frontmatter.author]));

  // --- months (12 derniers) ---
  const monthCounts = countBy(all, (b) => [
    (b.frontmatter.date ?? "").slice(0, 7),
  ]);
  const months = [...monthCounts.entries()]
    .filter(([m]) => /^\d{4}-\d{2}$/.test(m))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 12);
  const maxMonth = Math.max(0, ...months.map(([, c]) => c));

  // --- engagement ---
  const likes = all.map((b) => b.frontmatter.likes ?? 0);
  const topLiked = [...all]
    .sort((a, b) => (b.frontmatter.likes ?? 0) - (a.frontmatter.likes ?? 0))
    .slice(0, 5);

  const lines: string[] = [
    "---",
    `generated: ${generated}`,
    "type: report",
    "statut: source",
    "tags: [x-bookmark, report]",
    "---",
    "",
    "# 📊 X Bookmarks — Rapport global",
    "",
    `> Généré automatiquement (\`npm run skill:report\`, relancé par \`/x-sync\`) le ${generated}. Ne pas éditer à la main.`,
    "",
    "## Vue d'ensemble",
    "",
    `- **${all.length}** bookmarks au total`,
    `- **${enriched.length}** enrichis (${pct(enriched.length, all.length)}) · **${raw.length}** bruts (${pct(raw.length, all.length)})${raw.length ? " → `npm run skill:enrich:write`" : ""}`,
    `- **${tagCounts.size}** tags distincts · **${authors.length}** auteurs distincts`,
    "",
    "## Volume par tag",
    "",
    "| Tag | Volume | |",
    "|---|---:|---|",
    ...tags
      .filter(([, c]) => c >= 2)
      .map(([t, c]) => `| \`${t}\` | ${c} | ${bar(c, maxTag)} |`),
    "",
    ...(tags.some(([, c]) => c === 1)
      ? [
          `*+ ${tags.filter(([, c]) => c === 1).length} tags à 1 seule note (dispersion — un \`npm run skill:tags\` peut aider à consolider la taxonomie).*`,
          "",
        ]
      : []),
    "## Top auteurs",
    "",
    "| Auteur | Bookmarks |",
    "|---|---:|",
    ...authors.slice(0, 15).map(([a, c]) => `| ${a} | ${c} |`),
    "",
    "## Par mois (12 derniers)",
    "",
    "| Mois | Ajouts | |",
    "|---|---:|---|",
    ...months.map(([m, c]) => `| ${m} | ${c} | ${bar(c, maxMonth)} |`),
    "",
    "## Engagement",
    "",
    `- Likes cumulés : **${likes.reduce((a, b) => a + b, 0).toLocaleString("fr-FR")}** · médiane : ${median(likes).toLocaleString("fr-FR")}`,
    "",
    "**Top 5 par likes :**",
    "",
    ...topLiked.map(
      (b: ParsedBookmark) =>
        `1. [${(b.frontmatter.title ?? b.filename).replace(/\n/g, " ").slice(0, 80)}](${b.frontmatter.source}) — ${b.frontmatter.author}, ${(b.frontmatter.likes ?? 0).toLocaleString("fr-FR")} ❤`,
    ),
    "",
  ];

  const target = path.join(vaultDir(), REPORT_FILENAME);
  await fs.writeFile(target, lines.join("\n"), "utf8");
  console.log(
    `Report écrit : ${target} (${all.length} bookmarks, ${tagCounts.size} tags)`,
  );
}

main().catch((e) => {
  console.error(`Report failed: ${(e as Error).message}`);
  process.exit(1);
});
