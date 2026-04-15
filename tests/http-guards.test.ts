import { describe, it, expect } from "vitest";
import { isSameOrigin } from "../lib/http-guards";

function mkReq(headers: Record<string, string>): {
  headers: { get: (name: string) => string | null };
} {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

describe("isSameOrigin", () => {
  it("accepts sec-fetch-site: same-origin", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSameOrigin(mkReq({ "sec-fetch-site": "same-origin" }) as any)).toBe(
      true,
    );
  });

  it("accepts sec-fetch-site: none (user-initiated)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSameOrigin(mkReq({ "sec-fetch-site": "none" }) as any)).toBe(true);
  });

  it("rejects sec-fetch-site: cross-site", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSameOrigin(mkReq({ "sec-fetch-site": "cross-site" }) as any)).toBe(
      false,
    );
  });

  it("rejects sec-fetch-site: same-site (different subdomain)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSameOrigin(mkReq({ "sec-fetch-site": "same-site" }) as any)).toBe(
      false,
    );
  });

  it("falls back to Origin/Host when sec-fetch-site missing", () => {
    expect(
      isSameOrigin(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkReq({
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
        }) as any,
      ),
    ).toBe(true);
  });

  it("rejects when Origin host differs from Host", () => {
    expect(
      isSameOrigin(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkReq({
          origin: "http://evil.example.com",
          host: "127.0.0.1:3000",
        }) as any,
      ),
    ).toBe(false);
  });

  it("accepts requests without Origin (curl, server-side)", () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isSameOrigin(mkReq({ host: "127.0.0.1:3000" }) as any),
    ).toBe(true);
  });

  it("rejects bogus Origin that fails to parse", () => {
    expect(
      isSameOrigin(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkReq({ origin: "not a url", host: "127.0.0.1:3000" }) as any,
      ),
    ).toBe(false);
  });
});
