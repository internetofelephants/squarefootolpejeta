// squarefoot: drive a safari vehicle around a tile map made from real geographic data.
// Reads the pipeline outputs in data/out/<place>/ and draws them with a biome art pack.
//   index.html?place=ol_pejeta&biome=savanna
import { hash2, makeCanvas, mulberry32, flipX } from './sprites.js';

const params = new URLSearchParams(location.search);
const PLACE = params.get('place') || 'ol_pejeta';
const BIOME = params.get('biome') || 'savanna';
const DATA = `../data/out/${PLACE}/`;

const CHUNK = 32;            // tiles per chunk side
const CHUNK_CACHE = 64;      // chunks kept drawn
const BASE_SPEED = 6;        // tiles/s on open grass (stylised: the map would take hours at real speed)
const TARGET_H = 270;        // logical screen height in pixels, before scaling up

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const status = document.getElementById('status');

let B, TILE;                 // biome pack and its tile size
let meta, legend, species;
let W, H;                    // map size in tiles
let T, O, ELEV, HS, M;       // tile ids, objects, elevation (dm), hillshade, inside mask
let byId = [];               // tile id → legend entry
let tileTex = {};            // tile key → [variant canvases]
let animalArt;
let carFrames = [];          // pre-rotated vehicle, 32 headings
const keys = {};

