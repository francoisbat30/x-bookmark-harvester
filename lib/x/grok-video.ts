/**
 * Transcript / description de vidéos X via Grok (outil x_search + video
 * understanding). Optionnel et explicitement activé (sync --transcripts) :
 * coût ≈ $0.01–0.05 par vidéo (tokens + appels d'outil).
 *
 * NOTE (première exécution live à valider en P5) : la capacité « X Video
 * Understanding » (view_x_video) est déclenchée par Grok pendant x_search ;
 * si l'API exige un flag d'activation supplémentaire sur l'outil, c'est ici
 * qu'il se règle (tools ci-dessous).
 */
import { callResponses, extractText, stripJsonFences } from "./xai-responses";

const INSTRUCTIONS = `You are a video transcription assistant. You receive an X (Twitter) post URL whose post contains one or more videos.

Use the x_search tool to open the post and WATCH each video it contains.

Return a single JSON object — no prose, no markdown fences:

{
  "videos": Array<{
    "order": number,          // 1-based order of appearance in the post
    "transcript": string      // verbatim speech if any, else "" 
  , "description": string     // 1-2 sentences: what the video shows
  }>
}

Rules:
- One entry per video, in order of appearance.
- "transcript" is the spoken words only, verbatim, no timestamps. Empty string if no speech.
- Do not invent content. If the post or a video cannot be read, return { "videos": [] }.
- Output MUST be a raw JSON object and nothing else.`;

export interface GrokVideoOptions {
  apiKey: string;
  model?: string;
}

export interface VideoTranscriptResult {
  order: number;
  text: string;
}

export async function fetchVideoTranscripts(
  postUrl: string,
  options: GrokVideoOptions,
): Promise<VideoTranscriptResult[]> {
  const data = await callResponses({
    apiKey: options.apiKey,
    model: options.model ?? "grok-4.3",
    instructions: INSTRUCTIONS,
    input: `Watch the video(s) in this X post and transcribe them: ${postUrl}\n\nReturn ONLY the JSON object described in the instructions.`,
  });

  const text = extractText(data);
  if (!text) throw new Error("Grok returned no output_text for video transcripts");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    throw new Error(`Grok returned invalid JSON for video transcripts: ${text.slice(0, 300)}`);
  }

  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (!Array.isArray(obj.videos)) return [];
  return obj.videos
    .map((v) => {
      const vv = (v ?? {}) as Record<string, unknown>;
      const order = typeof vv.order === "number" ? vv.order : 0;
      const transcript = typeof vv.transcript === "string" ? vv.transcript.trim() : "";
      const description = typeof vv.description === "string" ? vv.description.trim() : "";
      const text = [description, transcript].filter(Boolean).join("\n\n");
      return { order, text };
    })
    .filter((v) => v.order > 0 && v.text.length > 0);
}
