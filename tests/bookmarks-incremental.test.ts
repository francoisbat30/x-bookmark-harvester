import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAllBookmarks } from "../lib/x/bookmarks";

function page(ids: string[], nextToken?: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      data: ids.map((id) => ({
        id,
        text: `t${id}`,
        created_at: "2026-07-01T00:00:00.000Z",
        author_id: "A",
      })),
      includes: { users: [{ id: "A", username: "a", name: "A" }] },
      meta: nextToken ? { result_count: ids.length, next_token: nextToken } : { result_count: ids.length },
    }),
    text: async () => "",
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = { id: "A", username: "a", name: "A" };

describe("fetchAllBookmarks — listing incrémental", () => {
  it("s'arrête dès qu'une page entière est déjà connue", async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(page(["3", "2"], "tok1"))
      .mockResolvedValueOnce(page(["1", "0"], "tok2"))
      .mockResolvedValueOnce(page(["z"]));
    vi.stubGlobal("fetch", impl);

    const known = new Set(["1", "0", "z"]);
    const out = await fetchAllBookmarks({
      accessToken: "T",
      me: ME,
      isKnown: async (id) => known.has(id),
    });

    // page 1 (3,2 inconnus) + page 2 (1,0 connus → stop) ; page 3 jamais lue
    expect(impl).toHaveBeenCalledTimes(2);
    expect(out.map((b) => b.id)).toEqual(["3", "2", "1", "0"]);
  });

  it("liste tout quand isKnown est omis", async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(page(["3", "2"], "tok1"))
      .mockResolvedValueOnce(page(["1", "0"]));
    vi.stubGlobal("fetch", impl);

    const out = await fetchAllBookmarks({ accessToken: "T", me: ME });
    expect(impl).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(4);
  });

  it("ne s'arrête pas si un seul bookmark de la page est nouveau", async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(page(["5", "4"], "tok1"))
      .mockResolvedValueOnce(page(["3"]));
    vi.stubGlobal("fetch", impl);

    const known = new Set(["4"]);
    const out = await fetchAllBookmarks({
      accessToken: "T",
      me: ME,
      isKnown: async (id) => known.has(id),
    });
    expect(impl).toHaveBeenCalledTimes(2);
    expect(out.map((b) => b.id)).toEqual(["5", "4", "3"]);
  });
});
