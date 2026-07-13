/**
 * Curation des commentaires au moment du RENDU (jamais à l'extraction) :
 * le cache garde tout ce qui a été payé à l'API, les règles ci-dessous se
 * re-règlent sans re-fetch (render all).
 *
 * Règles (design du chantier qualité, validé le 2026-07-12) :
 *   1. dédoublonnage — clé handle+texte ET texte identique inter-handles (spam) ;
 *   2. filtres — réponses directes au thread seulement (les réponses-aux-
 *      réponses sortent, sauf celles de l'auteur) ; exclusion des réponses
 *      creuses (<15 caractères utiles après retrait des @mentions de tête) ;
 *   3. tri — réponses de l'auteur d'abord (ordre chronologique), puis likes
 *      décroissants (traction) ; likes inconnus (cache v1 / Grok muet) après
 *      les likes connus, dans leur ordre d'arrivée ;
 *   4. plafond — top 15 par défaut.
 */
import type { PostComment } from "../types";

export interface CurateOptions {
  /** Handle de l'auteur du post (sans @) — ses réponses sont prioritaires. */
  authorHandle: string;
  /** Nombre max de commentaires rendus. */
  cap?: number;
}

export interface CuratedComments {
  shown: PostComment[];
  /** Nombre total de commentaires capturés (avant curation). */
  captured: number;
}

/** Texte « utile » : sans les @mentions de tête ni les espaces superflus. */
function usefulText(text: string): string {
  return text
    .replace(/^(\s*@[A-Za-z0-9_]+)+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedKey(text: string): string {
  return usefulText(text).toLowerCase();
}

function isAuthorComment(c: PostComment, authorHandle: string): boolean {
  return (
    c.isAuthor === true ||
    (authorHandle.length > 0 &&
      c.handle.toLowerCase() === authorHandle.toLowerCase())
  );
}

export function curateComments(
  comments: PostComment[],
  options: CurateOptions,
): CuratedComments {
  const { authorHandle, cap = 15 } = options;
  const captured = comments.length;

  const seenHandleText = new Set<string>();
  const seenText = new Set<string>();
  const kept: PostComment[] = [];

  for (const c of comments) {
    const author = isAuthorComment(c, authorHandle);
    const useful = usefulText(c.text);

    // Filtres de bruit — jamais appliqués à l'auteur (ses réponses complètent
    // son propos, même courtes).
    if (!author) {
      if (useful.length < 15) continue;
      // isDirectReply === false → réponse-à-une-réponse (bruit de fil).
      // undefined (cache v1) = inconnu → on garde.
      if (c.isDirectReply === false) continue;
    }

    const hk = `${c.handle.toLowerCase()}|${normalizedKey(c.text)}`;
    if (seenHandleText.has(hk)) continue;
    const tk = normalizedKey(c.text);
    if (!author && tk.length > 0 && seenText.has(tk)) continue;
    seenHandleText.add(hk);
    seenText.add(tk);
    kept.push(c);
  }

  const authorReplies = kept.filter((c) => isAuthorComment(c, authorHandle));
  authorReplies.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const others = kept.filter((c) => !isAuthorComment(c, authorHandle));
  const withLikes = others.filter((c) => typeof c.likes === "number");
  const unknownLikes = others.filter((c) => typeof c.likes !== "number");
  withLikes.sort((a, b) => (b.likes as number) - (a.likes as number));

  const shown = [...authorReplies, ...withLikes, ...unknownLikes].slice(
    0,
    Math.max(1, cap),
  );
  return { shown, captured };
}
