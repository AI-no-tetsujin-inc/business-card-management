import exifr from "exifr";

/** 元の解像度を保つ保存用の上限（これより大きい写真だけ縮小） */
const FULL_MAX_EDGE = 4000;
/** 画面表示・OCR 用 */
const DISPLAY_MAX_EDGE = 2000;

export interface PreparedImage {
  full: Blob;
  display: Blob;
  /** 写真の撮影日（交換日の初期値に使う）YYYY-MM-DD */
  takenOn: string | null;
  previewUrl: string;
}

const isHeic = (file: File) => /hei[cf]$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (!isHeic(file)) throw new Error(`${file.name} は読み込めない画像形式です`);
  }
  // iPhone の HEIC をブラウザが直接読めない場合（Chrome など）は JPEG に変換する
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
  return createImageBitmap(Array.isArray(converted) ? converted[0] : converted, { imageOrientation: "from-image" });
}

/** canvas に描き直して JPEG にする。位置情報などの写真のメタデータはここで取り除かれる */
function render(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像の変換に失敗しました"))), "image/jpeg", quality),
  );
}

async function readTakenOn(file: File): Promise<string | null> {
  try {
    const exif = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate"] });
    const d: unknown = exif?.DateTimeOriginal ?? exif?.CreateDate;
    if (d instanceof Date && !isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  } catch {
    // 撮影日が読めなくても登録はできる
  }
  return null;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const [bitmap, takenOn] = await Promise.all([decode(file), readTakenOn(file)]);
  try {
    const full = await render(bitmap, FULL_MAX_EDGE, 0.92);
    const display = await render(bitmap, DISPLAY_MAX_EDGE, 0.85);
    return { full, display, takenOn, previewUrl: URL.createObjectURL(display) };
  } finally {
    bitmap.close();
  }
}
