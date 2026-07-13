# Chantier qualité X-sync — diagnostic & design (2026-07-12)

> Statut : **PROPOSITION — en attente de validation** (checkpoint avant toute ligne de code).

## 1. Diagnostic — preuves sur le corpus réel (265 notes, 266 caches `state/.raw`)

### 1.1 Threads incomplets — PARTIELLEMENT CONFIRMÉ (et l'exemple cité est infirmé)

- **L'exemple `diegocabezas01` est en fait complet** : le cache (fetché le 04/07, 3 j après le post) contient les 10 tweets du thread, et la note se termine par « That's it. ». Le « : » final est celui du *titre* (= 1ʳᵉ ligne du 1ᵉʳ tweet). Les 69 posts de l'auteur dans les commentaires sont ses réponses aux commentateurs, pas le thread.
- **Le problème structurel est réel ailleurs** : la capture de thread repose sur `search/recent` (`conversation_id:`) limité à **7 jours**. Tout post plus vieux au moment du sync perd son thread *silencieusement*. 211 caches sur 266 sont « stale » (0 commentaire, replies>0) → fetchés hors fenêtre → thread tail perdu aussi. ~16 d'entre eux portent un marqueur explicite de thread (🧵, 1/n, 👇).
- Fragilités additionnelles du code actuel (`api.ts`) : pagination newest-first ⇒ sur conversation >500 tweets, la suite du thread (posts les plus anciens) tombe hors des 5 pages ; un bookmark pris *au milieu* d'un thread ne remonte jamais ses ancêtres.

### 1.2 Commentaires en vrac — CONFIRMÉ, cause précisée

- Note max : **293 blocs** de commentaires (diegocabezas01), plafond effectif 300 (le doc du code dit 100, le défaut réel est 300).
- Le tri par likes **existe déjà à l'extraction** (xapi), mais : les likes **ne sont pas stockés** (`PostComment` sans `likes`) donc invisibles et non re-triables au rendu ; réponses-aux-réponses mélangées aux réponses directes ; aucun dédoublonnage de textes identiques inter-comptes ; les commentaires Grok seraient fusionnés *en fin de liste, non triés* ; **aucun plafond au rendu**.
- Distribution corpus : médiane **0** commentaire, p90 = 11, max 293 ; **218 notes / 265 à zéro commentaire**. Le vrai problème dominant est le VIDE (posts vieux), pas seulement le trop-plein.

### 1.3 Images non rapatriées — CONFIRMÉ, au-delà du chemin Grok

- **174 notes / 265** contiennent encore des URLs `twimg.com` périssables ; seules 25 notes ont des `![[assets/…]]` (35 fichiers dans `assets/`).
- Cause : `media-download` est arrivé tard ; il ne télécharge que `type === "image"` (64 vidéos + 1 gif jamais rapatriés) ; les notes anciennes n'ont jamais été re-rendues.
- Bonne nouvelle : les URLs médias sont dans les caches → un backfill re-render + download répare la plupart des images **sans re-fetch API**.

### 1.4 Deux formats de note — CONFIRMÉ

- 198 notes à l'ancien format FR (`## Contenu du post` / `## Médias`), 66 au format sync EN (`## Post` / `## Media` / `## Notable comments`), 206 avec `## Summary` (flux enrich, à préserver), 0 `## Grok Insights`.
- Frontmatter aussi incohérent (tags inline vs multilignes, quoting variable).

### 1.5 Découvertes hors audit

- **Grok n'a jamais servi** : 266/266 caches ont `source: "xapi"`, 0 grokInsights. La chaîne de fallback (livrée le 04/07) n'a traité que 5 posts récents, tous complets via xapi.
- Le modèle par défaut du code (`grok-4`) est **retiré depuis le 15/05/2026** → les appels seraient redirigés vers `grok-4.3` (low reasoning) à la tarification grok-4.3. À épingler explicitement.
- `scripts/render.ts all` lit `.raw` **au mauvais endroit** (vault au lieu de `XBM_STATE_DIR`) — bug, le batch re-render est cassé.
- Erreurs Grok/xapi seulement en `console.warn` → invisibles dans le résumé JSON du sync (mauvais pour le futur relais Telegram).

