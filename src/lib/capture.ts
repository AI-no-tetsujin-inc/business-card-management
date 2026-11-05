// スマホの「撮影」ボタン（どの画面からでも押せる）で撮った写真を、登録画面に渡すための置き場
let pending: File | null = null;

export const setCapturedFront = (file: File) => {
  pending = file;
};

/** 一度だけ取り出す */
export const takeCapturedFront = () => {
  const f = pending;
  pending = null;
  return f;
};

/** 読み取りの進み具合（実際の段階＋読み取り中は経過時間からの目安。100% は完了したときだけ） */
export function readingProgress(elapsedMs: number) {
  // 読み取りはおおむね 10〜30 秒。30% から 95% まで、時間とともにゆっくり近づける
  return 30 + 65 * (1 - Math.exp(-elapsedMs / 9000));
}
