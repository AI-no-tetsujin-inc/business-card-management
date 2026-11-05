#!/usr/bin/env python3
"""読み取った領収書の内容から、アプリに入れる ZIP（番号つきの写真＋CSV）を作る。標準ライブラリだけで動く。

使い方:
    python3 package.py rows.json 出力フォルダ

rows.json は読み取った順（写真のファイル名順）のリスト。1枚の写真に領収書が複数あれば、同じ src で行を分ける。
    [{"src": "/path/IMG_1234.HEIC", "date": "2026-10-05", "amount": 1200,
      "vendor": "日本交通", "purpose": "交通費（タクシー）", "note": ""}, ...]
src が null の行は「写真なし」として CSV にだけ載せる。

出力: 出力フォルダ/立替経費_YYYYMMDD.zip
    立替経費_YYYYMMDD.csv … 番号,ファイル名,日付,金額,支払先,用途,元のファイル名,メモ（BOM つき UTF-8・CRLF）
    R001_2026-10-05_1200.heic … 写真のコピー（元の写真は変えない）
"""
import csv
import datetime
import io
import json
import os
import re
import sys
import zipfile

HEADER = ["番号", "ファイル名", "日付", "金額", "支払先", "用途", "元のファイル名", "メモ"]


def main(rows_path: str, out_dir: str) -> None:
    rows = json.load(open(rows_path, encoding="utf-8"))
    stamp = f"{datetime.date.today():%Y%m%d}"
    names: dict[str, str] = {}  # 元のパス → 番号つきのファイル名
    counts: dict[str, int] = {}  # 元のパス → その写真の何件目か
    table = []
    seq = 0
    for r in rows:
        src = r.get("src")
        amount = re.sub(r"[^\d]", "", str(r.get("amount", "")))
        date = str(r.get("date", "")).strip()
        if src and src not in names:
            seq += 1
            ext = os.path.splitext(src)[1].lower() or ".jpg"
            names[src] = f"R{seq:03d}_{date or 'nodate'}_{amount or '0'}{ext}"
        if src:
            counts[src] = counts.get(src, 0) + 1
            no = f"R{list(names).index(src) + 1:03d}"
            # 1枚に複数の領収書が写っている写真は、2件目から枝番をつける（ファイルは同じ）
            if counts[src] > 1:
                no += f"-{counts[src]}"
        else:
            no = ""
        table.append([no, names.get(src, ""), date, amount, r.get("vendor", ""), r.get("purpose", ""), os.path.basename(src) if src else "", r.get("note", "")])

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(HEADER)
    w.writerows(table)

    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"立替経費_{stamp}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
        z.writestr(f"立替経費_{stamp}.csv", buf.getvalue().encode("utf-8-sig"))
        for src, name in names.items():
            z.write(src, name)
    total = sum(int(t[3] or 0) for t in table)
    print(f"{zip_path}\n明細 {len(table)} 件 ・ 写真 {len(names)} 枚 ・ 合計 {total:,} 円")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
