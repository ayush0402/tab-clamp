#!/usr/bin/env node
/* Builds dist/chrome and dist/firefox from src/.
 *
 * The only real difference is the background key: Chrome MV3 wants a service
 * worker, Firefox MV3 wants an event page, and each rejects the other's key.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const TARGETS = {
  chrome: (manifest) => ({
    ...manifest,
    background: { service_worker: 'background.js' },
    minimum_chrome_version: '116',
  }),
  firefox: (manifest) => ({
    ...manifest,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: { id: 'tab-clamp@ayushk', strict_min_version: '115.0' },
    },
  }),
};

/* ------------------------------------------------------------------ icons */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Two jaws closing on a dot — the clamp. */
function iconPixel(u, v) {
  const BG = [22, 36, 28, 255];
  const FG = [74, 222, 128, 255];
  const CLEAR = [0, 0, 0, 0];

  // Rounded-square mask.
  const r = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return CLEAR;

  const inBand = v > 0.24 && v < 0.76;
  const jaw = inBand && ((u > 0.17 && u < 0.3) || (u > 0.7 && u < 0.83));
  const dot = Math.hypot(u - 0.5, v - 0.5) < 0.11;
  return jaw || dot ? FG : BG;
}

/* -------------------------------------------------------------------- zip */

/* Both stores take a ZIP upload. Written by hand rather than shelling out to
 * `zip` so `npm run package` works the same on every OS with no dependencies.
 * Timestamps are pinned to the DOS epoch so builds are reproducible. */

const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(0, 30); // extra + comment lengths
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** Every file under `dir`, as store-relative posix paths. */
function walk(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(full, name));
    else files.push({ name, data: fs.readFileSync(full) });
  }
  return files;
}

/* ------------------------------------------------------------------ build */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'manifest.json') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

const base = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
fs.rmSync(DIST, { recursive: true, force: true });

for (const [target, shape] of Object.entries(TARGETS)) {
  const out = path.join(DIST, target);
  copyDir(SRC, out);

  const icons = path.join(out, 'icons');
  fs.mkdirSync(icons, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(icons, `icon-${size}.png`), png(size, iconPixel));
  }

  fs.writeFileSync(
    path.join(out, 'manifest.json'),
    JSON.stringify(shape(base), null, 2) + '\n',
  );
  console.log(`built ${path.relative(ROOT, out)}`);

  if (process.argv.includes('--package')) {
    const zipPath = path.join(DIST, `tab-clamp-${target}-${base.version}.zip`);
    fs.writeFileSync(zipPath, zip(walk(out)));
    console.log(`packaged ${path.relative(ROOT, zipPath)}`);
  }
}
