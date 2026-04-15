# PRD — X Bookmark Harvester

**Version :** 1.0  
**Date :** 15 avril 2026  
**Statut :** Draft

---

## 1. Contexte & Objectif

L'utilisateur accumule des bookmarks sur X (Twitter) contenant des ressources précieuses (méthodes, best practices, insights) principalement autour de la génération vidéo et du prompting. Aujourd'hui, le traitement de ces bookmarks est entièrement manuel : copier le lien, le passer à un LLM, récupérer un fichier markdown structuré.

L'objectif est de créer une **application web** qui automatise la collecte et le formatage brut du contenu des posts X bookmarkés, pour les archiver dans un **vault Obsidian local**. L'analyse sémantique du contenu sera réalisée séparément par l'utilisateur via Claude.

---

## 2. Périmètre fonctionnel

### 2.1 Modes d'entrée

**Mode 1 — Bookmarks automatiques (Prioritaire)**

Récupération automatique de la liste des bookmarks de l'utilisateur via l'API X. Possibilité de traiter tous les bookmarks en batch ou de sélectionner ceux à traiter. Détection des bookmarks déjà traités pour éviter les doublons.

**Mode 2 — Lien manuel (Fallback)**

Champ de saisie permettant de coller un ou plusieurs liens X. Traitement individuel ou en lot. Ce mode sert de fallback si l'API bookmarks ne fonctionne pas, ou pour traiter un post hors bookmarks.

### 2.2 Extraction du contenu

Pour chaque post X, l'outil doit extraire l'ensemble des données suivantes via **Grok (API xAI)** qui dispose d'un accès natif au contenu X :

