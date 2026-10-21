import fs from "node:fs/promises";
import { deflateSync } from "node:zlib";

// Draw each target size from the exact Lucide Feather vector geometry
// (<svg viewBox="0 0 24 24" class="lucide lucide-feather">) with analytic
// distance antialiasing so both 256px and 16px icons stay crisp.
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const SQRT2 = Math.SQRT2;
const K = 4 * SQRT2; // 5.656854249
const H = 3 * SQRT2; // 4.242640687

const SEGMENTS = [
  // Outer contour straight segments
  [6, 19, 7 + K, 19],
  [7 + K + SQRT2, 17 + SQRT2, 16 + H, 8 + H],
  [16 - H, 8 - H, 7 - SQRT2, 17 - K - SQRT2],
  [5, 17 - K, 5, 18],
  // Shaft (M16 8 2 22)
  [16, 8, 2, 22],
  // Inner horizontal barb (M17.5 15H9)
  [9, 15, 17.5, 15],
];

const ARCS = [
  // Bottom-right corner (r = 2, 45° to 90°)
  { cx: 7 + K, cy: 17, r: 2, a0: Math.PI / 4, a1: Math.PI / 2 },
  // Top-right feather tip (r = 6, -135° to 45°)
  { cx: 16, cy: 8, r: 6, a0: (-3 * Math.PI) / 4, a1: Math.PI / 4 },
  // Top-left corner (r = 2, -180° to -135°)
  { cx: 7, cy: 17 - K, r: 2, a0: -Math.PI, a1: (-3 * Math.PI) / 4 },
  // Bottom-left corner (r = 1, 90° to 180°)
  { cx: 6, cy: 18, r: 1, a0: Math.PI / 2, a1: Math.PI },
];

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distToFeather(ux, uy, includeBarb) {
  let minDist = Infinity;
  const segCount = includeBarb ? SEGMENTS.length : SEGMENTS.length - 1;
  for (let i = 0; i < segCount; i++) {
    const [x1, y1, x2, y2] = SEGMENTS[i];
    const d = distToSegment(ux, uy, x1, y1, x2, y2);
    if (d < minDist) minDist = d;
  }
  for (const { cx, cy, r, a0, a1 } of ARCS) {
    const dx = ux - cx;
    const dy = uy - cy;
    const ang = Math.atan2(dy, dx);
    if (ang >= a0 && ang <= a1) {
      const d = Math.abs(Math.hypot(dx, dy) - r);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function render(n, round = false) {
  const rgba = Buffer.alloc(n * n * 4);
  const inset = n <= 24 ? 0.5 : n / 64;
  const radius = n * 0.2;

  // Map the 24x24 Lucide viewBox into the centered icon region
  const pad = n * 0.2;
  const span = n - pad * 2;
  const unitPerPx = 24 / span;
  // Lucide stroke-width is 2 in 24x24 units; enforce a minimum pixel stroke for 16-24px
  const strokeUnits = Math.max(2.0, (n <= 20 ? 1.35 : n <= 32 ? 1.5 : 1.0) * unitPerPx);
  const halfStroke = strokeUnits / 2;
  const aa = unitPerPx * 0.85;
  const includeBarb = n >= 20;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // Signed distance to rounded-rectangle tile
      const qx = Math.abs(px - n / 2) - (n / 2 - inset - radius);
      const qy = Math.abs(py - n / 2) - (n / 2 - inset - radius);
      const tileDist = round
        ? Math.hypot(px - n / 2, py - n / 2) - (n / 2 - inset)
        : Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
          Math.min(Math.max(qx, qy), 0) -
          radius;

      const tileAlpha = 1 - smoothstep(-0.6, 0.6, tileDist);
      if (tileAlpha <= 0) continue;

      // Dark gray gradient tile (top-left #6e6e6e -> bottom-right #484848)
      const tGrad = (px + py) / (n * 2);
      const bg = Math.round(112 - 38 * tGrad);

      // Distance to Lucide Feather in 24x24 space
      const ux = ((px - pad) / span) * 24;
      const uy = ((py - pad) / span) * 24;
      const fDist = distToFeather(ux, uy, includeBarb);
      const featherAlpha = 1 - smoothstep(halfStroke - aa, halfStroke + aa, fDist);

      // Pure white feather (#ffffff) on dark gray background
      const fg = 255;
      const lum = Math.round(bg * (1 - featherAlpha) + fg * featherAlpha);

      const idx = (y * n + x) * 4;
      rgba[idx] = lum;
      rgba[idx + 1] = lum;
      rgba[idx + 2] = lum;
      rgba[idx + 3] = Math.round(tileAlpha * 255);
    }
  }
  return rgba;
}

function crc(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type),
    len = Buffer.alloc(4),
    check = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  check.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, check]);
}

function png(n, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++)
    rgba.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function dib(n, rgba) {
  const header = Buffer.alloc(40),
    pixels = Buffer.alloc(n * n * 4),
    stride = Math.ceil(n / 32) * 4,
    mask = Buffer.alloc(stride * n);
  header.writeUInt32LE(40);
  header.writeInt32LE(n, 4);
  header.writeInt32LE(n * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length, 20);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const src = (y * n + x) * 4,
        dst = ((n - 1 - y) * n + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
      if (rgba[src + 3] === 0) mask[(n - 1 - y) * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  return Buffer.concat([header, pixels, mask]);
}

await fs.mkdir("assets", { recursive: true });
await fs.mkdir("src-tauri/icons", { recursive: true });

const images = [];
for (const n of sizes) {
  const rgba = render(n),
    data = png(n, rgba);
  await fs.writeFile(`assets/icon-${n}.png`, data);
  if (n === 256) {
    await fs.writeFile("assets/icon.png", data);
    await fs.writeFile("src-tauri/icons/icon.png", data);
    await fs.writeFile("src-tauri/icons/128x128@2x.png", data);
  }
  if (n === 128) {
    await fs.writeFile("src-tauri/icons/128x128.png", data);
  }
  if (n === 32) {
    await fs.writeFile("src-tauri/icons/32x32.png", data);
  }
  images.push(n === 256 ? data : dib(n, rgba));
}

const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
for (let i = 0; i < sizes.length; i++) {
  const p = 6 + i * 16;
  head[p] = head[p + 1] = sizes[i] % 256;
  head.writeUInt16LE(1, p + 4);
  head.writeUInt16LE(32, p + 6);
  head.writeUInt32LE(images[i].length, p + 8);
  head.writeUInt32LE(offset, p + 12);
  offset += images[i].length;
}
const icoBuf = Buffer.concat([head, ...images]);
await fs.writeFile("assets/icon.ico", icoBuf);
await fs.writeFile("src-tauri/icons/icon.ico", icoBuf);
console.log(`Generated Windows icons: ${sizes.join(", ")}px`);

// Android 7.x는 적응형 아이콘을 지원하지 않으므로 밀도별 PNG를 함께 둔다.
const androidSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, n] of Object.entries(androidSizes)) {
  const dir = `src-tauri/android/app/src/main/res/mipmap-${density}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/ic_launcher.png`, png(n, render(n)));
  await fs.writeFile(`${dir}/ic_launcher_round.png`, png(n, render(n, true)));
}
console.log(`Generated Android legacy icons: ${Object.values(androidSizes).join(", ")}px`);
