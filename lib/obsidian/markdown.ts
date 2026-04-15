import { stringify as stringifyYaml } from "yaml";
import type { GrokInsights, PostExtraction } from "../types";
import type { DownloadedImage } from "./media-download";

export interface RenderedNote {
  filename: string;
  content: string;
}

export interface RenderOptions {
  insights?: GrokInsights;
  downloadedImages?: DownloadedImage[];
}

export function renderNote(
  post: PostExtraction,
  options: RenderOptions = {},
): RenderedNote {
  const title = buildTitle(post.text);
  const filename = buildFilename(post);
  const frontmatter = buildFrontmatter(post, title);
  const body = buildBody(post, options);
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

function buildFrontmatter(post: PostExtraction, title: string): string {
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
    `tags: [x-bookmark]`,
    `status: raw`,
    "---",
  ];
  return lines.join("\n");
}

function buildBody(post: PostExtraction, options: RenderOptions): string {
  const { insights, downloadedImages } = options;
  const sections: string[] = [];

  sections.push("## Post\n\n" + (post.text || "_(empty)_"));

  if (post.media.length > 0) {
    const localByUrl = new Map(
      (downloadedImages ?? []).map((d) => [d.remoteUrl, d.localFilename]),
    );
    const mediaLines = post.media.map((m) => {
      const local = localByUrl.get(m.url);
      if (local) {
        return `![[assets/${local}]]`;
      }
      return `- [${m.type}] ${m.url}`;
    });
    sections.push("## Media\n\n" + mediaLines.join("\n"));
  }

  if (insights) {
    sections.push(buildInsightsSection(insights));
  }

  if (post.comments.length > 0) {
    const commentBlocks = post.comments.map((c) => {
      const header = `> **@${c.handle}**${c.name ? ` (${c.name})` : ""}${c.date ? ` — ${c.date}` : ""}`;
      const quoted = c.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `${header}\n${quoted}`;
    });
    sections.push("## Notable comments\n\n" + commentBlocks.join("\n\n"));
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
