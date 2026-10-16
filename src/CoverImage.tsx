import { useEffect, useRef, useState } from "react";

// 큰 표지를 작은 칸에 그대로 넣으면 브라우저가 한 번에 크게 줄이면서 계단 현상이 생긴다.
// 표시 크기(× 화면 배율)에 맞춰 절반씩 단계적으로 줄인 썸네일을 만들어 보여 준다.
const cache = new Map<string, string>();
const images = new Map<string, Promise<HTMLImageElement>>();

function load(src: string) {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

async function thumbnail(src: string, width: number, height: number) {
  const key = `${width}x${height}|${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const img = await load(src);
  // object-fit: cover와 같은 영역을 잘라 낸다.
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  if (scale >= 1) return src;
  let sw = width / scale,
    sh = height / scale;
  const sx = (img.naturalWidth - sw) / 2,
    sy = (img.naturalHeight - sh) / 2;
  let canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  let ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  while (canvas.width / 2 > width && canvas.height / 2 > height) {
    const next = document.createElement("canvas");
    next.width = Math.round(canvas.width / 2);
    next.height = Math.round(canvas.height / 2);
    ctx = next.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, next.width, next.height);
    canvas = next;
  }
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);
  const url = out.toDataURL("image/png");
  cache.set(key, url);
  return url;
}

export default function CoverImage({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState(src);
  useEffect(() => {
    // 이미지 자신이 아니라 감싼 칸의 크기를 잰다. 이미지를 재면 썸네일 크기가 다시
    // 칸 크기를 바꾸는 순환이 생길 수 있다.
    const el = ref.current?.parentElement;
    if (!el) return;
    let alive = true;
    const update = () => {
      const ratio = window.devicePixelRatio || 1,
        width = Math.round(el.clientWidth * ratio),
        height = Math.round(el.clientHeight * ratio);
      if (!width || !height) return;
      const hit = cache.get(`${width}x${height}|${src}`);
      if (hit) return setShown(hit);
      thumbnail(src, width, height)
        .then((url) => alive && setShown(url))
        .catch(() => alive && setShown(src));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [src]);
  return <img ref={ref} src={shown} alt={alt} draggable={false} />;
}

// 표지를 원본 크기에 가깝게 띄운다. 바깥을 누르거나 Esc를 누르면 닫힌다.
export function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div className="image-viewer" role="dialog" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} />
    </div>
  );
}
