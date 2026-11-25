import { MAX_FLOOR, WORLD_WIDTH, wrapX } from './geography.js';
import { beadTint, drawBeadGlyph } from './bead-visual.js';
import { drawJellyBody, drawJellyInk, drawJellySheen, jellyPhase, jellyPose } from './jelly-bead.js';
import { advanceSwimMotion, swimPose } from './swim-visual.js';

const FONT = "'Microsoft YaHei',Consolas,monospace";
const TAU = 2 * Math.PI;
const CELL = 64, PAD = 16, SPRITE = CELL + PAD * 2;
const GLYPH_LIMIT = 512, GLYPHS_PER_FRAME = 24;
const BEAD_KINDS = new Set(['fish', 'fishPreview', 'scene', 'beadPreview']);
const FOCAL = 59, PITCH = .26;
const BANDS = [0, 2, 5, 9, 15, 24, 36, 53, 75, 101, 132];
const STEP = 2, COLUMNS = WORLD_WIDTH / STEP;
const ROCK_STEP = 10, ROCK_COLUMNS = WORLD_WIDTH / ROCK_STEP;
const MATERIALS = {
  scene: { depth: .19, light: .29, dark: .51 },
  fish: { depth: .20, light: .36, dark: .58 },
  seaweed: { depth: .13, light: .31, dark: .52 },
  food: { depth: .11, light: .33, dark: .61 },
  bubble: { depth: .06, light: .17, dark: .78 },
  monument: { depth: .25, light: .24, dark: .46 },
  preview: { depth: .15, light: .29, dark: .59 },
  legend: { depth: .22, light: .35, dark: .55 },
  breath: { depth: .06, light: .48, dark: .72 },
};

const mix = (a, b, t) => a + (b - a) * t;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const mod = (value, period) => (value % period + period) % period;
const perspective = z => FOCAL / (FOCAL + z);

function random(seed) {
  let word = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  word = Math.imul(word ^ (word >>> 16), 0x45d9f3b);
  return ((word ^ (word >>> 16)) >>> 0) / 4294967296;
}

function canvas(width, height) {
  const result = document.createElement('canvas');
  result.width = width;
  result.height = height;
  return result;
}

