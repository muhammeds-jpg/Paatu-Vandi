#!/usr/bin/env node
/**
 * Builds every app icon from the real artwork.
 *
 *   npm run gen:icons
 *
 * The icon is a square crop of the backdrop illustration with the gold logo
 * centred on it, so a tab, a home-screen shortcut and a shared link all carry
 * the same picture the site opens with. It replaces a hand-drawn green disc that
 * had nothing to do with the brand.
 *
 * Two variants per size, because they are cropped differently by the platform:
 *
 *  - "any"      — shown as-is. The logo can run close to the edges.
 *  - "maskable" — Android clips it to a circle or squircle and keeps only the
 *                 central ~80%. The illustration is happy to bleed off, but the
 *                 logo has to sit inside that safe zone or its ends get sliced.
 *
 * Uses sharp, which ships with Next, so there is nothing extra to install.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const FAVICON_SRC = join(PUBLIC, "Favicon.png");
const LOGO = join(PUBLIC, "pattu-vandi-logo.svg");

/**
 * Creates a dark ambient background matching the site theme (#0b0908).
 */
function darkBackground(width, height) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <defs>
         <radialGradient id="bg" cx="50%" cy="50%" r="75%">
           <stop offset="0%"   stop-color="#181310"/>
           <stop offset="60%"  stop-color="#0e0b09"/>
           <stop offset="100%" stop-color="#080706"/>
         </radialGradient>
       </defs>
       <rect width="${width}" height="${height}" fill="url(#bg)"/>
     </svg>`,
  );
}

/**
 * Composites the green music van favicon image onto a dark rounded background for app icons.
 */
async function composeIcon({ size, iconRatio = 0.75 }) {
  const bg = darkBackground(size, size);
  const targetWidth = Math.round(size * iconRatio);
  
  const iconBuffer = await sharp(FAVICON_SRC)
    .resize({ width: targetWidth, height: targetWidth, fit: "contain" })
    .png()
    .toBuffer();

  return sharp(bg)
    .composite([
      { input: iconBuffer, gravity: "center" },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const TARGETS = [
  // Shown as-is; full app icon sizes
  { file: "icon-192.png", size: 192, iconRatio: 0.78 },
  { file: "icon-512.png", size: 512, iconRatio: 0.78 },
  // Clipped to a circle/squircle: icon stays inside the central 68% safe zone.
  { file: "icon-192-maskable.png", size: 192, iconRatio: 0.65 },
  { file: "icon-512-maskable.png", size: 512, iconRatio: 0.65 },
  // iOS touch icon
  { file: "apple-touch-icon.png", size: 180, iconRatio: 0.75 },
];

for (const target of TARGETS) {
  const png = await composeIcon(target);
  writeFileSync(join(PUBLIC, target.file), png);
  console.log(`  ${target.file.padEnd(26)} ${target.size}px  ${Math.round(png.length / 1024)}KB`);
}

/** Favicon for browser tabs (src/app/icon.png) */
const favicon = await composeIcon({ size: 96, iconRatio: 0.85 });
writeFileSync(join(ROOT, "src", "app", "icon.png"), favicon);
console.log(`  src/app/icon.png           96px  ${Math.round(favicon.length / 1024)}KB`);

/** Also update public/Favicon.png so it stays consistent */
writeFileSync(join(PUBLIC, "Favicon.png"), await sharp(FAVICON_SRC).png().toBuffer());

/**
 * The social share card (1200x630 opengraph-image.jpg) for WhatsApp / Twitter / FB.
 * Combines the green music van favicon image and the gold logo on a dark ambient background.
 */
async function socialCard() {
  const width = 1200;
  const height = 630;

  const bg = darkBackground(width, height);

  // Resize green music van favicon icon
  const vanIcon = await sharp(FAVICON_SRC)
    .resize({ width: 220, fit: "inside" })
    .png()
    .toBuffer();

  // Resize gold logo
  const logo = await sharp(LOGO, { density: 600 })
    .resize({ width: 680, fit: "inside" })
    .png()
    .toBuffer();

  return (
    sharp(bg)
      .composite([
        { input: vanIcon, top: 120, left: Math.round((width - 220) / 2) },
        { input: logo, top: 340, left: Math.round((width - 680) / 2) },
      ])
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer()
  );
}

const card = await socialCard();
writeFileSync(join(ROOT, "src", "app", "opengraph-image.jpg"), card);
console.log(
  `  src/app/opengraph-image.jpg 1200x630  ${Math.round(card.length / 1024)}KB`,
);

console.log(`
Done. Generated app icons and opengraph-image.jpg using the green music van favicon image.`);
