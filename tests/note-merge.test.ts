import { describe, it, expect } from "vitest";
import { extractPreservedParts } from "../lib/obsidian/note-merge";

describe("extractPreservedParts", () => {
  it("returns nothing for null/empty content", () => {
    expect(extractPreservedParts(null)).toEqual({});
    expect(extractPreservedParts("")).toEqual({});
    expect(extractPreservedParts(undefined)).toEqual({});
  });

  it("extracts tags, status and Summary from a full note", () => {
    const content = `---
title: "T"
tags:
  - x-bookmark
  - ai-agents
status: enriched
---

## Summary

Line one.
Line two.

## Post

body
`;
    const parts = extractPreservedParts(content);
    expect(parts.tags).toEqual(["x-bookmark", "ai-agents"]);
    expect(parts.status).toBe("enriched");
    expect(parts.summary).toBe("Line one.\nLine two.");
  });

  it("supports inline tags arrays and CRLF line endings", () => {
    const content =
      "---\r\ntags: [x-bookmark, llm]\r\nstatus: raw\r\n---\r\n\r\n## Summary\r\n\r\nCRLF summary.\r\n\r\n## Post\r\n\r\nbody\r\n";
    const parts = extractPreservedParts(content);
    expect(parts.tags).toEqual(["x-bookmark", "llm"]);
    expect(parts.summary).toBe("CRLF summary.");
  });

  it("captures a Summary that is the last section", () => {
    const parts = extractPreservedParts(`---
status: enriched
---

## Post

body

## Summary

Trailing summary.`);
    expect(parts.summary).toBe("Trailing summary.");
  });

  it("tolerates the legacy '## Résumé' heading", () => {
    const parts = extractPreservedParts(`---
status: raw
---

## Résumé

Ancien résumé.

## Contenu du post

corps`);
    expect(parts.summary).toBe("Ancien résumé.");
  });

  it("ignores unreadable frontmatter without crashing", () => {
    const parts = extractPreservedParts(`---
: not yaml [
---

## Summary

Still extracted.`);
    expect(parts.tags).toBeUndefined();
    expect(parts.summary).toBe("Still extracted.");
  });

  it("returns no summary when the section is empty", () => {
    const parts = extractPreservedParts(`---
status: raw
---

## Summary

## Post

body`);
    expect(parts.summary).toBeUndefined();
  });
});
