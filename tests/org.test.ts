// 組織図のルール: 部署欄の分け方・種類の見分け・役職の上下
import { describe, expect, it } from "vitest";
import { guessKind, rankOf, splitDepartment } from "../shared/org";

describe("組織図のルール", () => {
  it("部署欄を上から順のまとまりに分ける（「・」では分けない）", () => {
    expect(splitDepartment("営業本部 第一営業部　東日本課")).toEqual(["営業本部", "第一営業部", "東日本課"]);
    expect(splitDepartment("店舗事業部／新宿店")).toEqual(["店舗事業部", "新宿店"]);
    expect(splitDepartment("営業・企画部")).toEqual(["営業・企画部"]);
    expect(splitDepartment("")).toEqual([]);
  });
  it("名前から種類を見分ける", () => {
    expect(guessKind("新宿店")).toBe("store");
    expect(guessKind("関西支社")).toBe("branch");
    expect(guessKind("大阪営業所")).toBe("branch");
    expect(guessKind("営業本部")).toBe("hq");
    expect(guessKind("DX推進グループ")).toBe("team");
    expect(guessKind("第一営業部")).toBe("dept");
  });
  it("役職の上下（副・代理は本職より下）", () => {
    const order = ["代表取締役社長", "取締役", "本部長", "部長", "副部長", "課長", "課長代理", "主任", "担当"].map(rankOf);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rankOf("副社長")).toBeGreaterThan(rankOf("社長"));
    expect(rankOf("副店長")).toBeGreaterThan(rankOf("店長"));
    expect(rankOf("支店長")).toBeLessThan(rankOf("部長"));
  });
});
