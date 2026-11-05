import { describe, expect, it } from "vitest";
import { companyKey, emailKey, emptyFields, personKey, phoneKey, ruleWarnings } from "../shared/fields";

describe("会社名の正規化（表記ゆれを同じ会社にまとめる）", () => {
  it("株式会社 / ㈱ / (株) / 全角・半角の違いを吸収する", () => {
    const k = companyKey("株式会社サンプル商事");
    expect(companyKey("㈱サンプル商事")).toBe(k);
    expect(companyKey("サンプル商事株式会社")).toBe(k);
    expect(companyKey("（株）サンプル商事")).toBe(k);
    expect(companyKey(" サンプル商事 ")).toBe(k);
  });
  it("英語表記の Inc. / Co., Ltd. を外す", () => {
    expect(companyKey("Example Inc.")).toBe("example");
    expect(companyKey("Example Co., Ltd.")).toBe("example");
  });
  it("社名の一部を誤って削らない", () => {
    expect(companyKey("Costco")).toBe("costco");
  });
});

describe("統合ルール用のキー", () => {
  it("メールは大文字小文字・全角を無視", () => {
    expect(emailKey("TARO.Sample@Example.com")).toBe("taro.sample@example.com");
    expect(emailKey("ｔａｒｏ@sample.co.jp")).toBe("taro@sample.co.jp");
  });
  it("電話はハイフン・空白・+81 の違いを無視", () => {
    expect(phoneKey("03-1234-5678")).toBe("0312345678");
    expect(phoneKey("+81 3-1234-5678")).toBe("0312345678");
    expect(phoneKey("(03) 1234 5678")).toBe("0312345678");
    expect(phoneKey("03-1234-5678 内線 123")).toBe("0312345678");
  });
  it("短すぎる番号は統合に使わない", () => {
    expect(phoneKey("1234")).toBe("");
  });
  it("氏名は空白の有無を無視", () => {
    expect(personKey("丙野 太郎")).toBe(personKey("丙野　太郎"));
    expect(personKey("丙野太郎")).toBe(personKey("丙野 太郎"));
  });
});

describe("形式チェック（要確認の黄色表示）", () => {
  const base = { ...emptyFields(), company_name: "サンプル商事", person_name: "丙野 太郎" };
  it("正しい値なら警告なし", () => {
    expect(ruleWarnings({ ...base, email: "a@b.co.jp", phone: "03-1234-5678", mobile: "090-1234-5678", postal_code: "123-4567", url: "https://example.com" })).toEqual({});
  });
  it("メール・電話・郵便番号・URL の誤りを検出", () => {
    const w = ruleWarnings({ ...base, email: "a@b", phone: "03-1234-567", postal_code: "12-345", url: "not a url" });
    expect(Object.keys(w).sort()).toEqual(["email", "phone", "postal_code", "url"]);
  });
  it("携帯欄に固定電話が入っていたら警告", () => {
    expect(ruleWarnings({ ...base, mobile: "03-1234-5678" }).mobile).toBeTruthy();
  });
  it("会社名・氏名が空なら警告", () => {
    const w = ruleWarnings(emptyFields());
    expect(w.company_name).toBeTruthy();
    expect(w.person_name).toBeTruthy();
  });
});
