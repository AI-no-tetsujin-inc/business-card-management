import { useState } from "react";
import { imageUrl } from "../api";

/** 縮小版を表示し、タップで元の解像度の画像を拡大表示する */
export function CardImage({ displayKey, fullKey, alt, className }: { displayKey: string; fullKey?: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img className={className ?? "card-image"} src={imageUrl(displayKey)} alt={alt} loading="lazy" onClick={() => setOpen(true)} />
      {open && (
        <div className="lightbox" role="dialog" aria-label={alt} onClick={() => setOpen(false)}>
          <img src={imageUrl(fullKey ?? displayKey)} alt={alt} />
          <span className="lightbox-close">閉じる ×</span>
        </div>
      )}
    </>
  );
}

export function Thumb({ imageKey, alt }: { imageKey: string | null; alt: string }) {
  return imageKey ? <img className="thumb" src={imageUrl(imageKey)} alt={alt} loading="lazy" /> : <div className="thumb thumb-empty" />;
}
