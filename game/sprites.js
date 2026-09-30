// Pixel-art helpers shared by every biome pack: seeded randomness, small canvases,
// outlining, and a generator that builds side-view animal sprites from a few numbers.

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 0..1 value for a tile, so decorations are the same every time a chunk is drawn.
export function hash2(x, y, s = 0) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function px(g, x, y, col, w = 1, h = 1) {
  g.fillStyle = col;
  g.fillRect(Math.round(x), Math.round(y), w, h);
}

export function shade(hex, f) {
  // f < 1 darkens, f > 1 lightens
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v =>
    Math.max(0, Math.min(255, Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1)))));
  return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('');
}

// Filled blob of pixels (a rough disc), for bushes and canopies.
export function blob(g, cx, cy, r, col, rnd, rough = 0.35) {
  g.fillStyle = col;
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y * 1.1) / r;
      if (d < 1 - rough * rnd() * 0.6) g.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
    }
}

// Add a one-pixel dark outline around everything opaque in a canvas.
export function outline(c, col = [28, 22, 16]) {
  const g = c.getContext('2d');
  const im = g.getImageData(0, 0, c.width, c.height);
  const a = im.data, W = c.width, H = c.height;
  const solid = i => a[i * 4 + 3] > 0;
  const add = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (solid(i)) continue;
      if ((x > 0 && solid(i - 1)) || (x < W - 1 && solid(i + 1)) ||
          (y > 0 && solid(i - W)) || (y < H - 1 && solid(i + W))) add.push(i);
    }
  for (const i of add) { a[i * 4] = col[0]; a[i * 4 + 1] = col[1]; a[i * 4 + 2] = col[2]; a[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0);
  return c;
}

export function flipX(c) {
  const [f, g] = makeCanvas(c.width, c.height);
  g.translate(c.width, 0); g.scale(-1, 1); g.drawImage(c, 0, 0);
  return f;
}

// ---- side-view animal generator --------------------------------------------------------
// p: { len, h, leg, legW, legs (2|4), neck: {len, up, w}, head: {w, h}, snout, ears,
//      horns: {len, back}, trunk, tail, tailUp, hump, mane, pattern: 'stripes'|'patches'|'spots',
//      col: {body, belly, dark, leg, pattern} }
// Returns two walk frames facing right: [frame0, frame1]. Feet sit on the bottom row.
export function animalFrames(p, seed = 1) {
  return [0, 1].map(f => outline(drawAnimal(p, f, mulberry32(seed))));
}

function drawAnimal(p, frame, rnd) {
  const neck = p.neck || { len: 0, up: 0, w: 2 };
  const head = p.head || { w: 3, h: 3 };
  const pad = 3;
  const neckDx = Math.round(neck.len * Math.cos(neck.up * Math.PI / 180));
  const neckDy = Math.round(neck.len * Math.sin(neck.up * Math.PI / 180));
  const tail = p.tail || 0;
  const W = pad * 2 + tail + p.len + Math.max(0, neckDx) + head.w + (p.snout || 0) + 2;
  const H = pad * 2 + p.leg + p.h + Math.max(0, neckDy) + head.h + (p.horns ? p.horns.len : 0) + (p.hump || 0);
  const [c, g] = makeCanvas(W, H);
  const col = p.col;
  const foot = H - pad;
  const bx = pad + tail, by = foot - p.leg - p.h; // body top-left
  const legW = p.legW || 1;

  // far legs (darker), then body, then near legs
  const legXs = p.legs === 2
    ? [bx + Math.floor(p.len / 2) - 1, bx + Math.floor(p.len / 2) + 1]
    : [bx + 1, bx + p.len - legW - 1];
  const step = frame ? 1 : -1;
  const drawLeg = (x, near) => px(g, x, by + p.h - 1, near ? col.leg : shade(col.leg, 0.7), legW, p.leg + 1);
  if (p.legs === 2) {
    drawLeg(legXs[0] + step, false);
  } else {
    drawLeg(legXs[0] - step, false);
    drawLeg(legXs[1] + step, false);
  }

  // tail
  if (tail) {
    for (let i = 0; i < tail; i++) {
      const ty = p.tailUp ? by - i + 1 : by + 1 + i;
      px(g, bx - 1 - Math.floor(i * 0.6), ty, col.dark);
    }
  }

  // body: rounded box with a lighter belly
  g.fillStyle = col.body;
  g.fillRect(bx + 1, by, p.len - 2, p.h);
  g.fillRect(bx, by + 1, p.len, p.h - 2);
  if (col.belly) px(g, bx + 1, by + p.h - 1, col.belly, p.len - 2, 1);
  if (p.hump) { g.fillStyle = col.body; g.fillRect(bx + p.len - 4 - p.hump, by - p.hump, p.hump + 2, p.hump + 1); }

  // neck, from the front-top of the body up to the head
  const nx0 = bx + p.len - neck.w, ny0 = by + 1;
  const steps = Math.max(Math.abs(neckDx), Math.abs(neckDy), 1);
  for (let i = 0; i <= steps; i++) {
    const x = nx0 + Math.round(neckDx * i / steps), y = ny0 - Math.round(neckDy * i / steps);
    px(g, x, y, col.body, neck.w, neck.w);
    if (p.mane) px(g, x - 1, y, col.dark);
  }
  const hx = nx0 + neckDx + neck.w - 1, hy = ny0 - neckDy - Math.floor(head.h / 2);

  // head and snout
  px(g, hx, hy, col.body, head.w, head.h);
  if (p.snout) px(g, hx + head.w, hy + head.h - Math.max(1, Math.floor(head.h / 2)), col.body, p.snout, Math.max(1, Math.floor(head.h / 2)));
  px(g, hx + head.w - 1, hy + 1, col.dark); // eye
  if (p.ears) px(g, hx, hy - p.ears, col.body, p.ears > 2 ? p.ears : 1, p.ears);
  if (p.horns) {
    for (let i = 1; i <= p.horns.len; i++)
      px(g, hx + 1 - (p.horns.back ? Math.floor(i / 2) : 0), hy - i, col.horn || col.dark);
  }
  if (p.noseHorn) for (let i = 0; i < p.noseHorn; i++) px(g, hx + head.w + (p.snout || 0) - 1, hy + head.h - 2 - i, col.horn || '#d8d0b8');
  if (p.trunk) px(g, hx + head.w, hy + 1, col.body, 2, p.trunk);
  if (p.bigEar) px(g, hx - 1, hy - 1, shade(col.body, 0.85), 3, head.h + 2);

  // coat pattern over body, neck and head
  if (p.pattern) {
    const pc = col.pattern;
    const im = g.getImageData(0, 0, W, H).data;
    const bodyCol = parseInt(col.body.slice(1), 16);
    const isBody = (x, y) => {
      const i = (y * W + x) * 4;
      return im[i + 3] && ((im[i] << 16) | (im[i + 1] << 8) | im[i + 2]) === bodyCol;
    };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!isBody(x, y)) continue;
        if (p.pattern === 'stripes' && (x + (y >> 2)) % 2 === 0) px(g, x, y, pc);
        if (p.pattern === 'patches' && (x % 3 === 0 || y % 3 === 0)) px(g, x, y, pc);
        if (p.pattern === 'spots' && rnd() < 0.18) px(g, x, y, pc);
      }
  }

  // near legs on top
  if (p.legs === 2) {
    drawLeg(legXs[1] - step, true);
  } else {
    drawLeg(legXs[0] + 1 + step, true);
    drawLeg(legXs[1] - 1 - step, true);
  }
  return c;
}
