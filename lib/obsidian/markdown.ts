import { stringify as stringifyYaml } from "yaml";
import type { GrokInsights, PostExtraction } from "../types";
import type { DownloadedImage } from "./media-download";
import { curateComments } from "./comments";
import { extractPreservedParts } from "./note-merge";

export interface RenderedNote {
  filename: string;
  content: string;
}

export interface VideoTranscript {
  /** URL distante de la vidéo concernée (clé de rapprochement). */
  url: string;
  text: string;
}

export interface RenderOptions {
  insights?: GrokInsights;
  downloadedImages?: DownloadedImage[];
  /**
   * Contenu actuel de la note si elle existe déjà : les parties issues du
   * travail d'enrichissement (## Summary, tags, status) sont préservées.
   */
  existingContent?: string | null;
  /** Transcripts/descriptions de vidéos (cache), rendus sous chaque média. */
  videoTranscripts?: VideoTranscript[];
  /** Plafond de commentaires rendus (défaut 15). */
  commentCap?: number;
}

/**
 * Renderer UNIQUE de note (format cible du chantier qualité, sections EN) :
 *
 *   frontmatter (+ thread, comments_captured, tags/status préservés)
 *   ## Post      — thread entier, tweets séparés par ---
 *   ## Media     — images locales, vidéos = poster + lien (+ transcript)
 *   ## Summary   — préservé tel quel s'il existe (flux enrich)
 *   ## Grok Insights — optionnel (action UI enrichWithGrok)
 *   ## Comments  — top N curés (traction ♥, auteur en tête)
 */
export function renderNote(
  post: PostExtraction,
  options: RenderOptions = {},
): RenderedNote {
  const preserved = extractPreservedParts(options.existingContent);
  const title = buildTitle(post.text);
  const filename = buildFilename(post);
  const curated = curateComments(post.comments, {
    authorHandle: post.author.handle,
    cap: options.commentCap ?? 15,
  });
  const frontmatter = buildFrontmatter(post, title, {
    tags: preserved.tags,
    status: preserved.status,
    commentsCaptured: curated.captured,
  });
  const body = buildBody(post, options, preserved.summary, curated);
  return {
    filename,
    content: `${frontmatter}\n\n${body}\n`,
  };
}

