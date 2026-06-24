#!/usr/bin/env node
/**
 * build-icons.mjs — generate PWA app icons (a white snowflake on cool blue).
 * One-time / re-runnable. Outputs PNGs into /icons. Requires `sharp` (devDep).
 *   node scripts/build-icons.mjs
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

function snowflake(reach) {
  const cx = 256, cy = 256;
  const arm = (deg) => {
    const r = (deg * Math.PI) / 180;
    let p = `M${cx} ${cy} L${cx + Math.cos(r) * reach} ${cy + Math.sin(r) * reach}`;
    for (const t of [0.5, 0.74]) {
      const bx = cx + Math.cos(r) * reach * t;
      const by = cy + Math.sin(r) * reach * t;
      const bl = reach * 0.26;
      for (const da of [-60, 60]) {
        const r2 = ((deg + da) * Math.PI) / 180;
        p += ` M${bx} ${by} L${bx + Math.cos(r2) * bl} ${by + Math.sin(r2) * bl}`;
      }
    }
    return p;
  };
  return [0, 60, 120, 180, 240, 300].map(arm).join(' ');
}

const svg = ({ reach, radius }) => `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="${radius}" fill="#0284c7"/>
  <path d="${snowflake(reach)}" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
</svg>`;

const normal = svg({ reach: 170, radius: 112 }); // rounded — "any"
const apple = svg({ reach: 170, radius: 0 }); // square — iOS rounds it
const maskable = svg({ reach: 120, radius: 0 }); // extra padding for safe zone

async function png(svgStr, size, name) {
  await sharp(Buffer.from(svgStr)).resize(size, size).png().toFile(join(OUT, name));
  console.log('  ✓', name);
}

await mkdir(OUT, { recursive: true });
await png(normal, 192, 'icon-192.png');
await png(normal, 512, 'icon-512.png');
await png(maskable, 512, 'icon-maskable-512.png');
await png(apple, 180, 'apple-touch-icon.png');
await writeFile(join(OUT, 'icon.svg'), normal); // crisp favicon
console.log('done.');
