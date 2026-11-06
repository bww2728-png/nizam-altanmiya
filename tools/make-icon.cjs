/*
 * Builds every brand asset from the supplied artwork (assets/brand-source.jpg):
 *   - build/icon.png    1024px application icon
 *   - build/icon.ico    16..256px icon used by the installer, shortcuts and the taskbar
 *   - tools/icons/*     reference PNG set
 *   - assets/logo-badge-1024.png + src/renderer/assets/logo-badge.png
 *   - src/renderer/assets/brand-banner.png (inner panel crop, no outer frame)
 *
 * The artwork is a wide card; the square badge is produced by cropping the circular
 * emblem out of it and placing that circle on a navy plate with a gold ring, so the
 * icon stays legible from 256px down to 16px and never shows the artwork's frame.
 */
const fs = require('node:fs');
const path = require('node:path');

const NM = path.join(__dirname, '..', 'desktop-app', 'node_modules');
const { createCanvas, loadImage } = require(path.join(NM, '@napi-rs', 'canvas'));

const SOURCE = path.join(__dirname, '..', 'assets', 'brand-source.jpg');

// Circle of the eagle emblem inside the source artwork, in source pixels (1024x559).
const EMBLEM = { cx: 521, cy: 182, r: 132 };

// Inner panel of the source artwork (inside the decorative frame), 960x487.
const PANEL = { x: 32, y: 28, width: 960, height: 487 };

const PLATE_TOP = '#173651';
const PLATE_BOTTOM = '#0a1b2c';
const RING = '#d9b45a';

function drawBadge(source, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const plate = ctx.createLinearGradient(0, 0, 0, size);
  plate.addColorStop(0, PLATE_TOP);
  plate.addColorStop(1, PLATE_BOTTOM);
  ctx.fillStyle = plate;
  ctx.fillRect(0, 0, size, size);

  const inset = size * 0.06;
  const diameter = size - inset * 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, diameter / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    source,
    EMBLEM.cx - EMBLEM.r,
    EMBLEM.cy - EMBLEM.r,
    EMBLEM.r * 2,
    EMBLEM.r * 2,
    inset,
    inset,
    diameter,
    diameter
  );
  ctx.restore();

  const lineWidth = Math.max(1, size * 0.03);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = RING;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, diameter / 2 + lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  return canvas;
}

function downscale(canvas, size) {
  const target = createCanvas(size, size);
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, size, size);
  return target.toBuffer('image/png');
}

function buildIco(pngBySize) {
  const sizes = Object.keys(pngBySize)
    .map(Number)
    .sort((a, b) => b - a);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * sizes.length;
  for (const size of sizes) {
    const png = pngBySize[size];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
    blobs.push(png);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

async function main() {
  const root = path.join(__dirname, '..', 'desktop-app');
  const buildDir = path.join(root, 'build');
  const iconsDir = path.join(__dirname, 'icons');
  const rendererAssets = path.join(root, 'src', 'renderer', 'assets');
  const assetsDir = path.join(__dirname, '..', 'assets');
  for (const dir of [buildDir, iconsDir, rendererAssets, assetsDir]) fs.mkdirSync(dir, { recursive: true });

  const source = await loadImage(SOURCE);
  const master = drawBadge(source, 1024);
  const sizes = [1024, 512, 256, 128, 64, 48, 32, 16];
  const pngs = {};

  for (const size of sizes) {
    const buffer = size === 1024 ? master.toBuffer('image/png') : downscale(master, size);
    pngs[size] = buffer;
    fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), buffer);
  }

  fs.writeFileSync(path.join(buildDir, 'icon.png'), pngs[1024]);
  // ICO entries are limited to 256px: the width/height field is one byte, where 0 means 256,
  // so larger images cannot be described and would be misread by Windows/NSIS tools.
  const icoSizes = [256, 128, 64, 48, 32, 16];
  fs.writeFileSync(
    path.join(buildDir, 'icon.ico'),
    buildIco(Object.fromEntries(icoSizes.map((size) => [size, pngs[size]])))
  );

  fs.writeFileSync(path.join(assetsDir, 'logo-badge-1024.png'), pngs[1024]);
  fs.writeFileSync(path.join(rendererAssets, 'logo-badge.png'), pngs[256]);

  const banner = createCanvas(PANEL.width, PANEL.height);
  banner
    .getContext('2d')
    .drawImage(source, PANEL.x, PANEL.y, PANEL.width, PANEL.height, 0, 0, PANEL.width, PANEL.height);
  // The banner is photographic, so JPEG keeps it around 200 KB instead of ~1 MB as PNG.
  const bannerBuffer = banner.toBuffer('image/jpeg', 88);
  fs.writeFileSync(path.join(rendererAssets, 'brand-banner.jpg'), bannerBuffer);
  fs.writeFileSync(path.join(assetsDir, 'brand-banner.jpg'), bannerBuffer);

  console.log(
    JSON.stringify(
      {
        source: SOURCE,
        icon: path.join(buildDir, 'icon.png'),
        ico: path.join(buildDir, 'icon.ico'),
        icoSizes,
        rendererAssets: fs.readdirSync(rendererAssets),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