- Texte intégral du post (thread complet si applicable)
- Date de publication
- Auteur (handle + nom)
- Images et médias associés (URLs + téléchargement local)
- Commentaires pertinents (top replies, replies de l'auteur)
- Métriques (likes, retweets, replies, vues)

### 2.3 Génération du fichier Markdown

Chaque post traité génère un fichier `.md` structuré avec un front matter YAML compatible Obsidian. Un prompt par défaut structure l'extraction, mais il est modifiable par l'utilisateur depuis l'interface.

### 2.4 Stockage — Obsidian

Les fichiers markdown sont déposés dans un dossier configurable du vault Obsidian local de l'utilisateur. L'outil doit permettre de configurer le chemin du vault et du sous-dossier cible. Les images téléchargées sont stockées dans un sous-dossier `/assets` dédié.

---

## 3. Architecture technique

| Composant | Choix |
|---|---|
| Frontend | App web (framework au choix des développeurs) |
| Backend | API REST / serverless (stack libre) |
| Lecture des posts | API Grok (xAI) — accès natif au contenu X |
| Bookmarks | API X v2 (endpoint `GET /2/users/:id/bookmarks`) |
| Stockage | Système de fichiers local (vault Obsidian) |
| Auth X | OAuth 2.0 PKCE (scope `bookmark.read`, `tweet.read`) |

### 3.1 Flux de données

1. L'utilisateur déclenche la collecte (batch bookmarks ou lien manuel)
2. L'app récupère les IDs des posts via l'API X (mode 1) ou parse les URLs (mode 2)
3. Pour chaque post, appel à l'API Grok pour extraire le contenu complet
4. Grok retourne le contenu structuré (texte, médias, commentaires, métriques)
5. L'app génère le fichier `.md` avec front matter YAML
6. Le fichier est déposé dans le vault Obsidian configuré

---

## 4. User Stories

| ID | User Story | Priorité |
|---|---|---|
| US1 | En tant qu'utilisateur, je veux connecter mon compte X pour que l'app accède à mes bookmarks. | **Must** |
| US2 | En tant qu'utilisateur, je veux voir la liste de mes bookmarks X et sélectionner ceux à traiter. | **Must** |
| US3 | En tant qu'utilisateur, je veux lancer un traitement batch de tous mes bookmarks non traités. | **Must** |
| US4 | En tant qu'utilisateur, je veux coller un lien X manuellement pour traiter un post spécifique. | **Must** |
| US5 | En tant qu'utilisateur, je veux que le contenu complet du post (texte, images, commentaires, métriques) soit extrait. | **Must** |
| US6 | En tant qu'utilisateur, je veux qu'un fichier `.md` structuré soit généré pour chaque post dans mon vault Obsidian. | **Must** |
| US7 | En tant qu'utilisateur, je veux configurer le chemin de mon vault Obsidian et le dossier cible. | **Must** |
| US8 | En tant qu'utilisateur, je veux pouvoir modifier le prompt de structuration du markdown. | **Should** |
| US9 | En tant qu'utilisateur, je veux voir le statut de traitement de chaque bookmark (traité, en cours, erreur). | **Should** |
| US10 | En tant qu'utilisateur, je veux que les doublons soient détectés et ignorés automatiquement. | **Should** |
| US11 | En tant qu'utilisateur, je veux que les images soient téléchargées localement et référencées dans le markdown. | **Could** |
| US12 | En tant qu'utilisateur, je veux un historique des posts traités avec possibilité de relancer un traitement. | **Could** |

---

## 5. Format de sortie Markdown

Chaque fichier généré doit suivre cette structure :

```markdown
---
title: "[Titre du post ou première ligne]"
author: "@handle"
date: YYYY-MM-DD
source: "[URL complète du post]"
likes: N
retweets: N
replies: N
views: N
tags: [x-bookmark, video-gen, prompting]
status: raw
---

## Contenu du post

[Transcription verbatim du post / thread complet]

## Médias

![[assets/nom-du-fichier.png]]

## Commentaires notables

> **@handle_commentateur** (YYYY-MM-DD)
> [Contenu du commentaire]
```

**Convention de nommage des fichiers :** `YYYY-MM-DD_handle_premiers-mots-du-post.md`

---

## 6. Prompt par défaut

Le prompt suivant est utilisé par défaut pour structurer l'extraction via Grok. Il est modifiable par l'utilisateur dans les paramètres de l'application.

```
Use the X link provided as the primary source.

Extract the following information and return it as structured markdown:

1. The publication date of the post.
2. The author (handle and display name).
3. A full verbatim transcription of the post (include all parts if it's a thread).
4. URLs of all media (images, videos) attached to the post.
5. Engagement metrics: likes, retweets, replies, views.
6. If comments add meaningful value, include a full verbatim transcription of the top replies and any replies from the original author.

Format the output as a markdown file with YAML front matter containing: title, author, date, source URL, metrics, tags, and status set to "raw".
```

---

## 7. Contraintes & Risques identifiés

### API X — Bookmarks

- L'endpoint bookmarks a déjà posé problème par le passé. **Spike technique recommandé en priorité.**
- Requiert un accès API X de niveau Basic minimum (100$/mois) ou Pro.
- Rate limiting : vérifier les quotas selon le tier d'abonnement.

### API Grok (xAI)

- Vérifier que l'API Grok permet bien de lire le contenu d'un post X à partir d'un ID ou URL.
- Coût API à estimer en fonction du volume de bookmarks.
- Limites de tokens pour les threads longs avec nombreux commentaires.

### Stockage local

- L'app web devra écrire en local : envisager une app Electron/Tauri ou un serveur local léger.
- Alternative : générer un `.zip` téléchargeable que l'utilisateur dépose dans son vault.

---

## 8. Phasage de développement

### Phase 1 — MVP (2-3 semaines)

- Spike technique API X bookmarks + API Grok
- Mode 2 (lien manuel) fonctionnel : saisie d'un lien → extraction via Grok → génération `.md` → téléchargement
- Interface web minimaliste

### Phase 2 — Bookmarks auto (2 semaines)

- Intégration API X bookmarks (OAuth)
- Mode batch
- Détection des doublons

### Phase 3 — Polishing (1-2 semaines)

- Éditeur de prompt intégré
- Téléchargement des images en local
- Historique et suivi de statut
- Configuration du chemin vault Obsidian

---

## 9. Critères d'acceptation

- Un lien X collé manuellement produit un fichier `.md` valide en moins de 30 secondes.
- Le fichier `.md` s'ouvre correctement dans Obsidian avec le front matter YAML reconnu.
- Le contenu extrait est complet (texte, médias, commentaires, métriques).
- Le mode batch traite 50+ bookmarks sans interruption.
- Les doublons sont correctement détectés et ignorés.
- Le prompt de structuration est modifiable depuis l'interface.

---

## 10. Hors périmètre (explicitement exclu)

- Analyse sémantique / extraction d'insights (fait manuellement via Claude)
- Système de tags automatiques / catégorisation intelligente
- Synchronisation cloud / multi-device
- Support d'autres plateformes que X
