import path from "node:path";

/**
 * Répertoire d'état / cache interne de l'app (matière brute, PAS de livrables) :
 * extraction brute par tweet (.raw), taxonomies de tags/entités.
 * Vit dans le repo (C:\Dev\x-bookmark-harvester\state),
 * JAMAIS dans le vault Obsidian — seuls les livrables (notes, assets, 00 Report)
 * vont dans le Garden. Surchargeable par la variable d'env XBM_STATE_DIR.
 */
export function stateDir(): string {
  return process.env.XBM_STATE_DIR ?? path.join(process.cwd(), "state");
}