// ---- loading -----------------------------------------------------------------------------
async function loadJSON(f) {
  const r = await fetch(DATA + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}. Has the pipeline been run for "${PLACE}"?`);
  return r.json();
}

async function loadPixels(f) {
  const r = await fetch(DATA + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  // No colour conversion, so the stored values (tile ids, elevation) come through exactly.
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const [c, g] = makeCanvas(bmp.width, bmp.height);
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height).data;
}

async function load() {
  B = await import(`./biomes/${BIOME}.js`);
  TILE = B.TILE;
  [meta, legend, species] = await Promise.all(['meta.json', 'legend.json', 'species.json'].map(loadJSON));
  W = meta.width; H = meta.height;
  const [tp, op, ep, mp] = await Promise.all(['tiles.png', 'objects.png', 'terrain.png', 'mask.png'].map(loadPixels));
  const n = W * H;
  T = new Uint8Array(n); O = new Uint8Array(n); ELEV = new Uint16Array(n); HS = new Uint8Array(n); M = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    T[i] = tp[i * 4]; O[i] = op[i * 4]; M[i] = mp[i * 4] > 127 ? 1 : 0;
    ELEV[i] = (ep[i * 4] << 8) | ep[i * 4 + 1]; HS[i] = ep[i * 4 + 2];
  }
  for (const t of legend) byId[t.id] = t;

  for (const t of legend) {
    const art = B.tiles[t.key];
    if (!art) throw new Error(`biome "${BIOME}" has no art for tile "${t.key}"`);
    tileTex[t.key] = [0, 1, 2, 3].map(v => {
      const [c, g] = makeCanvas(TILE, TILE);
      art.paint(g, mulberry32(t.id * 97 + v));
      return c;
    });
  }
  animalArt = B.animals();
  for (const a of Object.values(animalArt)) a.left = a.frames.map(flipX);
  const car = B.vehicle();
  for (let i = 0; i < 32; i++) {
    const s = Math.ceil(Math.hypot(car.width, car.height)) + 2;
    const [c, g] = makeCanvas(s, s);
    g.translate(s / 2, s / 2); g.rotate(i / 32 * Math.PI * 2);
    g.drawImage(car, -car.width / 2, -car.height / 2);
    carFrames.push(c);
  }
}

// ---- map queries -------------------------------------------------------------------------
const idx = (x, y) => y * W + x;
const inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
function tileAt(x, y) { x |= 0; y |= 0; return inMap(x, y) ? byId[T[idx(x, y)]] : null; }
function inside(x, y) { x |= 0; y |= 0; return inMap(x, y) && M[idx(x, y)] === 1; }

// lat/lon by bilinear interpolation between the grid's corners (works for any projection
// over a small area; error here is a few centimetres).
function lonLat(x, y) {
  const c = meta.corners_wgs84, u = x / W, v = y / H;
  const lerp = (a, b, t) => a + (b - a) * t;
  const top = [0, 1].map(k => lerp(c.tl[k], c.tr[k], u));
  const bot = [0, 1].map(k => lerp(c.bl[k], c.br[k], u));
  return [lerp(top[0], bot[0], v), lerp(top[1], bot[1], v)];
}

// ---- chunked ground rendering --------------------------------------------------------------
const chunks = new Map();

function drawChunk(cx, cy) {
  const [c, g] = makeCanvas(CHUNK * TILE, CHUNK * TILE);
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  // ground, with hillshade
  for (let ty = 0; ty < CHUNK; ty++)
    for (let tx = 0; tx < CHUNK; tx++) {
      const x = x0 + tx, y = y0 + ty;
      if (!inMap(x, y)) continue;
      const i = idx(x, y), t = byId[T[i]];
      if (!t) continue;
      const tex = tileTex[t.key][(hash2(x, y) * 4) | 0];
      g.drawImage(tex, tx * TILE, ty * TILE);
    }
  // hillshade: one grey pixel per tile (with a one-tile border so chunks meet seamlessly),
  // stretched smoothly over the ground and blended with 'overlay' (mid-grey = no change)
  const [sc, sg] = makeCanvas(CHUNK + 2, CHUNK + 2);
  const sim = sg.createImageData(CHUNK + 2, CHUNK + 2);
  for (let ty = 0; ty < CHUNK + 2; ty++)
    for (let tx = 0; tx < CHUNK + 2; tx++) {
      const x = Math.min(W - 1, Math.max(0, x0 + tx - 1)), y = Math.min(H - 1, Math.max(0, y0 + ty - 1));
      const v = Math.max(0, Math.min(255, 128 + (HS[idx(x, y)] - 180) * 1.3));  // ~180 = flat under a 45° sun
      const o = (ty * (CHUNK + 2) + tx) * 4;
      sim.data[o] = sim.data[o + 1] = sim.data[o + 2] = v; sim.data[o + 3] = 255;
    }
  sg.putImageData(sim, 0, 0);
  g.save();
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = 'overlay';
  g.drawImage(sc, -TILE, -TILE, (CHUNK + 2) * TILE, (CHUNK + 2) * TILE);  // pixel k centres on tile k-1
  g.restore();
  // scenery: include a margin of neighbouring tiles so canopies that cross a chunk edge aren't cut
  const m = 2;
  for (let ty = -m; ty < CHUNK + m; ty++)
    for (let tx = -m; tx < CHUNK + m; tx++) {
      const x = x0 + tx, y = y0 + ty;
      if (!inMap(x, y)) continue;
      const i = idx(x, y), t = byId[T[i]];
      if (!t) continue;
      const rnd = mulberry32((x * 73856093) ^ (y * 19349663));
      B.decor(t.key, g, tx * TILE, ty * TILE, rnd);
      if (O[i] === 1) B.loneTree(g, tx * TILE + TILE / 2, ty * TILE + TILE / 2, rnd);
    }
  // outside the fence: dimmed; the fence along the edge
  for (let ty = 0; ty < CHUNK; ty++)
    for (let tx = 0; tx < CHUNK; tx++) {
      const x = x0 + tx, y = y0 + ty;
      if (!inMap(x, y)) continue;
      if (!M[idx(x, y)]) { g.fillStyle = B.outsideTint; g.fillRect(tx * TILE, ty * TILE, TILE, TILE); continue; }
      for (const [s, dx, dy] of [['n', 0, -1], ['s', 0, 1], ['w', -1, 0], ['e', 1, 0]])
        if (!inside(x + dx, y + dy)) B.fence(g, tx * TILE, ty * TILE, s);
    }
  return c;
}

// Draw one chunk that's about to come into view (ahead of the car first), at most one a frame.
function prefetchChunk(camX, camY, vw, vh, ts) {
  const cs = CHUNK * ts;
  const ax = Math.sin(car.a) * Math.sign(car.v), ay = -Math.cos(car.a) * Math.sign(car.v);
  const want = [];
  for (let cy = Math.floor(camY / cs) - 1; cy <= Math.floor((camY + vh) / cs) + 1; cy++)
    for (let cx = Math.floor(camX / cs) - 1; cx <= Math.floor((camX + vw) / cs) + 1; cx++) {
      if (cx < 0 || cy < 0 || cx * CHUNK >= W || cy * CHUNK >= H || chunks.has(cx + ',' + cy)) continue;
      const dx = (cx + 0.5) * cs - (camX + vw / 2), dy = (cy + 0.5) * cs - (camY + vh / 2);
      want.push([cx, cy, Math.hypot(dx, dy) - (dx * ax + dy * ay) * 0.8]);
    }
  if (!want.length) return;
  want.sort((a, b) => a[2] - b[2]);
  getChunk(want[0][0], want[0][1]);
}

function getChunk(cx, cy) {
  const k = cx + ',' + cy;
  let c = chunks.get(k);
  if (c) { chunks.delete(k); chunks.set(k, c); return c; }   // move to most-recent
  c = drawChunk(cx, cy);
  chunks.set(k, c);
  if (chunks.size > CHUNK_CACHE) chunks.delete(chunks.keys().next().value);
  return c;
}

// ---- the vehicle -------------------------------------------------------------------------
const car = { x: 0, y: 0, a: 0, v: 0, bump: 0 };

function carBlocked(x, y) {
  // centre, plus a point ahead in the direction of travel
  const fx = x + Math.sin(car.a) * 0.6 * Math.sign(car.v || 1);
  const fy = y - Math.cos(car.a) * 0.6 * Math.sign(car.v || 1);
  for (const [px, py] of [[x, y], [fx, fy]]) {
    const t = tileAt(px, py);
    if (!t || t.speed <= 0 || !inside(px, py)) return true;
  }
  return false;
}

function updateCar(dt) {
  const up = keys.ArrowUp || keys.KeyW, down = keys.ArrowDown || keys.KeyS;
  const left = keys.ArrowLeft || keys.KeyA, right = keys.ArrowRight || keys.KeyD;
  const t = tileAt(car.x, car.y);
  const max = BASE_SPEED * (t ? t.speed : 1);
  if (up) car.v += 7 * dt;
  else if (down) car.v -= (car.v > 0 ? 12 : 5) * dt;
  else car.v -= Math.sign(car.v) * Math.min(Math.abs(car.v), 3 * dt);
  // rough ground drags you down to its top speed
  if (car.v > max) car.v = Math.max(max, car.v - 14 * dt);
  car.v = Math.max(-max * 0.4, car.v);
  const steer = (right ? 1 : 0) - (left ? 1 : 0);
  const grip = Math.min(1, Math.abs(car.v) / 2);
  car.a += steer * 2.6 * grip * dt * Math.sign(car.v || 1);

  const nx = car.x + Math.sin(car.a) * car.v * dt, ny = car.y - Math.cos(car.a) * car.v * dt;
  if (!carBlocked(nx, ny)) { car.x = nx; car.y = ny; }
  else if (!carBlocked(nx, car.y)) { car.x = nx; car.v *= 0.9; }
  else if (!carBlocked(car.x, ny)) { car.y = ny; car.v *= 0.9; }
  else { if (Math.abs(car.v) > 2) car.bump = 0.25; car.v = 0; }
  car.bump = Math.max(0, car.bump - dt);

  // dust on dirt
  if (Math.abs(car.v) > 2 && t && ['track', 'road', 'bare', 'path', 'stream'].includes(t.key) && Math.random() < 0.6) {
    dust.push({ x: car.x - Math.sin(car.a) * 0.7, y: car.y + Math.cos(car.a) * 0.7, life: 0.8, r: 1 + Math.random() * 2,
                c: B.dust[(Math.random() * B.dust.length) | 0] });
  }
}

const dust = [];

function findStart() {
  // the track tile inside the fence nearest the middle of the study area
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) if (M[idx(x, y)]) { sx += x; sy += y; n++; }
  const cx = sx / n, cy = sy / n;
  let best = null, bd = Infinity;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = byId[T[idx(x, y)]];
    if (!M[idx(x, y)] || !t || t.key !== 'track') continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; }
  }
  return best || [cx, cy];
}

// ---- animals -----------------------------------------------------------------------------
// Every herd is placed at random in its habitat each time the game loads. No real sighting
// locations are used for any species (the pipeline never downloads them).
const herds = [];

function animalCanStand(sp, x, y) {
  if (!inside(x, y)) return false;
  const t = tileAt(x, y);
  if (!t) return false;
  if (t.key === 'built') return false;
  if (t.speed <= 0) return sp.habitats.includes(t.key);  // water only for water animals
  return true;
}

function randomHabitatCell(sp, cells, near, radius) {
  for (let i = 0; i < 40; i++) {
    let x, y;
    if (near) { x = near[0] + (Math.random() * 2 - 1) * radius; y = near[1] + (Math.random() * 2 - 1) * radius; }
    else { const c = cells[(Math.random() * cells.length) | 0]; x = c % W + Math.random(); y = (c / W | 0) + Math.random(); }
    const t = tileAt(x, y);
    if (t && inside(x, y) && sp.habitats.includes(t.key)) return [x, y];
  }
  return null;
}

function placeAnimals() {
  const insideCells = [];
  for (let i = 0; i < W * H; i++) if (M[i]) insideCells.push(i);
  const areaKm2 = insideCells.length * meta.res_m ** 2 / 1e6;
  for (const sp of species.animals) {
    const art = animalArt[sp.sprite];
    if (!art) { console.warn(`no sprite for ${sp.sprite}`); continue; }
    const cells = insideCells.filter(i => sp.habitats.includes(byId[T[i]]?.key));
    if (!cells.length) continue;
    const nHerds = Math.max(1, Math.round(sp.density * areaKm2 / 10));
    for (let h = 0; h < nHerds; h++) {
      const at = randomHabitatCell(sp, cells);
      if (!at) continue;
      const size = sp.herd[0] + Math.floor(Math.random() * (sp.herd[1] - sp.herd[0] + 1));
      const spread = 0.8 + Math.sqrt(size) * 0.9;
      const herd = { sp, art, cells, x: at[0], y: at[1], tx: at[0], ty: at[1], wait: Math.random() * 10, members: [] };
      for (let k = 0; k < size; k++) {
        const ox = (Math.random() * 2 - 1) * spread, oy = (Math.random() * 2 - 1) * spread * 0.7;
        herd.members.push({ x: at[0] + ox, y: at[1] + oy, ox, oy, face: Math.random() < 0.5 ? 1 : -1,
                            anim: Math.random(), moving: false, scare: 0 });
      }
      herds.push(herd);
    }
  }
}

function updateAnimals(dt) {
  for (const h of herds) {
    const { sp, art } = h;
    const dCar = Math.hypot(car.x - h.x, car.y - h.y);
    // spooked: the whole herd heads away from a car driving close by
    if (art.flee > 0 && dCar < 3 + 4 * art.flee && Math.abs(car.v) > 1.5) {
      const ax = h.x - car.x, ay = h.y - car.y, d = Math.hypot(ax, ay) || 1;
      const far = randomHabitatCell(sp, h.cells, [h.x + ax / d * 12, h.y + ay / d * 12], 4);
      if (far) { h.tx = far[0]; h.ty = far[1]; h.wait = 0; h.run = 3 + 3 * art.flee; }
    }
    h.run = Math.max(0, (h.run || 0) - dt);
    const speed = art.walk * (h.run > 0 ? 3 : 1);
    if (h.wait > 0) h.wait -= dt;
    else {
      const dx = h.tx - h.x, dy = h.ty - h.y, d = Math.hypot(dx, dy);
      if (d < 0.3) {
        h.wait = 4 + Math.random() * 16;   // graze a while, then pick somewhere new nearby
        const next = randomHabitatCell(sp, h.cells, [h.x, h.y], 18);
        if (next) { h.tx = next[0]; h.ty = next[1]; }
      } else {
        const nx = h.x + dx / d * speed * dt, ny = h.y + dy / d * speed * dt;
        if (animalCanStand(sp, nx, ny)) { h.x = nx; h.y = ny; }
        else { h.tx = h.x; h.ty = h.y; }
      }
    }
    for (const m of h.members) {
      const gx = h.x + m.ox, gy = h.y + m.oy;
      const dx = gx - m.x, dy = gy - m.y, d = Math.hypot(dx, dy);
      m.moving = d > 0.15;
      if (m.moving) {
        const s = Math.min(d, speed * 1.4 * dt + 0.002);
        const nx = m.x + dx / d * s, ny = m.y + dy / d * s;
        if (animalCanStand(sp, nx, ny)) { m.x = nx; m.y = ny; }
        if (Math.abs(dx) > 0.05) m.face = dx > 0 ? 1 : -1;
        m.anim += dt * (h.run > 0 ? 8 : 4);
      } else if (Math.random() < dt * 0.05) {
        // shuffle about while grazing
        m.ox += (Math.random() - 0.5) * 0.6; m.oy += (Math.random() - 0.5) * 0.4;
      }
    }
  }
}

// ---- camera and drawing ------------------------------------------------------------------
let zoom = 1;
let scale = 3;

function resize() {
  scale = Math.max(1, Math.round(innerHeight / TARGET_H));
  canvas.width = Math.ceil(innerWidth / scale);
  canvas.height = Math.ceil(innerHeight / scale);
  canvas.style.width = canvas.width * scale + 'px';
  canvas.style.height = canvas.height * scale + 'px';
  ctx.imageSmoothingEnabled = false;
}

function render(dt) {
  const ts = TILE * zoom;
  const vw = canvas.width, vh = canvas.height;
  // look ahead a little in the direction of travel
  const look = Math.max(0, car.v) * 0.35;
  const camX = Math.round((car.x + Math.sin(car.a) * look) * ts - vw / 2);
  const camY = Math.round((car.y - Math.cos(car.a) * look) * ts - vh / 2);
  const shake = car.bump > 0 ? (Math.random() * 2 - 1) * 2 : 0;

  ctx.fillStyle = '#2a2218';
  ctx.fillRect(0, 0, vw, vh);
  ctx.save();
  ctx.translate(-camX + shake, -camY);
  const cs = CHUNK * ts;
  for (let cy = Math.floor(camY / cs); cy <= Math.floor((camY + vh) / cs); cy++)
    for (let cx = Math.floor(camX / cs); cx <= Math.floor((camX + vw) / cs); cx++) {
      if (cx < 0 || cy < 0 || cx * CHUNK >= W || cy * CHUNK >= H) continue;
      ctx.drawImage(getChunk(cx, cy), cx * cs, cy * cs, cs, cs);
    }

  if (zoom === 1) drawHectares(camX, camY, vw, vh, ts);

  // dust under everything that stands
  for (let i = dust.length - 1; i >= 0; i--) {
    const p = dust[i];
    p.life -= dt; p.r += dt * 3;
    if (p.life <= 0) { dust.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(0.6, p.life);
    ctx.fillStyle = p.c;
    ctx.fillRect(Math.round(p.x * ts - p.r / 2), Math.round(p.y * ts - p.r / 2), Math.ceil(p.r), Math.ceil(p.r));
  }
  ctx.globalAlpha = 1;

  // everything that stands, sorted by where it touches the ground
  const things = [];
  const margin = 3;
  const inView = (x, y) => x * ts > camX - margin * ts && x * ts < camX + vw + margin * ts &&
                           y * ts > camY - margin * ts && y * ts < camY + vh + margin * ts;
  for (const h of herds) {
    if (!inView(h.x, h.y) && Math.hypot(h.x - car.x, h.y - car.y) > 30) continue;
    for (const m of h.members) if (inView(m.x, m.y)) things.push({ y: m.y, m, h });
  }
  things.push({ y: car.y + 0.3, car: true });
  things.sort((a, b) => a.y - b.y);
  for (const t of things) {
    if (t.car) {
      const f = carFrames[((Math.round(car.a / (Math.PI * 2) * 32) % 32) + 32) % 32];
      ctx.globalAlpha = 0.3; ctx.fillStyle = '#1a140c';
      ctx.fillRect(Math.round(car.x * ts - 5 * zoom + 2), Math.round(car.y * ts - 6 * zoom + 2), Math.round(11 * zoom), Math.round(13 * zoom));
      ctx.globalAlpha = 1;
      const s = f.width * zoom;
      ctx.drawImage(f, Math.round(car.x * ts - s / 2), Math.round(car.y * ts - s / 2), s, s);
      continue;
    }
    const { m, h } = t;
    const set = m.face > 0 ? h.art.frames : h.art.left;
    const img = set[m.moving ? (m.anim | 0) % 2 : 0];
    const w = img.width * zoom, hh = img.height * zoom;
    const fx = Math.round(m.x * ts - w / 2), fy = Math.round(m.y * ts - hh + 3 * zoom);
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#1a140c';
    ctx.fillRect(fx + 3 * zoom, Math.round(m.y * ts), w - 6 * zoom, Math.max(1, 2 * zoom));
    ctx.globalAlpha = 1;
    ctx.drawImage(img, fx, fy, w, hh);
  }
  ctx.restore();
  prefetchChunk(camX, camY, vw, vh, ts);
}

// One-hectare squares: lines on every whole 100 m of the map's projected grid (UTM here), so
// each square is a real 100 × 100 m hectare on the ground, not just 10 × 10 tiles from the corner.
const HECTARE_M = 100;
function drawHectares(camX, camY, vw, vh, ts) {
  const res = meta.res_m, ox = meta.origin.x, oy = meta.origin.y;
  const pxPerM = ts / res;
  ctx.fillStyle = 'rgba(255, 250, 230, 0.22)';
  // eastings: x metres = ox + px / pxPerM
  const e0 = Math.ceil((ox + camX / pxPerM) / HECTARE_M) * HECTARE_M;
  for (let e = e0; (e - ox) * pxPerM <= camX + vw; e += HECTARE_M)
    ctx.fillRect(Math.round((e - ox) * pxPerM), camY, 1, vh);
  // northings run down the screen: y metres = oy - px / pxPerM
  const n0 = Math.floor((oy - camY / pxPerM) / HECTARE_M) * HECTARE_M;
  for (let n = n0; (oy - n) * pxPerM <= camY + vh; n -= HECTARE_M)
    ctx.fillRect(camX, Math.round((oy - n) * pxPerM), vw, 1);
}

// ---- HUD and minimap ---------------------------------------------------------------------
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
let miniBase, miniStep, bigMap = false;

function buildMinimap() {
  miniStep = Math.max(1, Math.ceil(Math.max(W, H) / 220));
  const mw = Math.ceil(W / miniStep), mh = Math.ceil(H / miniStep);
  const [c, g] = makeCanvas(mw, mh);
  const im = g.createImageData(mw, mh);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const cols = byId.map(t => t && rgb(B.tiles[t.key].map));
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      const i = idx(Math.min(W - 1, x * miniStep), Math.min(H - 1, y * miniStep));
      const col = cols[T[i]] || [0, 0, 0];
      const f = M[i] ? 0.75 + (HS[i] / 255) * 0.4 : 0.4;
      const o = (y * mw + x) * 4;
      im.data[o] = col[0] * f; im.data[o + 1] = col[1] * f; im.data[o + 2] = col[2] * f; im.data[o + 3] = 255;
    }
  // the fence line
  for (let y = 1; y < mh - 1; y++)
    for (let x = 1; x < mw - 1; x++) {
      const at = (xx, yy) => M[idx(Math.min(W - 1, xx * miniStep), Math.min(H - 1, yy * miniStep))];
      if (at(x, y) && (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1))) {
        const o = (y * mw + x) * 4;
        im.data[o] = 255; im.data[o + 1] = 244; im.data[o + 2] = 200;
      }
    }
  g.putImageData(im, 0, 0);
  miniBase = c;
  mini.width = mw; mini.height = mh;
}

function drawMinimap() {
  mini.classList.toggle('big', bigMap);
  mctx.drawImage(miniBase, 0, 0);
  const x = car.x / miniStep, y = car.y / miniStep;
  mctx.save();
  mctx.translate(x, y); mctx.rotate(car.a);
  mctx.fillStyle = '#ffffff'; mctx.strokeStyle = '#1a140c'; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.moveTo(0, -5); mctx.lineTo(3.5, 4); mctx.lineTo(-3.5, 4); mctx.closePath();
  mctx.fill(); mctx.stroke();
  mctx.restore();
}

function fmtDeg(v, pos, neg) { return `${Math.abs(v).toFixed(5)}° ${v >= 0 ? pos : neg}`; }

let hudTimer = 0;
function updateHud(dt) {
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.15;
  const [lon, lat] = lonLat(car.x, car.y);
  const i = idx(car.x | 0, car.y | 0);
  const t = tileAt(car.x, car.y);
  const elev = meta.elev_base_m + ELEV[i] * meta.elev_scale;
  let near = null, nd = 9;
  for (const h of herds) {
    const d = Math.hypot(h.x - car.x, h.y - car.y);
    if (d < nd) { nd = d; near = h; }
  }
  hud.innerHTML =
    `<div class="place">${meta.name}</div>` +
    `<div>${fmtDeg(lat, 'N', 'S')}&nbsp; ${fmtDeg(lon, 'E', 'W')}</div>` +
    `<div>${Math.round(elev).toLocaleString()} m · ${t ? t.name : ''}</div>` +
    (near ? `<div class="near">${near.sp.name}${near.members.length > 1 ? ' ×' + near.members.length : ''}</div>` : '');
}

// ---- loop --------------------------------------------------------------------------------
let last = 0;
function frame(time) {
  const dt = Math.min(0.05, (time - last) / 1000 || 0);
  last = time;
  updateCar(dt);
  updateAnimals(dt);
  render(dt);
  updateHud(dt);
  drawMinimap();
  requestAnimationFrame(frame);
}

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyM') bigMap = !bigMap;
  if (e.code === 'KeyZ') zoom = zoom === 1 ? 0.5 : 1;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('resize', resize);

// exposed for testing in the console
Object.assign(window, { car, herds, keys, tileAt, lonLat, updateCar, updateAnimals, render });

(async () => {
  try {
    await load();
  } catch (e) {
    status.textContent = 'Could not load: ' + e.message;
    console.error(e);
    return;
  }
  resize();
  [car.x, car.y] = findStart();
  placeAnimals();
  buildMinimap();
  status.remove();
  requestAnimationFrame(frame);
})();
