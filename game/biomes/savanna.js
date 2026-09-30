// Savanna biome pack: all the art for East African grassland, bush and riverine woodland.
// A biome pack only decides how things look. What goes where comes from the pipeline's data.
// To make another pack, copy this file and keep the same exports (tile keys from legend.json,
// animal sprite keys from species.json).
import { animalFrames, blob, makeCanvas, mulberry32, px, shade } from '../sprites.js';

export const name = 'savanna';
export const TILE = 16;

// ---- ground tiles --------------------------------------------------------------------------
// paint(g, rnd) fills one 16×16 variant. The engine makes 4 variants of each.
function speckle(g, rnd, base, dots) {
  g.fillStyle = base; g.fillRect(0, 0, TILE, TILE);
  for (const [col, n, w = 1, h = 1] of dots)
    for (let i = 0; i < n; i++) px(g, rnd() * TILE, rnd() * TILE, col, w, h);
}

const GROUND = ['#bdb55e', '#aca452', '#cfc676', '#9e9748'];
function ground(g, r, f = 1) {
  const c = f === 1 ? GROUND : GROUND.map(x => shade(x, f));
  speckle(g, r, c[0], [[c[1], 18, 1, 2], [c[2], 14], [c[3], 6, 1, 2]]);
}

export const tiles = {
  // Grassland, bush and woodland share one ground so the 10 m classification doesn't show as a
  // patchwork of squares. The bushes and trees drawn by decor() tell them apart.
  grass:    { map: '#c2bb62', paint: (g, r) => ground(g, r) },
  thorn:    { map: '#a9a452', paint: (g, r) => ground(g, r) },
  bush:     { map: '#7c8040', paint: (g, r) => ground(g, r) },
  woodland: { map: '#58703a', paint: (g, r) => ground(g, r) },
  riverine: { map: '#3f6232', paint: (g, r) => ground(g, r) },
  swamp:    { map: '#6f8c68', paint: (g, r) => { speckle(g, r, '#7a9164', [['#5f7f82', 16, 2, 1], ['#8fa670', 14, 1, 2]]); for (let i = 0; i < 5; i++) px(g, r() * 15, r() * 12, '#4f6a3a', 1, 3 + r() * 2); } },
  water:    { map: '#4a78a8', paint: (g, r) => speckle(g, r, '#4f7fae', [['#6f9cc8', 7, 3, 1], ['#3f6c9a', 8, 2, 1]]) },
  river:    { map: '#3f6a9c', paint: (g, r) => speckle(g, r, '#46729f', [['#6590bd', 6, 3, 1], ['#375f8c', 10, 2, 1]]) },
  stream:   { map: '#a8916a', paint: (g, r) => speckle(g, r, '#b9a47a', [['#9f8a62', 14], ['#cdb98f', 10], ['#8c7a58', 5, 2, 1]]) },
  ford:     { map: '#a99f7c', paint: (g, r) => speckle(g, r, '#aea483', [['#7f9ab0', 8, 3, 1], ['#c6b995', 10]]) },
  road:     { map: '#b8683c', paint: (g, r) => speckle(g, r, '#b8764a', [['#a4663c', 26], ['#cb8c5e', 16], ['#8f5634', 6]]) },
  track:    { map: '#eadcbc', paint: (g, r) => speckle(g, r, '#d5bf8e', [['#c5ad7c', 22], ['#e4d2a6', 16], ['#b39a6a', 5]]) },
  path:     { map: '#e2d4b0', paint: (g, r) => speckle(g, r, '#c9bc8a', [['#b8ac7a', 16], ['#d8cc9c', 12]]) },
  bare:     { map: '#d9c7a0', paint: (g, r) => speckle(g, r, '#d4c197', [['#c3b087', 18], ['#e2d2ad', 12]]) },
  farmland: { map: '#aaa860', paint: (g, r) => { for (let y = 0; y < TILE; y++) px(g, 0, y, (y >> 1) % 2 ? '#a4a05a' : '#8f8b48', TILE, 1); } },
  built:    { map: '#8a7a70', paint: (g, r) => { speckle(g, r, '#9a8f86', [['#877c74', 10]]); px(g, 2, 2, '#b06a48', 12, 10); px(g, 2, 7, '#8f5238', 12, 1); } },
};

export const outsideTint = 'rgba(46, 34, 22, 0.42)';
export const dust = ['#d8c49a', '#cbb488', '#e6d6b2'];