function rgb(r, g, b) {
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function radialTexture(inner, outer) {
  const texture = canvas(128, 128), ctx = texture.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return texture;
}

function lightShaft() {
  const texture = canvas(160, 256), ctx = texture.getContext('2d');
  const image = ctx.createImageData(texture.width, texture.height);
  for (let y = 0; y < texture.height; y++) {
    const v = y / (texture.height - 1), spread = .055 + v * .38;
    const fade = Math.pow(1 - v, 1.75) * Math.min(1, .32 + v * 19);
    for (let x = 0; x < texture.width; x++) {
      const u = x / (texture.width - 1) - .5;
      const core = Math.max(0, 1 - Math.abs(u) / spread);
      const fringe = .23 * Math.max(0, 1 - Math.abs(u + .046) / (spread * 1.1));
      const i = 4 * (y * texture.width + x);
      image.data[i] = 142;
      image.data[i + 1] = 225;
      image.data[i + 2] = 217;
      image.data[i + 3] = 89 * fade * (core ** 1.7 + fringe);
    }
  }
  ctx.putImageData(image, 0, 0);
  return texture;
}

function waterCaustics() {
  const texture = canvas(576, 72), ctx = texture.getContext('2d');
  const image = ctx.createImageData(texture.width, texture.height);
  const columns = 27;
  for (let y = 0; y < texture.height; y++) {
    const v = y / (texture.height - 1);
    for (let x = 0; x < texture.width; x++) {
      const u = x / texture.width, phase = u * TAU;
      const px = u * columns + .39 * Math.sin(phase * 5 + v * 8) + .22 * Math.cos(phase * 8 - v * 11);
      const py = v * 4.1 + .36 * Math.sin(phase * 6 - v * 7);
      const ix = Math.floor(px), iy = Math.floor(py);
      let nearest = Infinity, second = Infinity;
      for (let cy = iy - 1; cy <= iy + 1; cy++) for (let cx = ix - 1; cx <= ix + 1; cx++) {
        const seed = mod(cx, columns) + cy * columns;
        const dx = cx + .15 + random(seed * 83 + 17) * .7 - px;
        const dy = cy + .15 + random(seed * 91 + 29) * .7 - py;
        const distance = dx * dx + dy * dy;
        if (distance < nearest) { second = nearest; nearest = distance; }
        else if (distance < second) second = distance;
      }
      const edge = Math.sqrt(second) - Math.sqrt(nearest);
      const intensity = .78 * Math.exp(-18 * edge) + .22 * Math.exp(-4 * edge);
      const i = 4 * (y * texture.width + x);
      image.data[i] = 177;
      image.data[i + 1] = 250;
      image.data[i + 2] = 230;
      image.data[i + 3] = 159 * intensity * Math.pow(1 - v, 1.6);
    }
  }
  ctx.putImageData(image, 0, 0);
  return texture;
}

function groundHeight(x, z, floor) {
  const phase = x / WORLD_WIDTH * TAU;
  const ridge = (3.4 * Math.sin(phase * 17 + z * .085) + 2.1 * Math.cos(phase * 29 - z * .18)
    + .85 * Math.sin(phase * 89 + z * .29)) * Math.min(1, z / 15);
  return mix(floor[x], 84, Math.min(.86, z / 120)) + ridge
    + Math.sin(phase * 8 + z * .1) * Math.min(8, z * .29);
}

function rockMesh(column, z, band, heights) {
  const seed = column + band * ROCK_COLUMNS + 310;
  const x = column * ROCK_STEP + 1 + random(seed * 11) * 8;
  const cell = Math.floor(x / STEP), next = (cell + 1) % COLUMNS;
  const fraction = x / STEP - cell;
  const near = mix(heights[band][cell], heights[band][next], fraction);
  const far = mix(heights[band + 1][cell], heights[band + 1][next], fraction);
  const y = mix(near, far, (z - BANDS[band]) / (BANDS[band + 1] - BANDS[band]));
  const width = .65 + 3.2 * random(seed * 13) ** 2.2;
  const depth = Math.min(z / 2, width * (.52 + .47 * random(seed * 23)));
  const height = width * (.52 + .58 * random(seed * 31));
  const tilt = random(seed * 37) * TAU;
  const size = 5;
  const rim = Array.from({ length: size }, (_, i) => {
    const angle = tilt + i * TAU / size;
    const shape = .75 + .31 * random(seed * 83 + i);
    return { x: Math.cos(angle) * width * shape, y: (random(seed + 5 * i) - .5) * height * .24, z: Math.sin(angle) * depth * shape };
  });
  const crest = rim.map((p, i) => ({
    x: p.x * .43 + width * (random(seed * 41) - .63),
    y: -height * (.8 + .26 * random(seed * 53 + i)),
    z: p.z * .45 - depth * .1,
  }));
  const fog = Math.min(.9, z / 109);
  const color = light => rgb(mix(32 + 77 * light, 16, fog), mix(53 + 63 * light, 55, fog), mix(55 + 44 * light, 76, fog));
  const faces = rim.map((a, i) => {
    const b = rim[(i + 1) % size], light = clamp(.48 - (a.x + b.x) / width * .20 + (a.z + b.z) / depth * .17, 0, 1);
    return { points: [a, b, crest[(i + 1) % size], crest[i]], depth: a.z + b.z, color: color(light) };
  });
  faces.sort((a, b) => b.depth - a.depth);
  faces.splice(2, 0, { points: crest, color: color(.86) });
  return { x, y, z, width, height, faces };
}

function buildTerrain(world) {
  const floor = Float32Array.from({ length: WORLD_WIDTH }, (_, x) => world.floorAt(x));
  const heights = BANDS.map(z => Float32Array.from({ length: COLUMNS }, (_, i) => groundHeight(i * STEP, z, floor)));
  const bands = BANDS.slice(1).map((far, band) => {
    const near = BANDS[band], fog = Math.min(.96, (near + far) / 235);
    const palette = Array.from({ length: 8 }, (_, shade) => rgb(
      mix(41 + shade * 6, 13, fog),
      mix(63 + shade * 5, 55, fog),
      mix(61 + shade * 4, 80, fog),
    ));
    const grades = Uint8Array.from({ length: COLUMNS }, (_, i) => {
      const next = (i + 1) % COLUMNS;
      const dx = (heights[band][next] + heights[band + 1][next] - heights[band][i] - heights[band + 1][i]) / (2 * STEP);
      const dz = (heights[band + 1][i] - heights[band][i]) / (far - near);
      return clamp(Math.round(3.7 + 2.9 * dx - 1.7 * dz + 1.3 * (random(821 * band + 123 * i) - .5)), 0, 7);
    });
    const rocks = Array.from({ length: ROCK_COLUMNS }, (_, column) => {
      const roll = random(77 * (column + ROCK_COLUMNS * band) + 37);
      return roll < .58 ? rockMesh(column, mix(near, far, .24 + roll * .92), band, heights) : null;
    });
    return { near, far, palette, grades, rocks };
  });
  return { floor, heights, bands };
}

function drawRock(ctx, rock, x, cameraY, size, halfW, halfH, shadow) {
  const scale = size * perspective(rock.z);
  const sx = halfW + x * scale, sy = halfH + (rock.y - cameraY - PITCH * rock.z) * scale;
  const w = rock.width * scale, h = rock.height * scale;
  if (w < 1.5 || sx - w * 2 > halfW * 2 || sx + w * 2 < 0 || sy - h * 1.5 > halfH * 2 || sy + h < 0) return;
  if (w < 5) {
    ctx.fillStyle = rock.faces.at(-1).color;
    ctx.beginPath();
    ctx.moveTo(sx - w, sy);
    ctx.lineTo(sx - w * .3, sy - h);
    ctx.lineTo(sx + w * .5, sy - h * .85);
    ctx.lineTo(sx + w, sy);
    ctx.fill();
    return;
  }
  ctx.drawImage(shadow, sx - w * 1.4, sy - w * .27, w * 3.1, w * .66);
  for (const face of rock.faces) {
    ctx.fillStyle = face.color;
    ctx.beginPath();
    for (const point of face.points) {
      const z = rock.z + point.z, scale = size * perspective(z);
      ctx.lineTo(halfW + (x + point.x) * scale, halfH + (rock.y - cameraY + point.y - PITCH * z) * scale);
    }
    ctx.closePath();
    ctx.fill();
  }
}

function drawTerrain(ctx, terrain, camera, size, halfW, halfH, shadow) {
  if (halfH + (59 - camera.y - PITCH * BANDS.at(-1)) * size * perspective(BANDS.at(-1)) > halfH * 2) return;
  const { x, y } = camera;
  const { floor, heights, bands } = terrain;
  ctx.fillStyle = bands.at(-1).palette[3];
  ctx.beginPath();
  ctx.moveTo(0, halfH * 2);
  for (let px = 0; px <= halfW * 2 + 8; px += 8) {
    let horizon = halfH * 2;
    for (let band = 0; band < BANDS.length; band++) {
      const z = BANDS[band], scale = size * perspective(z);
      const column = (x + (px - halfW) / scale) / STEP;
      const index = Math.floor(column), sample = mod(index, COLUMNS);
      const altitude = mix(heights[band][sample], heights[band][(sample + 1) % COLUMNS], column - index);
      horizon = Math.min(horizon, halfH + (altitude - y - PITCH * z) * scale);
    }
    ctx.lineTo(px, horizon + 1);
  }
  ctx.lineTo(halfW * 2, halfH * 2);
  ctx.closePath();
  ctx.fill();

  const ground = ctx.createLinearGradient(0, halfH + (70 - y) * size, 0, halfH + (110 - y) * size);
  ground.addColorStop(0, '#38534f');
  ground.addColorStop(.52, '#222f33');
  ground.addColorStop(1, '#081d2a');
  ctx.fillStyle = ground;
  const from = Math.floor(x - halfW / size), to = Math.ceil(x + halfW / size);
  ctx.beginPath();
  ctx.moveTo(0, halfH * 2);
  for (let col = from; col <= to; col++) {
    const left = halfW + (col - x) * size, top = halfH + (floor[wrapX(col)] - y) * size;
    ctx.lineTo(left, top);
    ctx.lineTo(left + size, top);
  }
  ctx.lineTo(halfW * 2, halfH * 2);
  ctx.closePath();
  ctx.fill();

  for (let band = bands.length - 1; band >= 0; band--) {
    const { near, far, palette, grades, rocks } = bands[band];
    const ns = size * perspective(near), fs = size * perspective(far);
    const ny = halfH - (y + PITCH * near) * ns, fy = halfH - (y + PITCH * far) * fs;
    const columnsPerFace = near > 0 && fs * STEP < 9 ? 2 : 1;
    const left = (Math.floor((x - halfW / fs) / (STEP * columnsPerFace)) - 2) * columnsPerFace;
    const right = Math.ceil((x + halfW / fs) / STEP) + 2 * columnsPerFace;
    const buckets = palette.map(() => new Path2D());
    for (let col = left; col < right; col += columnsPerFace) {
      const i = mod(col, COLUMNS), next = (i + columnsPerFace) % COLUMNS;
      const x0 = col * STEP - x, x1 = x0 + STEP * columnsPerFace;
      const yn = ny + heights[band][i] * ns;
      const yn1 = ny + (near === 0 ? floor[i * STEP + 1] : heights[band][next]) * ns;
      const yf = fy + heights[band + 1][i] * fs, yf1 = fy + heights[band + 1][next] * fs;
      if (Math.min(yn, yn1, yf, yf1) > halfH * 2 || Math.max(yn, yn1, yf, yf1) < 0) continue;
      const polygon = buckets[grades[i]];
      polygon.moveTo(halfW + x0 * ns, yn + .8);
      if (near === 0) {
        polygon.lineTo(halfW + (x0 + 1) * ns, yn + .8);
        polygon.lineTo(halfW + (x0 + 1) * ns, yn1 + .8);
      }
      polygon.lineTo(halfW + x1 * ns + .65, yn1 + .8);
      polygon.lineTo(halfW + x1 * fs + .65, yf1);
      polygon.lineTo(halfW + x0 * fs, yf);
      polygon.closePath();
    }
    for (let shade = 0; shade < palette.length; shade++) {
      ctx.fillStyle = palette[shade];
      ctx.fill(buckets[shade]);
    }
    const firstRock = Math.floor((x - halfW / fs) / ROCK_STEP) - 1;
    const lastRock = Math.ceil((x + halfW / fs) / ROCK_STEP) + 1;
    for (let column = firstRock; column <= lastRock; column++) {
      const rock = rocks[mod(column, ROCK_COLUMNS)];
      if (rock) {
        const worldX = rock.x + Math.floor(column / ROCK_COLUMNS) * WORLD_WIDTH;
        drawRock(ctx, rock, worldX - x, y, size, halfW, halfH, shadow);
      }
    }
  }
}

function glyphSprite(ch, color, glow, material, kind) {
  const sprite = canvas(SPRITE, SPRITE), ctx = sprite.getContext('2d');
  if (kind === 'fish' || kind === 'fishPreview') {
    drawJellyBody(ctx, color, PAD, PAD, CELL, glow);
    if (kind === 'fishPreview') drawJellyInk(ctx, ch, color, PAD, PAD, CELL);
    return sprite;
  }
  if (BEAD_KINDS.has(kind)) { drawBeadGlyph(ctx, ch, color, PAD, PAD, CELL, glow); return sprite; }
  const center = PAD + CELL / 2;
  const hex = Number.parseInt(color.slice(1), 16);
  const red = hex >> 16 & 255, green = hex >> 8 & 255, blue = hex & 255;
  const shade = strength => rgb(red * strength + 5, green * strength + 12, blue * strength + 20);
  const light = strength => rgb(mix(red, 236, strength), mix(green, 251, strength), mix(blue, 249, strength));
  ctx.font = `${CELL * .85}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const depth = CELL * material.depth, samples = Math.ceil(depth);
  for (let pass = samples; pass > 0; pass--) {
    const z = pass / samples;
    ctx.fillStyle = shade(material.dark * mix(1, .65, z));
    ctx.fillText(ch, center + depth * z * .64, center + depth * z * .86, CELL);
  }

  if (glow) {
    ctx.shadowBlur = 10;
    ctx.shadowColor = light(.62);
  }
  ctx.strokeStyle = light(.32);
  ctx.lineWidth = 1.6;
  ctx.strokeText(ch, center, center - .45, CELL);
  ctx.shadowBlur = 0;
  const face = ctx.createLinearGradient(0, PAD + 3, 0, PAD + CELL - 1);
  face.addColorStop(0, light(material.light));
  face.addColorStop(.52, color);
  face.addColorStop(1, shade(.77));
  ctx.fillStyle = face;
  ctx.fillText(ch, center, center, CELL);
  return sprite;
}

export class Scene3D {
  constructor() {
    this.motion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.glyphs = new Map();
    this.frameNumber = 0;
    this.trimmedFrame = -1;
    this.glyphBudget = GLYPHS_PER_FRAME;
    // Budget misses still use beads; a shared body avoids per-frame gradients.
    this.beadFallbacks = [false, true].map(glow => {
      const sprite = canvas(SPRITE, SPRITE);
      drawBeadGlyph(sprite.getContext('2d'), '', '#638393', PAD, PAD, CELL, glow);
      return sprite;
    });
    this.jellyFallbacks = [false, true].map(glow => {
      const sprite = canvas(SPRITE, SPRITE); drawJellyBody(sprite.getContext('2d'), '#638393', PAD, PAD, CELL, glow); return sprite;
    });
    this.jellySheen = canvas(SPRITE, SPRITE); drawJellySheen(this.jellySheen.getContext('2d'), PAD, PAD, CELL);
    this.jellyTime = 0; this.fishPhases = new Map();
    this.fishSwim = new Map(); this.fishPoses = new Map(); this.fishShapes = new Map();
    this.backdrop = canvas(1, 1);
    this.backdropContext = this.backdrop.getContext('2d', { alpha: false });
    this.caustics = waterCaustics();
    this.shaft = lightShaft();
    this.haze = radialTexture('#66b7cc58', '#66b7cc00');
    this.shadow = radialTexture('#020e20a5', '#020e2000');
  }

  background(renderer, world, size, now) {
    const { ctx, width, height, camera } = renderer;
    this.frameNumber++;
    this.glyphBudget = GLYPHS_PER_FRAME;
    this.jellyTime = Number.isFinite(now) ? now / 1000 : 0;
    if (width <= 0 || height <= 0) return;
    const terrain = world.data.terrain;
    if (terrain?.seed !== this.terrainSeed || terrain?.createdAt !== this.terrainDate || this.world !== world) {
      this.fishPhases.clear();
      this.fishSwim.clear(); this.fishPoses.clear();
      this.terrain = buildTerrain(world);
      this.terrainSeed = terrain?.seed;
      this.terrainDate = terrain?.createdAt;
      this.world = world;
      this.backdropKey = '';
    }
    const frame = `${width},${height},${camera.x},${camera.y},${size}`;
    if (this.backdropKey !== frame) {
      this.paintBackdrop(width, height, camera, size);
      this.backdropKey = frame;
    }
    ctx.drawImage(this.backdrop, 0, 0, width, height);

    const time = this.motion?.matches ? 0 : (Number.isFinite(now) ? now / 1000 : 0);
    const surface = height / 2 - camera.y * size;
    if (surface >= height) return;
    ctx.save();
    const underwater = Math.max(0, surface);
    ctx.beginPath();
    ctx.rect(0, underwater, width, height - underwater);
    ctx.clip();
    this.drawWaterLight(ctx, camera.x, width, surface, size, time);
    this.drawMotes(ctx, camera, width, height, size, time);
    ctx.restore();
  }

  paintBackdrop(width, height, camera, size) {
    const density = Math.min(.82, Math.sqrt(620000 / (width * height)));
    const w = Math.max(1, Math.ceil(width * density)), h = Math.max(1, Math.ceil(height * density));
    if (w !== this.backdrop.width || h !== this.backdrop.height) {
      this.backdrop.width = w;
      this.backdrop.height = h;
    }
    const ctx = this.backdropContext, surface = height / 2 - camera.y * size;
    ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
    const sky = ctx.createLinearGradient(0, surface - 28 * size, 0, surface);
    sky.addColorStop(0, '#071a31');
    sky.addColorStop(.66, '#183d55');
    sky.addColorStop(1, '#52959c');
    if (surface > 0) {
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, Math.min(height, surface + .5));
    }
    if (surface >= height) return;
    const sea = ctx.createLinearGradient(0, surface, 0, surface + MAX_FLOOR * size);
    sea.addColorStop(0, '#1d7285');
    sea.addColorStop(.22, '#115473');
    sea.addColorStop(.53, '#0d3e5a');
    sea.addColorStop(.81, '#082c48');
    sea.addColorStop(1, '#071d34');
    ctx.fillStyle = sea;
    ctx.fillRect(0, Math.max(0, Math.floor(surface)), width, height);

    for (let i = Math.floor((camera.x - width / size / 2 - 34) / 40); i <= (camera.x + width / size / 2 + 34) / 40; i++) {
      const nx = width / 2 + (i * 40 + random(mod(i, 25) + 75) * 12 - camera.x) * size;
      const glowY = surface - 13 * size;
      if (glowY + 44 * size > 0) ctx.drawImage(this.haze, nx - 30 * size, glowY, 60 * size, 44 * size);
    }
    drawTerrain(ctx, this.terrain, camera, size, width / 2, height / 2, this.shadow);
    ctx.save();
    ctx.translate(width / 2, height * .43);
    ctx.scale(width / height, 1);
    const vignette = ctx.createRadialGradient(0, 0, height * .15, 0, 0, height * .68);
    vignette.addColorStop(0, '#03091b00');
    vignette.addColorStop(1, '#03091b66');
    ctx.fillStyle = vignette;
    ctx.fillRect(-height / 2, -height * .43, height, height);
    ctx.restore();
  }

  drawWaterLight(ctx, cameraX, width, surface, size, time) {
    if (surface + 93 * size < 0) return;
    const start = cameraX - width / 2 / size, end = cameraX + width / 2 / size;
    for (let i = Math.floor((start - 70) / 20); i <= (end + 44) / 20; i++) {
      const seed = mod(i, WORLD_WIDTH / 20);
      const phase = random(seed * 67 + 11) * TAU;
      const x = width / 2 + (i * 20 + 13 * random(seed + 803) - cameraX + Math.sin(time * .19 + phase) * .83) * size;
      const length = (49 + 44 * random(seed * 97 + 19)) * size;
      const span = (13 + 16 * random(seed * 97 + 29)) * size;
      const lean = .32 + .1 * Math.cos(phase + time * .13);
      if (surface + length < 0 || x + length * lean + span / 2 < 0 || x - span / 2 > width) continue;
      ctx.save();
      ctx.globalAlpha = .52 + .23 * Math.sin(phase + time * .21);
      ctx.transform(1, 0, lean, 1, x, surface);
      ctx.drawImage(this.shaft, -span / 2, 0, span, length);
      ctx.restore();
    }
    if (surface + 6 * size < 0) return;
    const drift = Math.sin(time * .24) * .62;
    const tile = 40 * size;
    for (let x = -mod((start - drift) * size, tile); x < width; x += tile) {
      ctx.globalAlpha = .55;
      ctx.drawImage(this.caustics, x, surface, tile + .35, 5.15 * size);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#b9f7e48c';
    ctx.lineWidth = clamp(size * .065, 1, 2.2);
    ctx.beginPath();
    for (let x = 0; x <= width + 5; x += 5) {
      const phase = (start + x / size) * TAU / WORLD_WIDTH;
      const wave = (.09 + .05 * Math.sin(phase * 218 + time * .95) + .04 * Math.cos(phase * 137 - time * .73)) * size;
      if (x === 0) ctx.moveTo(x, surface + wave);
      else ctx.lineTo(x, surface + wave);
    }
    ctx.stroke();
  }

  drawMotes(ctx, camera, width, height, size, time) {
    ctx.fillStyle = '#b0eddf';
    for (let layer = 0; layer < 3; layer++) {
      const z = layer * 23, scale = size * perspective(z);
      const left = Math.floor((camera.x - width / 2 / scale) / 5) - 1;
      const right = Math.ceil((camera.x + width / 2 / scale) / 5) + 1;
      for (let column = left; column <= right; column++) {
        const seed = mod(column, WORLD_WIDTH / 5) + 241 * layer;
        for (let i = 0; i < 3; i++) {
          const rx = random(seed * 79 + i * 31 + 11), ry = random(seed * 73 + i * 17 + 103);
          const y = height / 2 + (ry * 87 + .21 * Math.cos(time * .43 + rx * TAU) - camera.y - PITCH * z) * scale;
          if (y < 0 || y > height) continue;
          const x = width / 2 + (column * 5 + rx * 5 - camera.x + .41 * Math.sin(time * .37 + ry * TAU)) * scale;
          const radius = clamp(scale * (.022 + rx * .062), .5, 2.15);
          ctx.globalAlpha = (.16 + rx * .33) * (1 - layer * .23);
          ctx.beginPath();
          ctx.ellipse(x, y, radius, radius * .69, -.37, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawFishLinks(renderer, world, characters, size, visible) {
    if (this.linkCharacters !== characters || this.linkWorld !== world) {
      this.linkCharacters = characters; this.linkWorld = world; this.fishLinks = [];
      const groups = new Map();
      for (const cell of characters) if (cell.kind === 'fish') {
        if (!groups.has(cell.entity)) groups.set(cell.entity, new Map());
        groups.get(cell.entity).set(`${cell.x},${cell.y}`, cell);
      }
      this.fishShapes.clear();
      for (const [id, cells] of groups) {
        const shape = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
        for (const cell of cells.values()) { shape.minX = Math.min(shape.minX, cell.x); shape.maxX = Math.max(shape.maxX, cell.x); shape.minY = Math.min(shape.minY, cell.y); shape.maxY = Math.max(shape.maxY, cell.y); }
        this.fishShapes.set(id, shape);
      }
      for (const cells of groups.values()) for (const cell of cells.values()) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const other = cells.get(`${cell.x + dx},${cell.y + dy}`); if (!other) continue;
        const color = beadTint(cell.color, [185, 235, 247], .2).replace('rgb(', 'rgba(').replace(')', `,${dx && dy ? .075 : .14})`);
        this.fishLinks.push({ cell, other, dx, dy, color });
      }
    }
    for (const [id, shape] of this.fishShapes) {
      const fish = world.data.fishes[id]; if (!fish) { this.fishSwim.delete(id); continue; }
      const sample = { x: fish.x + fish.facing * (shape.minX + shape.maxX) / 2, y: fish.y + (shape.minY + shape.maxY) / 2, facing: fish.facing, cx: fish.cx || 0, cy: fish.cy || 0 };
      this.fishSwim.set(id, advanceSwimMotion(this.fishSwim.get(id), sample, this.jellyTime));
    }
    for (const id of this.fishSwim.keys()) if (!this.fishShapes.has(id)) this.fishSwim.delete(id);
    this.fishPoses.clear();
    const ctx = renderer.ctx; ctx.save(); ctx.lineCap = 'round';
    for (const { cell, other, dx, dy, color } of this.fishLinks) {
      const fish = world.data.fishes[cell.entity]; if (!fish) continue;
      const p = { x: fish.x + fish.facing * cell.x, y: fish.y + cell.y }; if (!visible(p)) continue;
      const pixel = renderer.screen(p.x, p.y), a = this.fishPose(cell, fish.facing), b = this.fishPose(other, fish.facing);
      const ax = pixel.x + size * (.5 + a.offsetX), ay = pixel.y + size * (.5 + a.offsetY);
      const bx = pixel.x + size * (.5 + fish.facing * dx + b.offsetX), by = pixel.y + size * (.5 + dy + b.offsetY);
      const length = Math.hypot(bx - ax, by - ay), trim = .38 * size / length;
      ctx.strokeStyle = color; ctx.lineWidth = size * (dx && dy ? .12 : .17); ctx.beginPath();
      ctx.moveTo(ax + (bx - ax) * trim, ay + (by - ay) * trim);
      ctx.lineTo(bx - (bx - ax) * trim, by - (by - ay) * trim); ctx.stroke();
    }
    ctx.restore();
  }

  fishPose(cell, facing) {
    const reduced = Boolean(this.motion?.matches), frame = `${this.frameNumber}:${this.jellyTime}:${reduced}`;
    if (this.poseFrame !== frame) { this.poseFrame = frame; this.fishPoses.clear(); }
    const id = cell?.entity || 'fish', key = `${id}:${cell?.x || 0}:${cell?.y || 0}:${facing}`;
    if (this.fishPoses.has(key)) return this.fishPoses.get(key);
    if (!this.fishPhases.has(id)) { if (this.fishPhases.size >= 1024) this.fishPhases.delete(this.fishPhases.keys().next().value); this.fishPhases.set(id, jellyPhase(id)); }
    const phase = this.fishPhases.get(id), pose = jellyPose(this.jellyTime, phase, cell?.x || 0, cell?.y || 0, facing, reduced);
    const swim = swimPose(this.fishSwim.get(id), phase, cell?.x || 0, cell?.y || 0, this.fishShapes.get(id), facing, reduced);
    pose.offsetX += swim.offsetX; pose.offsetY += swim.offsetY; pose.rotation += swim.rotation;
    pose.scaleX *= swim.scaleX; pose.scaleY *= swim.scaleY; pose.inkX = swim.offsetX; pose.inkY = swim.offsetY;
    this.fishPoses.set(key, pose); return pose;
  }

  glyph(ctx, ch, color, x, y, size, alpha = 1, glow = false, kind = 'scene', cell = null, facing = 1) {
    const key = `${kind}:${ch}:${color}:${glow}`;
    let entry = this.glyphs.get(key);
    if (!entry && this.glyphBudget > 0) {
      if (this.glyphs.size >= GLYPH_LIMIT && this.trimmedFrame !== this.frameNumber) {
        this.trimmedFrame = this.frameNumber;
        for (const [cachedKey, cached] of this.glyphs) {
          if (cached.lastSeen < this.frameNumber - 1) this.glyphs.delete(cachedKey);
        }
      }
      if (this.glyphs.size < GLYPH_LIMIT) {
        this.glyphBudget--;
        entry = { sprite: glyphSprite(ch, color, glow, MATERIALS[kind] ?? MATERIALS.scene, kind), lastSeen: this.frameNumber };
        if (kind === 'fish') { entry.ink = canvas(SPRITE, SPRITE); drawJellyInk(entry.ink.getContext('2d'), ch, color, PAD, PAD, CELL); }
        this.glyphs.set(key, entry);
      }
    }
    ctx.globalAlpha = alpha;
    if (kind === 'fish') {
      const pose = this.fishPose(cell, facing);
      const scale = size / CELL, width = SPRITE * scale;
      if (entry) entry.lastSeen = this.frameNumber;
      ctx.save(); ctx.translate(x + size * (.5 + pose.offsetX), y + size * (.5 + pose.offsetY)); ctx.rotate(pose.rotation); ctx.scale(pose.scaleX, pose.scaleY);
      ctx.drawImage(entry?.sprite || this.jellyFallbacks[glow ? 1 : 0], -width / 2, -width / 2, width, width);
      ctx.globalAlpha = alpha * pose.sheen; ctx.drawImage(this.jellySheen, -width / 2, -width / 2, width, width); ctx.restore();
      // Glyphs follow the body bend without stretching or rotating their strokes.
      const inkX = x + pose.inkX * size, inkY = y + pose.inkY * size;
      if (entry?.ink) ctx.drawImage(entry.ink, inkX - PAD * scale, inkY - PAD * scale, width, width);
      else drawJellyInk(ctx, ch, color, inkX, inkY, size);
      ctx.globalAlpha = 1; return;
    }
    if (entry) {
      entry.lastSeen = this.frameNumber;
      const scale = size / CELL;
      ctx.drawImage(entry.sprite, x - PAD * scale, y - PAD * scale, SPRITE * scale, SPRITE * scale);
    } else {
      if (kind === 'fishPreview') {
        const scale = size / CELL;
        ctx.drawImage(this.jellyFallbacks[glow ? 1 : 0], x - PAD * scale, y - PAD * scale, SPRITE * scale, SPRITE * scale);
        drawJellyInk(ctx, ch, color, x, y, size); ctx.globalAlpha = 1; return;
      }
      if (BEAD_KINDS.has(kind)) {
        const scale = size / CELL;
        ctx.drawImage(this.beadFallbacks[glow ? 1 : 0], x - PAD * scale, y - PAD * scale, SPRITE * scale, SPRITE * scale);
      }
      ctx.font = `${Math.max(3, size * (BEAD_KINDS.has(kind) ? .52 : .85))}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(ch, x + size / 2, y + size / 2, BEAD_KINDS.has(kind) ? size * .56 : size);
    }
    ctx.globalAlpha = 1;
  }
}
