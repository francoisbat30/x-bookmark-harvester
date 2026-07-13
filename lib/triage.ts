/**
 * Listes de triage éditées à la main (backfill/sync) : un tweet ID par ligne,
 * suivi de n'importe quel commentaire. Lignes vides et # ignorées.
 *
 *   state/triage-skip.txt  — anciens posts SANS refetch (re-render seul)
 *   state/triage-light.txt — nouveaux bookmarks en mode léger (sans commentaires)
 *
 * Supprimer une ligne rend au post le traitement complet. Fichiers versionnés
 * (state/ est tracké) : le tri est auditable et réversible.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { stateDir } from "./state";

export async function loadTriageList(
  filename: "triage-skip.txt" | "triage-light.txt",
): Promise<Set<string>> {
  const p = path.join(stateDir(), filename);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const id = t.split(/\s+/)[0];
    if (/^\d+$/.test(id)) ids.add(id);
  }
  return ids;
}