// ---- scenery -----------------------------------------------------------------------------
function paintCanopy(g, cx, cy, r, rnd, dark, mid, light) {
  // flat-topped acacia crown seen from above, with its shadow falling down-right
  g.save(); g.globalAlpha = 0.28;
  blob(g, cx + 3, cy + 3, r, '#1e2410', rnd, 0.2);
  g.restore();
  blob(g, cx, cy, r, dark, rnd, 0.3);
  blob(g, cx - 1, cy - 1, r - 2, mid, rnd, 0.45);
  for (let i = 0; i < r * 1.5; i++) px(g, cx - r / 2 + rnd() * r - 1, cy - r / 2 + rnd() * r - 1, light);
}

function paintThorn(g, cx, cy, r, rnd) {
  blob(g, cx + 1, cy + 1, r, 'rgba(30,34,14,0.35)', rnd, 0.2);
  blob(g, cx, cy, r, '#5c6130', rnd, 0.5);
  blob(g, cx - 1, cy - 1, r - 1, '#737840', rnd, 0.6);
  // swollen-thorn galls: the pale spines and dark ant holes of whistling thorn
  for (let i = 0; i < r; i++) px(g, cx - r + rnd() * 2 * r, cy - r + rnd() * 2 * r, rnd() < 0.6 ? '#e9e1c8' : '#2b2418');
}

// Each bush and canopy shape is painted once (6 variants per size and colour) and then stamped,
// which keeps drawing a new chunk fast.
const stamps = new Map();
function stamp(g, cx, cy, r, rnd, paint, ...cols) {
  const v = (rnd() * 6) | 0;
  const k = paint.name + r + cols.join() + v;
  let s = stamps.get(k);
  if (!s) {
    const size = 2 * r + 8;
    const [c, sg] = makeCanvas(size, size);
    paint(sg, r + 3, r + 3, r, mulberry32(r * 131 + v * 7919 + cols.join().length), ...cols);
    stamps.set(k, s = c);
  }
  g.drawImage(s, cx - r - 3, cy - r - 3);
}
const canopy = (g, cx, cy, r, rnd, ...cols) => stamp(g, cx, cy, r, rnd, paintCanopy, ...cols);
const thornBush = (g, cx, cy, r, rnd) => stamp(g, cx, cy, r, rnd, paintThorn);

// Draw the scenery that belongs to one tile, at pixel (x, y) = the tile's top-left corner.
// rnd is seeded from the tile, so it's the same every time.
export function decor(key, g, x, y, rnd) {
  const c = (n) => x + 2 + rnd() * (TILE - 4) | 0;
  const d = (n) => y + 2 + rnd() * (TILE - 4) | 0;
  switch (key) {
    case 'grass':
      if (rnd() < 0.10) px(g, c(), d(), '#8f8a3e', 1, 2);
      if (rnd() < 0.004) { const mx = c(), my = d(); px(g, mx - 1, my, '#8a5a36', 3, 3); px(g, mx, my - 2, '#9c6a42', 1, 3); } // termite mound
      break;
    case 'thorn':
      if (rnd() < 0.55) thornBush(g, c(), d(), 2 + (rnd() * 2 | 0), rnd);
      break;
    case 'bush':
      for (let i = 0, n = 2 + (rnd() * 2 | 0); i < n; i++) thornBush(g, c(), d(), 3 + (rnd() * 3 | 0), rnd);
      break;
    case 'woodland':
      if (rnd() < 0.7) canopy(g, c(), d(), 6 + (rnd() * 4 | 0), rnd, '#4b5a26', '#61722f', '#7d8c3e');
      break;
    case 'riverine':
      if (rnd() < 0.85) {
        const fever = rnd() < 0.45; // yellow fever trees along the water
        canopy(g, c(), d(), 7 + (rnd() * 4 | 0), rnd, fever ? '#6e7d2a' : '#3e5424', fever ? '#8f9d38' : '#50682c', fever ? '#b4bd52' : '#6c8438');
      }
      break;
    case 'swamp':
      for (let i = 0; i < 3; i++) if (rnd() < 0.5) px(g, c(), d(), '#4a6a34', 1, 3);
      break;
  }
}

export function loneTree(g, cx, cy, rnd) {
  canopy(g, cx, cy, 8 + (rnd() * 4 | 0), rnd, '#4e5e28', '#667832', '#869640');
}

// Boundary fence along one side of an inside tile ('n','s','e','w').
export function fence(g, x, y, side) {
  const T = TILE;
  const [x0, y0, x1, y1] = { n: [x, y, x + T, y], s: [x, y + T - 1, x + T, y + T - 1],
                             w: [x, y, x, y + T], e: [x + T - 1, y, x + T - 1, y + T] }[side];
  g.fillStyle = '#6a6258';
  if (y0 === y1) g.fillRect(x0, y0, T, 1); else g.fillRect(x0, y0, 1, T);
  g.fillStyle = '#3c3228';
  for (let i = 0; i < T; i += 8) (y0 === y1) ? g.fillRect(x0 + i, y0 - 1, 2, 3) : g.fillRect(x0 - 1, y0 + i, 3, 2);
}

