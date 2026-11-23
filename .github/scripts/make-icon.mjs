// Builds assets/icon.ico (16–256 px) from assets/icon.svg for electron-builder.
import fs from 'node:fs';
import sharp from 'sharp';
const mod = await import('png-to-ico');
const pngToIco = mod.default || mod;

const svg = fs.readFileSync('assets/icon.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(s => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
fs.writeFileSync('assets/icon.ico', await pngToIco(pngs));
console.log('assets/icon.ico written:', sizes.join(', '), 'px');