## 2. Contexte tarifaire 2026 (vérifié docs officielles, 12/07/2026)

### X API v2 — pay-per-use (les paliers Basic/Pro sont fermés, migration forcée depuis juin 2026)

| Poste | Prix |
|---|---|
| Posts : lecture | **$0.005 / post retourné** (recherche incluse : 1 page de 100 = $0.50) |
| Bookmarks du propriétaire de l'app (« Owned Reads ») | $0.001 / ressource |
| Déduplication | même ressource re-demandée dans la même journée UTC = non refacturée |
| **`search/all` (full-archive, 2006→)** | **disponible en pay-per-use** — c'est LE déblocage : commentaires + threads des vieux posts accessibles par l'API directe, avec `like_count` exacts |

Pas d'opérateur `min_faves` en v2 self-serve → impossible de filtrer par traction côté serveur ; on paie ce qu'on récupère → **plafonner les pages est la maîtrise de coût**.

### xAI Grok

- `grok-4.5` $2/$6 par Mtok ; **`grok-4.3`** $1.25/$2.50, contexte 1M, reasoning effort réglable — le bon rapport qualité/prix pour de l'extraction.
- Outil `x_search` : $5/1k appels ($0.005/appel). Un appel d'extraction complet ≈ **$0.03–0.06/post**.

## 3. Design proposé

### 3.1 Principe : API X = source de vérité déterministe ; Grok = filet de sécurité uniquement

La justification historique du fallback Grok (« les commentaires des posts >7 j sont inaccessibles ») **tombe** avec `search/all` en pay-per-use. Je propose donc, contrairement à l'idée d'étendre le rôle de Grok :

- **Extraction (texte, thread, médias, commentaires) : X API seule**, `search/all` pour tout post >6 jours, `search/recent` sinon (mêmes prix, meilleures rate limits). Données exactes (likes réels pour le tri), déterministes, testables.
- **Grok (`grok-4.3` épinglé, effort low) : fallback dernier recours** quand l'API échoue ou revient vide (post supprimé/protégé entre-temps), et ses erreurs remontent dans le résumé JSON au lieu de `console.warn`.
- **Tri/synthèse des commentaires par Grok : NON recommandé.** Tri = un `sort()` sur des likes exacts qu'on possède ; payer un LLM pour ça ajoute du flou (chiffres approximatifs, citations potentiellement altérées) sans gain. La synthèse existe déjà via ton flux enrich (`## Summary`, Claude) — pas de doublon Grok.
- **MCP X : sondé le 12/07 (xmcp 1.0.0 hébergé sur api.x.com/mcp, 24 outils) → à ranger.** C'est un wrapper des mêmes endpoints v2, même bearer, même facturation. Trois constats décisifs : (1) aucun paramètre `media.fields` dans ses schémas → impossible d'obtenir les variantes vidéo dont notre pipeline médias a besoin ; (2) pas de `search_posts_recent` (seulement `search_posts_all`) ; (3) couche JSON-RPC en plus sans donnée en plus. Le seam `mcp-source.ts` reste en place (coût nul), on n'investit pas.
  - **Deux nuggets de la sonde à réutiliser** : `sort_order=relevancy` sur search (dispo aussi en API directe → 1 page « pertinence » suffit souvent pour les meilleurs commentaires, réduit le coût) ; outils *bookmark folders* (hors périmètre, noté pour un futur sync par dossier).

### 3.2 Capture de thread (nouvelle logique)