// ---- the vehicle: an open-roof safari Land Cruiser from above, facing up --------------------
export function vehicle() {
  const rows = [
    '..kkkkkkkk..',
    '.kllbbbbllk.',
    'tkbbbbbbbbkt',
    'tkbbbbbbbbkt',
    '.kbbbbbbbbk.',
    '.kwwwwwwwwk.',
    '.krrrrrrrrk.',
    '.krsrsrsrrk.',
    '.krrrrrrrrk.',
    '.kbrsrsrsbk.',
    '.kbrrrrrrbk.',
    '.krrrrrrrrk.',
    '.krsrsrsrrk.',
    '.krrrrrrrrk.',
    'tkrrrrrrrrkt',
    'tkrrrrrrrrkt',
    '.kbbbbbbbbk.',
    '.kbbbppbbbk.',
    '..kkkppkkk..',
  ];
  const pal = { k: '#1f2016', b: '#5d6a38', l: '#f3eecb', t: '#18150f', w: '#2d3d48', r: '#e3d8b8', s: '#b9ab86', p: '#2a261e' };
  const [c, g] = makeCanvas(rows[0].length, rows.length);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) px(g, x, y, pal[ch]); }));
  return c;
}

// ---- animals -----------------------------------------------------------------------------
// Side-view sprite parameters for animalFrames(), plus behaviour: walk speed (tiles/s) and
// flee (0 = ignores the car, 1 = bolts as soon as it comes near).
const A = {
  elephant:   { walk: 0.5, flee: 0.2, p: { len: 18, h: 9, leg: 5, legW: 2, legs: 4, neck: { len: 0, up: 0, w: 4 }, head: { w: 5, h: 6 }, trunk: 6, bigEar: true, tail: 3, col: { body: '#7f7872', dark: '#4a4440', leg: '#736c66', horn: '#efe8d8' } } },
  giraffe:    { walk: 0.5, flee: 0.6, p: { len: 10, h: 5, leg: 10, legs: 4, neck: { len: 13, up: 66, w: 2 }, head: { w: 3, h: 2 }, snout: 1, horns: { len: 2 }, ears: 1, tail: 4, pattern: 'patches', col: { body: '#a8662c', pattern: '#ecd8ae', dark: '#3a2614', leg: '#e2cc9c' } } },
  zebra:      { walk: 0.5, flee: 0.8, p: { len: 9, h: 5, leg: 5, legs: 4, neck: { len: 3, up: 45, w: 2 }, head: { w: 3, h: 2 }, snout: 1, ears: 1, mane: true, tail: 3, pattern: 'stripes', col: { body: '#f0eee4', pattern: '#1f1c1a', dark: '#1f1c1a', leg: '#d9d6ca' } } },
  grevy:      { walk: 0.5, flee: 0.8, p: { len: 10, h: 6, leg: 6, legs: 4, neck: { len: 3, up: 45, w: 2 }, head: { w: 4, h: 2 }, snout: 1, ears: 2, mane: true, tail: 3, pattern: 'stripes', col: { body: '#f3f1e8', belly: '#fbfaf4', pattern: '#2a2522', dark: '#2a2522', leg: '#e2dfd4' } } },
  buffalo:    { walk: 0.4, flee: 0.3, p: { len: 11, h: 6, leg: 4, legs: 4, neck: { len: 1, up: 10, w: 3 }, head: { w: 4, h: 4 }, horns: { len: 2, back: true }, hump: 1, tail: 3, col: { body: '#3c3733', dark: '#1e1a18', leg: '#34302c', horn: '#6a6258' } } },
  hartebeest: { walk: 0.6, flee: 0.9, p: { len: 9, h: 5, leg: 5, legs: 4, neck: { len: 3, up: 55, w: 2 }, head: { w: 2, h: 4 }, snout: 1, horns: { len: 2 }, hump: 1, tail: 2, col: { body: '#ad6f3e', belly: '#c89a6c', dark: '#4a2e1a', leg: '#9c643a' } } },
  gazelle:    { walk: 0.6, flee: 0.9, p: { len: 7, h: 3, leg: 4, legs: 4, neck: { len: 3, up: 55, w: 1 }, head: { w: 2, h: 2 }, snout: 1, horns: { len: 3, back: true }, tail: 2, col: { body: '#c48c50', belly: '#f2e8d4', dark: '#2e2016', leg: '#d6b288' } } },
  impala:     { walk: 0.6, flee: 0.9, p: { len: 8, h: 4, leg: 5, legs: 4, neck: { len: 3, up: 55, w: 2 }, head: { w: 2, h: 2 }, snout: 1, horns: { len: 3, back: true }, ears: 1, tail: 2, col: { body: '#b8733c', belly: '#efe0c8', dark: '#2e1e12', leg: '#c89a6a' } } },
  eland:      { walk: 0.5, flee: 0.6, p: { len: 12, h: 7, leg: 5, legs: 4, neck: { len: 2, up: 30, w: 3 }, head: { w: 3, h: 3 }, snout: 1, horns: { len: 3, back: true }, hump: 1, tail: 3, col: { body: '#bb9c6e', belly: '#d8c4a0', dark: '#4e3c28', leg: '#a88a5e' } } },
  waterbuck:  { walk: 0.4, flee: 0.6, p: { len: 10, h: 6, leg: 5, legs: 4, neck: { len: 3, up: 50, w: 2 }, head: { w: 3, h: 3 }, snout: 1, horns: { len: 3, back: true }, ears: 1, tail: 2, col: { body: '#6f5c46', belly: '#9c8a70', dark: '#2e241a', leg: '#5c4a38' } } },
  warthog:    { walk: 0.5, flee: 0.9, p: { len: 8, h: 4, leg: 2, legs: 4, neck: { len: 0, up: 0, w: 3 }, head: { w: 3, h: 3 }, snout: 2, noseHorn: 1, mane: true, tail: 3, tailUp: true, col: { body: '#695a4e', dark: '#2a221c', leg: '#5a4c42', horn: '#ebe3cc' } } },
  ostrich:    { walk: 0.6, flee: 0.9, p: { len: 7, h: 5, leg: 8, legs: 2, neck: { len: 7, up: 82, w: 1 }, head: { w: 2, h: 1 }, snout: 1, tail: 1, tailUp: true, col: { body: '#2b2725', belly: '#e9e3d8', dark: '#e9e3d8', leg: '#d6b69e' } } },
  baboon:     { walk: 0.5, flee: 0.6, p: { len: 7, h: 4, leg: 3, legs: 4, neck: { len: 0, up: 0, w: 3 }, head: { w: 3, h: 3 }, snout: 1, tail: 4, tailUp: true, col: { body: '#7c7054', dark: '#3a3226', leg: '#6c6048' } } },
  hippo:      { walk: 0.2, flee: 0.2, p: { len: 14, h: 7, leg: 2, legW: 2, legs: 4, neck: { len: 0, up: 0, w: 4 }, head: { w: 5, h: 5 }, snout: 2, ears: 1, tail: 1, col: { body: '#6f5d64', belly: '#b7888a', dark: '#3a2e32', leg: '#5f4f56' } } },
  lion:       { walk: 0.3, flee: 0.0, p: { len: 11, h: 5, leg: 4, legs: 4, neck: { len: 1, up: 20, w: 3 }, head: { w: 4, h: 4 }, snout: 1, ears: 1, tail: 5, col: { body: '#c79f5f', belly: '#dcc08c', dark: '#4a3420', leg: '#b8904f' } } },
  hyena:      { walk: 0.5, flee: 0.5, p: { len: 9, h: 5, leg: 4, legs: 4, neck: { len: 1, up: 20, w: 3 }, head: { w: 3, h: 3 }, snout: 1, ears: 2, hump: 1, tail: 2, pattern: 'spots', col: { body: '#a58f6b', pattern: '#4a3a2c', dark: '#2e2418', leg: '#94805e' } } },
  cheetah:    { walk: 0.4, flee: 0.4, p: { len: 10, h: 4, leg: 5, legs: 4, neck: { len: 1, up: 20, w: 2 }, head: { w: 3, h: 2 }, snout: 1, ears: 1, tail: 6, pattern: 'spots', col: { body: '#d6ae6e', belly: '#efe0bc', pattern: '#2a2218', dark: '#2a2218', leg: '#c8a064' } } },
  rhino:      { walk: 0.3, flee: 0.3, p: { len: 15, h: 7, leg: 3, legW: 2, legs: 4, neck: { len: 0, up: 0, w: 4 }, head: { w: 5, h: 4 }, snout: 2, noseHorn: 3, ears: 1, hump: 1, tail: 2, col: { body: '#8a847c', dark: '#45403a', leg: '#7a746c', horn: '#cfc7b4' } } },
};

// Walk frames (facing right) and behaviour for each sprite key.
export function animals() {
  const out = {};
  let seed = 7;
  for (const [k, a] of Object.entries(A)) out[k] = { ...a, frames: animalFrames(a.p, seed++) };
  return out;
}
