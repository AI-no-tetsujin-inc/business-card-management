import { describe, expect, it } from "vitest";
import { openToken, sealToken } from "../worker/google-link";

describe("Google 連携の refresh_token の暗号化", () => {
  it("同じ鍵なら元に戻せる・毎回違う暗号文になる", async () => {
    const a = await sealToken("client-secret", "1//refresh-token");
    const b = await sealToken("client-secret", "1//refresh-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token");
    expect(await openToken("client-secret", a)).toBe("1//refresh-token");
  });
  it("鍵が違うと戻せない", async () => {
    const a = await sealToken("client-secret", "1//refresh-token");
    await expect(openToken("other-secret", a)).rejects.toThrow();
  });
});
