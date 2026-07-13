/**
 * Préservation du travail d'enrichissement lors d'un ré-écrasement de note.
 *
 * Le renderer régénère Post / Media / Comments, mais une note existante peut
 * porter : une section `## Summary` (écrite par le flux enrich, souvent après
 * relecture humaine), des `tags` curés et un `status` avancé (raw → enriched).
 * Perdre ça au re-render (sync --refetch, render all, backfill) détruirait
 * 200+ notes de travail — on l'extrait donc AVANT d'écraser, et le renderer
 * le réinjecte.
 */
import { parse as parseYaml } from "yaml";

export interface PreservedNoteParts {
  /** Tags de la note existante (curés par enrich), à re-fusionner. */
  tags?: string[];
  /** Statut de workflow (ex. "enriched") à conserver tel quel. */
  status?: string;
  /** Corps de la section `## Summary` (sans le titre), tel quel. */
  summary?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Corps de la section `## Summary` (ou l'ancien `## Résumé`) : parsing ligne
 * à ligne (CRLF-safe), borné au prochain titre `## ` — une regex gloutonne se
 * fait piéger par les sections vides.
 */
function extractSummaryBody(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+(Summary|Résumé)\s*$/.test(l));
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

export function extractPreservedParts(
  existingContent: string | null | undefined,
): PreservedNoteParts {
  if (!existingContent) return {};
  const out: PreservedNoteParts = {};

  const fm = existingContent.match(FRONTMATTER_RE);
  if (fm) {
    try {
      const data = parseYaml(fm[1]) as Record<string, unknown> | null;
      if (data && typeof data === "object") {
        if (Array.isArray(data.tags)) {
          out.tags = data.tags.map((t) => String(t)).filter(Boolean);
        }
        if (typeof data.status === "string" && data.status.trim()) {
          out.status = data.status.trim();
        }
      }
    } catch {
      // Frontmatter illisible → on ne préserve rien plutôt que de corrompre.
    }
  }

  const summary = extractSummaryBody(existingContent);
  if (summary) out.summary = summary;
  return out;
}