1. Lookup du post bookmarké ($0.005) → `conversation_id`, métriques, médias.
2. **Une requête ciblée `conversation_id:<id> from:<author>`** (all ou recent selon l'âge) → tous les posts de l'auteur dans la conversation, généralement <20 → ~$0.01–0.10.
3. Reconstruction de la **chaîne self-reply** via `referenced_tweets` : ancêtres (si bookmark au milieu du thread) + suite. Plus de dépendance à « le parent doit être dans les 500 fetchés ».
4. Rendu : tweets du thread séparés par `---`, texte intégral (`note_tweet`/`article` gérés comme aujourd'hui).
5. Les réponses de l'auteur *hors chaîne* (réponses aux commentateurs) vont dans les commentaires, marquées « auteur ».

### 3.3 Commentaires : règles de curation (déterministes)

- Fetch : conversation **plafonnée à 1 page** (100 résultats, ≤$0.50/post, configurable `--comment-pages`).
- `PostComment` gagne `likes: number` (+ `isAuthor`, `replyToRoot`) → cache **v2** (migration lecture : anciens caches → `likes: null`).
- Pipeline de curation au rendu (re-réglable sans re-fetch) :
  1. dédoublonnage : clé handle+texte existante **+ textes identiques inter-handles** (spam) ;
  2. filtres : réponses directes au thread seulement (les réponses-aux-réponses sortent, sauf celles de l'auteur) ; exclusion des <15 caractères utiles / emoji-only / @-mentions pures ;
  3. tri : `likes` desc (traction), réponses de l'auteur toujours en tête de liste ;
  4. **plafond de rendu : top 15** (défaut, configurable) + ligne « N commentaires capturés, M affichés » ;
  5. affichage : `> **@handle** (Nom) — date — ♥ 123`.

### 3.4 Médias : rapatriement systématique

- Images + gif : téléchargés (comme aujourd'hui, hosts twimg allowlistés, cap 20 MB).
- **Vidéos (validé) : poster (`preview_image_url`) téléchargé + lien mp4 distant + transcript/description.** Deux routes possibles pour le transcript, cumulables :
  - `view_x_video` (outil Grok, token-based ≈ $0.01–0.05/vidéo) : description visuelle + propos tenus, sans télécharger le mp4 — voie par défaut ;
  - STT xAI ($0.10/heure d'audio) sur mp4 téléchargé pour un verbatim exact — optionnel (`--stt`), nécessite ffmpeg, réservé aux vidéos où le verbatim compte.
  - Rendu : poster embarqué + bloc `> Transcript :` sous le média. 64 vidéos du corpus ≈ **$1–3** en backfill via view_x_video.
- Le chemin fallback Grok passe par le même `downloadImages` (déjà le cas dans sync) — le trou venait des notes historiques jamais re-rendues, corrigé par le backfill.

### 3.5 Format de note unifié (UN seul renderer, pour sync ET backfill)

```
---
title / author / author_name / date / source
likes / retweets / replies / views
tags / status (raw|enriched) / statut: source
thread: 4            ← nb de tweets du thread (1 = post simple)
comments_captured: 87
---
## Post              ← thread ENTIER, tweets séparés par ---
## Media             ← ![[assets/<id>_n.jpg]] ; vidéos: poster + transcript + lien
## Summary           ← PRÉSERVÉ tel quel s'il existe (flux enrich)
## Comments          ← top 15 curés, ♥ visibles, auteur en tête
```

- Langue des titres de section : **EN (validé)** — la mise à niveau convertira les 198 notes FR vers ce format en préservant leur contenu.
- Le renderer **préserve** lors d'un ré-écrasement : `## Summary`, `tags` curés, `status` — il ne régénère que Post/Médias/Commentaires + métriques frontmatter. C'est LA condition pour backfiller sans détruire le travail d'enrichissement (206 notes).

### 3.6 Sync : coût et contrat Telegram

- Listing bookmarks **incrémental** : pagination stoppée dès qu'une page entière est déjà connue (l'API renvoie les bookmarks du plus récent au plus ancien) + `--full` pour forcer. Passe de ~$2/run à ~$0.2–0.5/run hebdo.
- Résumé JSON enrichi : `new / known / failed / skipped / estimatedCostUsd / grokFallbacks` + **une ligne texte courte** (`3 nouveaux · 262 connus · 0 erreur · ~$0.42`) réutilisable telle quelle par le relais Telegram. Non-interactif, idempotent, exit codes propres — inchangé.
- La routine `x-booking-sync` du lundi 9h01 reste compatible (aucun changement de signature de `skill:sync`/`skill:report`).

## 4. Coûts estimés

### Régime de croisière (par nouveau bookmark)

| Poste | Coût |
|---|---|
| Lookup post | $0.005 |
| Thread (`from:author`) | ~$0.01–0.05 |
| Commentaires (≤1 page) | ~$0.10 médian, $0.50 max |
| Médias | $0 (bande passante) |
| **Total** | **~$0.12/post médian, $0.55 plafonné** → ~40 posts/mois ≈ **$5–6/mois** + listing ~$1–2 |

### Backfill des 265 notes existantes (phase séparée, validation dédiée)

| Option | Contenu | Coût estimé |
|---|---|---|
| **A. Minimal (sans API)** | re-render unifié + téléchargement des images depuis les caches existants | **$0** (78 notes restent sans commentaires récupérables… sur 218) |
| **B. API search/all** (recommandée) | A + threads exacts + commentaires avec likes réels pour les 211 posts stale | **~$40–60** (plafonnable : cap 1 page/post ⇒ borne dure $0.55/post ; préflight `--dry-run` avec devis exact avant exécution) |
| C. Grok curation | A + commentaires curés par grok-4.3 pour les 211 posts | ~$10–15, mais likes approximatifs, citations non garanties, non déterministe |

Sync initial des ~135 bookmarks du compte 2 (fin de chantier) : mêmes coûts unitaires ⇒ **~$15–25** en option B.

### Ce que le pay-per-use change pour TOI (à confirmer)

Ancien Basic $200/mois → ce chantier complet (backfill B + compte 2 + 6 mois de croisière) coûte **moins qu'un seul mois de l'ancien Basic**. Mais je dois confirmer que ton compte console.x.com est bien passé en crédits pay-per-use et que `search/all` répond avec ton bearer actuel (test à 1 requête = quelques cents, prévu en début de Phase 1).

## 5. Phases d'implémentation (après validation)

| Phase | Contenu | Garde-fous |
|---|---|---|
| **P0 — correctifs** | bug `render.ts all` (chemin `.raw`) ; épingler `grok-4.3` + effort ; erreurs de chaîne remontées dans le résumé JSON | tests existants verts |
| **P1 — extraction** | `search/all`, thread par `from:author` + chaîne self-reply, `PostComment.likes`, cache v2, plafonds de pages | nouveaux tests unitaires (fixtures conversations) |
| **P2 — rendu & curation** | renderer unifié + préservation Summary/tags, pipeline commentaires, médias (posters vidéo) | golden tests de rendu ; `render all` réparé |
| **P3 — sync** | listing incrémental, devis de coût dans le résumé, ligne Telegram | dry-run sur compte principal |
| **P4 — backfill** | `skill:backfill` avec `--dry-run` (devis exact), échantillon 10 notes validé par toi, puis corpus ; **plan+coût re-validés séparément** | jamais d'écriture manuelle dans le vault ; Summary/tags préservés ; dédup par tweet ID intact |
| **P5 — test réel** | sync complet compte 2 (~135 bookmarks) | après validation du backfill |
| Livrables | PR relue par toi ; fiche Outil ; Kanban ✔️ ; memory.md | routine lundi 9h01 intacte |

Chaque phase : branche dédiée `feat/quality-chain`, typecheck + 83 tests verts + nouveaux tests, commits atomiques (attention CRLF : le diff actuel du working tree est du bruit de fins de ligne, je ne stagerai que mes fichiers).

## 6. Décisions du checkpoint (12/07/2026)

1. **Backfill : option B avec échantillon** — re-render+images gratuits, puis 10 notes test via API (~$2), jugement humain, GO/NO-GO corpus (devis `--dry-run` exact avant).
2. **Vidéos : poster + lien + transcript** (`view_x_video` par défaut, STT en option).
3. **Sections : EN** (`## Post / ## Media / ## Summary / ## Comments`).
4. Plafond commentaires affichés : 15 (configurable).

### Reste à lever avant P1

- **Plan X API** : vérifier sur console.x.com le passage en pay-per-use + crédits ; sinon, le test `search/all` (~$0.01) en début de P1 tranchera de fait.
- **Sonde MCP** : `npm run skill:mcp-probe` à lancer côté Windows (sandbox sans réseau vers api.x.com) — coller la sortie dans le chantier ; verdict attendu : ranger le seam MCP.