function buildTitle(text: string): string {
  const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  const clipped = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return clipped || "(untitled post)";
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildFilename(post: PostExtraction): string {
  // defense-in-depth: only accept a strict ISO date — every other byte
  // risks path traversal via `${date}_…` since date is not slugged.
  const date = ISO_DATE_RE.test(post.date ?? "") ? post.date : "0000-00-00";
  const handle = slug(post.author.handle || "unknown");
  const words = slug(firstWords(post.text, 6)) || "post";
  return `${date}_${handle}_${words}.md`;
}

function firstWords(text: string, count: number): string {
  const words = text
    .replace(/https?:\/\/\S+/g, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, count).join(" ");
}

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function yamlQuoted(s: string): string {
  return stringifyYaml(s, {
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  }).trimEnd();
}

interface FrontmatterExtras {
  tags?: string[];
  status?: string;
  commentsCaptured: number;
}

function buildFrontmatter(
  post: PostExtraction,
  title: string,
  extras: FrontmatterExtras,
): string {
  // Tags préservés (enrich) re-fusionnés, x-bookmark toujours présent.
  const tags = Array.from(new Set(["x-bookmark", ...(extras.tags ?? [])]));
  const threadLen = post.thread?.length ?? 1;
  const lines = [
    "---",
    `title: ${yamlQuoted(title)}`,
    `author: ${yamlQuoted(post.author.handle ? `@${post.author.handle}` : "")}`,
    `author_name: ${yamlQuoted(post.author.name)}`,
    `date: ${post.date || ""}`,
    `source: ${yamlQuoted(post.url)}`,
    `likes: ${post.metrics.likes}`,
    `retweets: ${post.metrics.retweets}`,
    `replies: ${post.metrics.replies}`,
    `views: ${post.metrics.views}`,
    `thread: ${threadLen}`,
    `comments_captured: ${extras.commentsCaptured}`,
    `tags: [${tags.join(", ")}]`,
    `status: ${extras.status ?? "raw"}`,
    `statut: source`,
    "---",
  ];
  return lines.join("\n");
}

function formatLikes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function buildBody(
  post: PostExtraction,
  options: RenderOptions,
  preservedSummary: string | undefined,
  curated: ReturnType<typeof curateComments>,
): string {
  const { insights, downloadedImages, videoTranscripts } = options;
  const sections: string[] = [];

  // ── Post : le thread entier, un bloc par tweet.
  const parts =
    post.thread && post.thread.length > 0
      ? post.thread.map((t) => t.text)
      : [post.text];
  sections.push(
    "## Post\n\n" + (parts.join("\n\n---\n\n") || "_(empty)_"),
  );

  // ── Media : embeds locaux ; vidéos = poster local + lien distant + transcript.
  if (post.media.length > 0) {
    const localByUrl = new Map(
      (downloadedImages ?? []).map((d) => [d.remoteUrl, d.localFilename]),
    );
    const transcriptByUrl = new Map(
      (videoTranscripts ?? []).map((t) => [t.url, t.text]),
    );
    const mediaLines = post.media.map((m) => {
      if (m.type === "image") {
        const local = localByUrl.get(m.url);
        return local ? `![[assets/${local}]]` : `- [image] ${m.url}`;
      }
      // vidéo / gif : poster en local si téléchargé, lien distant conservé.
      const chunks: string[] = [];
      const poster = m.posterUrl ? localByUrl.get(m.posterUrl) : undefined;
      if (poster) chunks.push(`![[assets/${poster}]]`);
      const localVideo = localByUrl.get(m.url);
      chunks.push(
        localVideo
          ? `![[assets/${localVideo}]]`
          : `- [${m.type}] ${m.url}`,
      );
      const transcript = transcriptByUrl.get(m.url);
      if (transcript) {
        chunks.push(
          "> Transcript :\n" +
            transcript
              .split("\n")
              .map((l) => `> ${l}`)
              .join("\n"),
        );
      }
      return chunks.join("\n");
    });
    sections.push("## Media\n\n" + mediaLines.join("\n\n"));
  }

  // ── Summary : préservé tel quel (écrit par le flux enrich, jamais régénéré ici).
  if (preservedSummary) {
    sections.push(`## Summary\n\n${preservedSummary}`);
  }

  if (insights) {
    sections.push(buildInsightsSection(insights));
  }

  // ── Comments : curés (voir lib/obsidian/comments.ts), auteur en tête.
  if (curated.shown.length > 0) {
    const commentBlocks = curated.shown.map((c) => {
      const marker = c.isAuthor || c.handle.toLowerCase() === post.author.handle.toLowerCase() ? "✍️ " : "";
      const likesPart =
        typeof c.likes === "number" ? ` — ♥ ${formatLikes(c.likes)}` : "";
      const header = `> ${marker}**@${c.handle}**${c.name ? ` (${c.name})` : ""}${c.date ? ` — ${c.date}` : ""}${likesPart}`;
      const quoted = c.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `${header}\n${quoted}`;
    });
    const footer = `_${curated.captured} comment${curated.captured === 1 ? "" : "s"} captured · ${curated.shown.length} shown_`;
    sections.push(
      "## Comments\n\n" + commentBlocks.join("\n\n") + "\n\n" + footer,
    );
  }

  return sections.join("\n\n");
}

function buildInsightsSection(insights: GrokInsights): string {
  const parts: string[] = ["## Grok Insights"];

  if (insights.author_additions) {
    parts.push(`### Author additions\n\n${insights.author_additions}`);
  }

  if (insights.notable_links.length > 0) {
    const lines = insights.notable_links.map(
      (l) => `- **${l.context}** — ${l.url}`,
    );
    parts.push(`### Notable links\n\n${lines.join("\n")}`);
  }

  if (insights.sentiment) {
    parts.push(`### Community sentiment\n\n${insights.sentiment}`);
  }

  if (insights.key_replies.length > 0) {
    const blocks = insights.key_replies.map(
      (r) => `> **@${r.handle}** — ${r.why}\n> \n> ${r.quote}`,
    );
    parts.push(`### Key replies\n\n${blocks.join("\n\n")}`);
  }

  return parts.join("\n\n");
}
