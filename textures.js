// ============================================================================
// TEXTURE SYSTEM FOR MEDITERRANEAN/TURKISH RESORT HOTEL 3D SCENE
// ============================================================================
// This file provides two approaches:
//   1. Remote CC0/Public Domain texture URLs from Poly Haven & ambientCG
//   2. Procedural fallback textures generated via Canvas (no external deps)
//
// All remote textures are CC0 (Public Domain) - free for any use.
// ============================================================================

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// SECTION 1: REMOTE TEXTURE URLs (CC0 / Public Domain)
// ---------------------------------------------------------------------------
// Source: Poly Haven (https://polyhaven.com) - CC0 License
// Source: ambientCG (https://ambientcg.com) - CC0 License
//
// Poly Haven direct URLs follow this pattern:
//   https://dl.polyhaven.org/file/ph-assets/Textures/jpg/{res}/{name}/{name}_diff_{res}.jpg
//
// NOTE: These URLs may have CORS restrictions when loaded directly in the
// browser. See the CORS proxy section below for workarounds.
// ---------------------------------------------------------------------------

export const TEXTURE_URLS = {
  // 1. Sand / Beach
  sand: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/coast_sand_04/coast_sand_04_diff_1k.jpg',
    // Alternative: sand_01 (smoother, lighter sand)
    alt: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/sand_01/sand_01_diff_1k.jpg',
    source: 'Poly Haven - Coast Sand 04 / Sand 01',
    license: 'CC0',
  },

  // 2. Grass / Lawn
  grass: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/leafy_grass/leafy_grass_diff_1k.jpg',
    source: 'Poly Haven - Leafy Grass',
    license: 'CC0',
  },

  // 3. Concrete / Pavement / Paths
  concrete: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/concrete_pavement/concrete_pavement_diff_1k.jpg',
    source: 'Poly Haven - Concrete Pavement',
    license: 'CC0',
  },

  // 4. Building Wall (White/Cream Mediterranean Plaster)
  wall: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/white_plaster_02/white_plaster_02_diff_1k.jpg',
    source: 'Poly Haven - White Plaster 02',
    license: 'CC0',
  },

  // 5. Roof Tiles (Terracotta / Orange)
  roof: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/clay_roof_tiles_02/clay_roof_tiles_02_diff_1k.jpg',
    source: 'Poly Haven - Clay Roof Tiles 02',
    license: 'CC0',
  },

  // 6. Water / Pool (procedural recommended - see below)
  // No single "pool water" diffuse texture on Poly Haven; procedural is better.

  // 7. Palm Tree Bark
  bark: {
    diffuse: 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/palm_tree_bark/palm_tree_bark_diff_1k.jpg',
    source: 'Poly Haven - Palm Tree Bark',
    license: 'CC0',
  },

  // 8. Sky HDRI (clear blue Mediterranean sky)
  sky: {
    hdr: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_43d_clear_puresky_1k.hdr',
    source: 'Poly Haven - Kloofendal 43d Clear (Pure Sky)',
    license: 'CC0',
  },
};


// ---------------------------------------------------------------------------
// SECTION 2: CORS PROXY HELPER
// ---------------------------------------------------------------------------
// Poly Haven CDN may not send Access-Control-Allow-Origin headers.
// Options:
//   A) Download textures locally and serve from your own server (best)
//   B) Use a CORS proxy for development
//   C) Use procedural textures (Section 3)
// ---------------------------------------------------------------------------

const CORS_PROXIES = [
  // For development only - do not use in production
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
];

/**
 * Wraps a URL with a CORS proxy for development use.
 * In production, serve textures from your own domain instead.
 */
export function withCorsProxy(url, proxyIndex = 0) {
  return CORS_PROXIES[proxyIndex] + encodeURIComponent(url);
}

/**
 * Loads a texture from a remote URL, optionally using a CORS proxy.
 * Falls back to a procedural texture if loading fails.
 */
export function loadTextureWithFallback(url, fallbackGenerator, options = {}) {
  const { useCorsProxy = false, repeat = null } = options;
  const loader = new THREE.TextureLoader();
  const finalUrl = useCorsProxy ? withCorsProxy(url) : url;

  return new Promise((resolve) => {
    loader.load(
      finalUrl,
      (texture) => {
        if (repeat) {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.repeat.set(repeat[0], repeat[1]);
        }
        resolve(texture);
      },
      undefined,
      () => {
        // Loading failed - use procedural fallback
        console.warn(`Failed to load texture from ${url}, using procedural fallback.`);
        const fallback = fallbackGenerator();
        if (repeat) {
          fallback.wrapS = THREE.RepeatWrapping;
          fallback.wrapT = THREE.RepeatWrapping;
          fallback.repeat.set(repeat[0], repeat[1]);
        }
        resolve(fallback);
      }
    );
  });
}


// ---------------------------------------------------------------------------
// SECTION 3: PROCEDURAL TEXTURE GENERATORS (Canvas-based, no dependencies)
// ---------------------------------------------------------------------------
// Each function creates a Canvas, draws a pattern, and returns a
// THREE.CanvasTexture. These work everywhere with zero CORS issues.
// ---------------------------------------------------------------------------

/**
 * Helper: creates a canvas context of the given size.
 */
function createCanvas(width = 512, height = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * Helper: simple seeded pseudo-random for reproducible noise.
 */
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}


// ---------------------------------------------------------------------------
// PROCEDURAL NORMAL MAP + ROUGHNESS MAP GENERATORS (Task #9)
// ---------------------------------------------------------------------------

/**
 * Generate a normal map from any canvas/image source using Sobel operator.
 * Returns a THREE.CanvasTexture with RGB normal data.
 */
export function generateNormalMap(source, strength = 1.5) {
  // Handle various source types
  let sourceCanvas;
  if (!source) {
    // No source provided – return flat normal map
    const { canvas, ctx } = createCanvas(64, 64);
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  if (source instanceof HTMLCanvasElement) {
    sourceCanvas = source;
  } else if (source instanceof HTMLImageElement) {
    sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = source.width || 256;
    sourceCanvas.height = source.height || 256;
    sourceCanvas.getContext('2d').drawImage(source, 0, 0);
  } else {
    // Fallback flat normal
    const { canvas, ctx } = createCanvas(64, 64);
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  const w = sourceCanvas.width, h = sourceCanvas.height;
  const srcCtx = sourceCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, w, h).data;

  const { canvas: outCanvas, ctx: outCtx } = createCanvas(w, h);
  const outData = outCtx.createImageData(w, h);
  const out = outData.data;

  // Convert to grayscale heightmap
  const heights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    heights[i] = (srcData[idx] * 0.299 + srcData[idx + 1] * 0.587 + srcData[idx + 2] * 0.114) / 255;
  }

  // Sobel filter to compute normals
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const l = heights[y * w + Math.max(0, x - 1)];
      const r = heights[y * w + Math.min(w - 1, x + 1)];
      const t = heights[Math.max(0, y - 1) * w + x];
      const b = heights[Math.min(h - 1, y + 1) * w + x];

      const dx = (r - l) * strength;
      const dy = (b - t) * strength;
      const dz = 1.0;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const oi = idx * 4;
      out[oi] = Math.floor((-dx / len * 0.5 + 0.5) * 255);
      out[oi + 1] = Math.floor((-dy / len * 0.5 + 0.5) * 255);
      out[oi + 2] = Math.floor((dz / len * 0.5 + 0.5) * 255);
      out[oi + 3] = 255;
    }
  }

  outCtx.putImageData(outData, 0, 0);
  const tex = new THREE.CanvasTexture(outCanvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Generate a roughness map from a diffuse canvas source.
 * Darker areas = rougher, lighter = smoother (inverted luminance).
 */
export function generateRoughnessMap(source) {
  if (!source || !(source instanceof HTMLCanvasElement)) {
    const { canvas, ctx } = createCanvas(64, 64);
    ctx.fillStyle = 'rgb(180, 180, 180)';
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  const w = source.width, h = source.height;
  const srcCtx = source.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, w, h);
  const data = srcData.data;

  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const roughness = 255 - lum * 0.4; // mostly rough with slight variation
    data[i] = data[i + 1] = data[i + 2] = Math.floor(roughness);
  }

  const { canvas: outCanvas, ctx: outCtx } = createCanvas(w, h);
  outCtx.putImageData(srcData, 0, 0);
  const tex = new THREE.CanvasTexture(outCanvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}


// ---- DAMASK WALLPAPER (Luxury Hotel Lobby Walls) ----

export function generateDamaskWallpaper(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(700);

  ctx.fillStyle = '#F5ECD7';
  ctx.fillRect(0, 0, size, size);

  // Linen grain
  const imgData = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < imgData.data.length; i += 4) {
    const n = (rand() - 0.5) * 10;
    imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + n));
    imgData.data[i+1] = Math.min(255, Math.max(0, imgData.data[i+1] + n));
    imgData.data[i+2] = Math.min(255, Math.max(0, imgData.data[i+2] + n - 2));
  }
  ctx.putImageData(imgData, 0, 0);

  function drawDamaskMotif(cx, cy, s) {
    ctx.save(); ctx.translate(cx, cy);
    // Central diamond
    ctx.fillStyle = 'rgba(201, 168, 76, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, -s*0.45);
    ctx.quadraticCurveTo(s*0.35, -s*0.15, s*0.3, 0);
    ctx.quadraticCurveTo(s*0.35, s*0.15, 0, s*0.45);
    ctx.quadraticCurveTo(-s*0.35, s*0.15, -s*0.3, 0);
    ctx.quadraticCurveTo(-s*0.35, -s*0.15, 0, -s*0.45);
    ctx.closePath(); ctx.fill();
    // Inner diamond
    ctx.fillStyle = 'rgba(160, 120, 48, 0.15)';
    ctx.beginPath();
    ctx.moveTo(0, -s*0.25);
    ctx.quadraticCurveTo(s*0.18, -s*0.08, s*0.15, 0);
    ctx.quadraticCurveTo(s*0.18, s*0.08, 0, s*0.25);
    ctx.quadraticCurveTo(-s*0.18, s*0.08, -s*0.15, 0);
    ctx.quadraticCurveTo(-s*0.18, -s*0.08, 0, -s*0.25);
    ctx.closePath(); ctx.fill();
    // Flourish scrolls
    ctx.strokeStyle = 'rgba(201, 168, 76, 0.14)';
    ctx.lineWidth = 1.5;
    for (let q = 0; q < 4; q++) {
      ctx.save(); ctx.rotate(q * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(s*0.15, -s*0.15);
      ctx.bezierCurveTo(s*0.35, -s*0.3, s*0.45, -s*0.1, s*0.3, s*0.05);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(s*0.32, -s*0.18, s*0.06, s*0.03, Math.PI/4, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(201, 168, 76, 0.1)'; ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(0, 0, s*0.04, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(160, 120, 48, 0.2)'; ctx.fill();
    ctx.restore();
  }

  const tileSize = size / 3;
  for (let row = -1; row < 5; row++) {
    for (let col = -1; col < 5; col++) {
      const ox = (row % 2) * (tileSize / 2);
      drawDamaskMotif(col * tileSize + ox, row * tileSize, tileSize);
    }
  }

  // Subtle vertical stripes
  for (let x = 0; x < size; x += 4) {
    ctx.fillStyle = x % 8 < 4 ? 'rgba(232, 213, 176, 0.04)' : 'rgba(200, 190, 170, 0.03)';
    ctx.fillRect(x, 0, 2, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- MARBLE TEXTURE (Carrara / Cream / Black-Gold) ----

export function generateMarbleTexture(size = 512, variant = 'carrara') {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(800);

  const V = {
    carrara:   { base: [240,237,232], v1: [158,154,148], v2: [200,196,190], noise: 8 },
    cream:     { base: [237,228,211], v1: [184,168,138], v2: [212,201,181], noise: 10 },
    blackGold: { base: [26,26,26],    v1: [201,168,76],  v2: [139,117,48],  noise: 6 },
  }[variant] || { base: [240,237,232], v1: [158,154,148], v2: [200,196,190], noise: 8 };

  ctx.fillStyle = `rgb(${V.base[0]},${V.base[1]},${V.base[2]})`;
  ctx.fillRect(0, 0, size, size);

  // Cloud patches
  for (let i = 0; i < 25; i++) {
    const x = rand() * size, y = rand() * size, r = 40 + rand() * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${V.v2[0]},${V.v2[1]},${V.v2[2]},0.08)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }

  // Veins
  let _veinDepth = 0;
  function drawVein(sx, sy, len, thick, col, alpha) {
    if (_veinDepth > 2 || len < 10) return; // prevent stack overflow
    _veinDepth++;
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
    ctx.lineWidth = thick; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy);
    let cx = sx, cy = sy;
    const segs = 4 + Math.floor(rand() * 4), segL = len / segs;
    for (let i = 0; i < segs; i++) {
      const a = (rand() - 0.5) * 1.2;
      const nx = cx + Math.cos(a) * segL + (rand()-0.5)*30;
      const ny = cy + Math.sin(a) * segL + (rand()-0.5)*40;
      ctx.quadraticCurveTo((cx+nx)/2+(rand()-0.5)*40, (cy+ny)/2+(rand()-0.5)*40, nx, ny);
      cx = nx; cy = ny;
      if (rand() > 0.7 && _veinDepth < 2) {
        ctx.stroke();
        drawVein(cx, cy, len*0.3, thick*0.4, col, alpha*0.6);
        ctx.beginPath(); ctx.moveTo(cx, cy);
      }
    }
    ctx.stroke();
    _veinDepth--;
  }

  for (let i = 0; i < 3 + Math.floor(rand()*4); i++)
    drawVein(rand()*size*0.3, rand()*size, size*1.2, 1.5+rand()*2.5, V.v1, 0.25+rand()*0.2);
  for (let i = 0; i < 6 + Math.floor(rand()*4); i++)
    drawVein(rand()*size, rand()*size, size*0.5, 0.5+rand(), V.v2, 0.12+rand()*0.15);

  // Noise grain
  const fd = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < fd.data.length; i += 4) {
    const n = (rand()-0.5) * V.noise;
    fd.data[i] = Math.min(255, Math.max(0, fd.data[i]+n));
    fd.data[i+1] = Math.min(255, Math.max(0, fd.data[i+1]+n));
    fd.data[i+2] = Math.min(255, Math.max(0, fd.data[i+2]+n));
  }
  ctx.putImageData(fd, 0, 0);

  // Polish sheen
  const sh = ctx.createLinearGradient(0, 0, size, size);
  sh.addColorStop(0, 'rgba(255,255,255,0)');
  sh.addColorStop(0.45, 'rgba(255,255,255,0.03)');
  sh.addColorStop(0.55, 'rgba(255,255,255,0.06)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh; ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- WOOD GRAIN TEXTURE (Walnut / Mahogany / Oak) ----

export function generateWoodTexture(size = 512, variant = 'walnut') {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(900);

  const V = {
    walnut:   { base: [62,39,35], dark: [42,27,18], light: [93,64,55] },
    mahogany: { base: [78,26,14], dark: [59,14,6],  light: [109,46,26] },
    oak:      { base: [196,162,101], dark: [160,128,80], light: [222,192,136] },
  }[variant] || { base: [62,39,35], dark: [42,27,18], light: [93,64,55] };

  // Grain lines
  for (let y = 0; y < size; y++) {
    const grain = Math.sin(y*0.08)*0.3 + Math.sin(y*0.23+1.5)*0.2 + Math.sin(y*0.51+3)*0.1 + (rand()-0.5)*0.15;
    const t = Math.max(0, Math.min(1, grain + 0.5));
    const r = Math.floor(V.dark[0] + (V.light[0]-V.dark[0]) * t);
    const g = Math.floor(V.dark[1] + (V.light[1]-V.dark[1]) * t);
    const b = Math.floor(V.dark[2] + (V.light[2]-V.dark[2]) * t);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, size, 1);
  }

  // Wave distortion
  const src = ctx.getImageData(0, 0, size, size);
  const srcD = new Uint8ClampedArray(src.data);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const wo = Math.sin(py*0.02 + px*0.005)*8 + Math.sin(py*0.05)*4;
      const sx = Math.max(0, Math.min(size-1, Math.floor(px + wo)));
      const di = (py*size+px)*4, si = (py*size+sx)*4;
      src.data[di] = srcD[si]; src.data[di+1] = srcD[si+1]; src.data[di+2] = srcD[si+2];
    }
  }
  ctx.putImageData(src, 0, 0);

  // Dark grain streaks
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < 30; i++) {
    const y = rand() * size;
    ctx.strokeStyle = `rgb(${V.dark[0]},${V.dark[1]},${V.dark[2]})`;
    ctx.lineWidth = 0.5 + rand() * 2;
    ctx.beginPath(); ctx.moveTo(0, y);
    let cx = 0;
    while (cx < size) { cx += 20 + rand()*40; ctx.lineTo(cx, y + (rand()-0.5)*6); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Optional knot
  if (rand() > 0.5) {
    const kx = size*0.3 + rand()*size*0.4, ky = size*0.3 + rand()*size*0.4, kr = 8 + rand()*15;
    for (let ring = 0; ring < 6; ring++) {
      ctx.strokeStyle = `rgba(${V.dark[0]},${V.dark[1]},${V.dark[2]},${0.15-ring*0.02})`;
      ctx.lineWidth = 1; ctx.beginPath();
      ctx.ellipse(kx, ky, kr+ring*3, (kr+ring*3)*0.6, 0, 0, Math.PI*2); ctx.stroke();
    }
    const kg = ctx.createRadialGradient(kx, ky, 0, kx, ky, kr);
    kg.addColorStop(0, `rgba(${V.dark[0]},${V.dark[1]},${V.dark[2]},0.4)`);
    kg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = kg; ctx.fillRect(kx-kr*2, ky-kr*2, kr*4, kr*4);
  }

  // Pore noise
  const fd = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < fd.data.length; i += 4) {
    const n = (rand()-0.5)*8;
    fd.data[i] = Math.min(255, Math.max(0, fd.data[i]+n));
    fd.data[i+1] = Math.min(255, Math.max(0, fd.data[i+1]+n));
    fd.data[i+2] = Math.min(255, Math.max(0, fd.data[i+2]+n));
  }
  ctx.putImageData(fd, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 1. SAND / BEACH TEXTURE ----

export function generateSandTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(42);

  // Base sandy color
  ctx.fillStyle = '#e8d5a3';
  ctx.fillRect(0, 0, size, size);

  // Layer noise grain to simulate sand particles
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 40;
    const warmShift = (rand() - 0.5) * 15;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise + warmShift));     // R
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));             // G
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise - warmShift)); // B
  }
  ctx.putImageData(imageData, 0, 0);

  // Subtle darker patches (wet sand feel)
  for (let i = 0; i < 20; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 20 + rand() * 60;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, 'rgba(180, 160, 120, 0.15)');
    gradient.addColorStop(1, 'rgba(180, 160, 120, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 2. GRASS / LAWN TEXTURE ----

export function generateGrassTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(101);

  // Base green
  ctx.fillStyle = '#3a7d2c';
  ctx.fillRect(0, 0, size, size);

  // Draw many short grass blade strokes
  for (let i = 0; i < 8000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const length = 4 + rand() * 12;
    const angle = -Math.PI / 2 + (rand() - 0.5) * 0.8;
    const green = 80 + Math.floor(rand() * 100);
    const red = 30 + Math.floor(rand() * 50);
    ctx.strokeStyle = `rgb(${red}, ${green}, ${Math.floor(red * 0.4)})`;
    ctx.lineWidth = 1 + rand() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  // Subtle yellow-brown patches
  for (let i = 0; i < 10; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 15 + rand() * 40;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, 'rgba(120, 130, 50, 0.2)');
    gradient.addColorStop(1, 'rgba(120, 130, 50, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 3. CONCRETE / PAVEMENT TEXTURE ----

export function generateConcreteTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(200);

  // Base grey
  ctx.fillStyle = '#b0a898';
  ctx.fillRect(0, 0, size, size);

  // Add noise for rough concrete feel
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 35;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  // Draw subtle paving stone grid lines
  ctx.strokeStyle = 'rgba(100, 90, 80, 0.25)';
  ctx.lineWidth = 2;
  const tileSize = size / 4;
  for (let x = 0; x <= size; x += tileSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  for (let y = 0; y <= size; y += tileSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // Add some darker stain spots
  for (let i = 0; i < 15; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 5 + rand() * 25;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, 'rgba(80, 75, 70, 0.12)');
    gradient.addColorStop(1, 'rgba(80, 75, 70, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 4. BUILDING WALL (White/Cream Mediterranean Plaster) ----

export function generateWallTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(303);

  // Warm white/cream base
  ctx.fillStyle = '#f2ece0';
  ctx.fillRect(0, 0, size, size);

  // Fine plaster grain
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 18;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise - 3));
  }
  ctx.putImageData(imageData, 0, 0);

  // Subtle trowel stroke marks
  ctx.globalAlpha = 0.04;
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const w = 40 + rand() * 120;
    const h = 2 + rand() * 4;
    const angle = (rand() - 0.5) * 0.3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = rand() > 0.5 ? '#d6cfc0' : '#faf5ea';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.globalAlpha = 1.0;

  // Light weathering / staining at bottom
  const weatherGrad = ctx.createLinearGradient(0, size * 0.7, 0, size);
  weatherGrad.addColorStop(0, 'rgba(180, 170, 150, 0)');
  weatherGrad.addColorStop(1, 'rgba(180, 170, 150, 0.08)');
  ctx.fillStyle = weatherGrad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 5. ROOF TILE (Terracotta / Orange) ----

export function generateRoofTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(404);

  // Terracotta base
  ctx.fillStyle = '#c2623a';
  ctx.fillRect(0, 0, size, size);

  // Draw overlapping curved tile rows
  const tileRows = 8;
  const tileH = size / tileRows;
  const tileCols = 6;
  const tileW = size / tileCols;

  for (let row = 0; row < tileRows; row++) {
    const offset = (row % 2) * (tileW / 2); // stagger alternate rows
    for (let col = -1; col <= tileCols; col++) {
      const x = col * tileW + offset;
      const y = row * tileH;

      // Individual tile color variation
      const r = 170 + Math.floor(rand() * 40);
      const g = 80 + Math.floor(rand() * 30);
      const b = 40 + Math.floor(rand() * 25);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

      // Draw a rounded tile shape
      ctx.beginPath();
      ctx.moveTo(x, y + tileH * 0.2);
      ctx.quadraticCurveTo(x + tileW / 2, y - tileH * 0.1, x + tileW, y + tileH * 0.2);
      ctx.lineTo(x + tileW, y + tileH);
      ctx.lineTo(x, y + tileH);
      ctx.closePath();
      ctx.fill();

      // Shadow under each tile
      ctx.strokeStyle = 'rgba(80, 30, 10, 0.3)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + tileH * 0.2);
      ctx.quadraticCurveTo(x + tileW / 2, y - tileH * 0.1, x + tileW, y + tileH * 0.2);
      ctx.stroke();
    }
  }

  // Add subtle grain
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 15;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 6. WATER / POOL TEXTURE ----

export function generateWaterTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(505);

  // Deep pool blue base
  ctx.fillStyle = '#1a8fa8';
  ctx.fillRect(0, 0, size, size);

  // Caustic-like light patterns (overlapping bright ellipses)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 60; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const rx = 10 + rand() * 50;
    const ry = 5 + rand() * 30;
    const angle = rand() * Math.PI;
    const alpha = 0.02 + rand() * 0.06;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(140, 220, 255, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Bright caustic lines (like refracted light on pool floor)
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    const startX = rand() * size;
    const startY = rand() * size;
    ctx.strokeStyle = `rgba(180, 240, 255, ${0.03 + rand() * 0.06})`;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    let cx = startX;
    let cy = startY;
    for (let seg = 0; seg < 4; seg++) {
      cx += (rand() - 0.5) * 80;
      cy += (rand() - 0.5) * 80;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Soft wave ripple overlay
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      const wave = Math.sin(px * 0.05 + py * 0.03) * 8 +
                   Math.sin(px * 0.03 - py * 0.05) * 6;
      data[i]     = Math.min(255, Math.max(0, data[i] + wave));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + wave));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + wave * 0.5));
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 7. PALM TREE BARK TEXTURE ----

export function generateBarkTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(606);

  // Dark brown bark base
  ctx.fillStyle = '#5a3e28';
  ctx.fillRect(0, 0, size, size);

  // Horizontal bark ring segments (palm trunk characteristic)
  const ringCount = 20;
  const ringHeight = size / ringCount;
  for (let i = 0; i < ringCount; i++) {
    const y = i * ringHeight;
    const brightness = 70 + Math.floor(rand() * 30);
    const r = brightness;
    const g = Math.floor(brightness * 0.7);
    const b = Math.floor(brightness * 0.45);

    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, y, size, ringHeight - 2);

    // Dark groove between rings
    ctx.fillStyle = 'rgba(30, 18, 10, 0.6)';
    ctx.fillRect(0, y + ringHeight - 3, size, 3);

    // Ridge highlight at top of each ring
    ctx.fillStyle = 'rgba(160, 120, 80, 0.15)';
    ctx.fillRect(0, y, size, 2);
  }

  // Vertical fiber lines
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 100; i++) {
    const x = rand() * size;
    ctx.strokeStyle = rand() > 0.5 ? '#3a2518' : '#8a6a48';
    ctx.lineWidth = 0.5 + rand();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rand() - 0.5) * 10, size);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;

  // Final noise grain
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 20;
    data[i]     = Math.min(255, Math.max(0, data[i] + noise));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---- 8. SKY - Gradient approach (no skybox needed) ----

/**
 * Creates a vertical gradient sky texture.
 * For a Mediterranean scene, this gives a warm blue sky fading to hazy horizon.
 * Apply to a large sphere or use as scene.background.
 */
export function generateSkyTexture(width = 512, height = 1024) {
  const { canvas, ctx } = createCanvas(width, height);

  // Mediterranean sky gradient: deep blue zenith -> light blue -> warm horizon haze
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0.0, '#1a3a6a');   // deep blue at zenith
  gradient.addColorStop(0.2, '#3a7abf');   // rich blue
  gradient.addColorStop(0.5, '#6aaee8');   // medium blue
  gradient.addColorStop(0.75, '#a8d4f0');  // light blue
  gradient.addColorStop(0.9, '#e0e8e8');   // hazy whitish horizon
  gradient.addColorStop(1.0, '#f5efe4');   // warm horizon (slight yellow tint)

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  // For mapping onto a sphere or hemisphere:
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

/**
 * Sky with sun disc, glow halo, and animated procedural clouds.
 * Returns { mesh, uniforms } so the animation loop can update time.
 */
export function applySkyGradient(scene) {
  const vertexShader = `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    uniform vec3 horizonColor;
    uniform float offset;
    uniform float exponent;
    uniform vec3 sunDirection;
    uniform vec3 sunColor;
    uniform float sunIntensity;
    uniform float time;
    uniform float cloudDensity;
    uniform float nightMix; // 0=day, 1=night
    uniform vec3 moonDirection;
    varying vec3 vWorldPosition;

    // Hash-based 2D noise
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f); // smoothstep
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      v += noise(p) * 0.5;
      v += noise(p * 2.1 + vec2(1.7, 3.2)) * 0.25;
      v += noise(p * 4.3 + vec2(5.1, 1.3)) * 0.125;
      return v;
    }

    void main() {
      vec3 dir = normalize(vWorldPosition + offset);
      float h = dir.y;

      // === DAY SKY ===
      vec3 dayColor;
      if (h > 0.0) {
        float t = pow(h, exponent);
        dayColor = mix(horizonColor, topColor, t);
      } else {
        dayColor = mix(horizonColor, bottomColor, pow(-h, 0.5));
      }

      // Sun disc and glow
      if (h > -0.05 && sunIntensity > 0.1) {
        float sunDot = dot(dir, sunDirection);
        float disc = smoothstep(0.9993, 0.9998, sunDot);
        dayColor = mix(dayColor, sunColor * sunIntensity, disc);
        float glow = pow(max(sunDot, 0.0), 256.0) * 0.8 + pow(max(sunDot, 0.0), 32.0) * 0.15;
        dayColor += sunColor * glow;
      }

      // Clouds (day only)
      if (h > 0.02 && nightMix < 0.5) {
        vec2 uv = dir.xz / (h + 0.1) * 1.5;
        float cloudVal = fbm(uv * 3.0 + time * 0.015);
        float cloud = smoothstep(cloudDensity, cloudDensity + 0.2, cloudVal);
        cloud *= smoothstep(0.02, 0.15, h);
        cloud *= (1.0 - nightMix * 2.0); // fade out clouds towards night
        vec3 cloudColor = mix(vec3(0.95, 0.95, 0.97), sunColor * 0.9, pow(max(dot(dir, sunDirection), 0.0), 4.0) * 0.3);
        dayColor = mix(dayColor, cloudColor, cloud * 0.75);
      }

      // === NIGHT SKY (almost black) ===
      vec3 nightColor = vec3(0.005, 0.005, 0.015);
      if (h > 0.0) {
        nightColor = mix(vec3(0.008, 0.008, 0.02), vec3(0.003, 0.003, 0.01), pow(h, 0.5));
      }

      // Stars (soft round dots with distance falloff)
      if (h > 0.05) {
        vec2 starUV = dir.xz / (h + 0.05) * 12.0;
        vec2 cell = floor(starUV);
        vec2 frac = fract(starUV) - 0.5; // -0.5..0.5 within cell
        float rng = hash(cell);
        if (rng > 0.992) { // sparse stars
          // Random offset within cell so stars aren't grid-aligned
          vec2 offset = vec2(hash(cell + 10.0), hash(cell + 20.0)) - 0.5;
          float dist = length(frac - offset * 0.4);
          // Soft circular falloff (not a hard square)
          float brightness = (0.3 + 0.6 * hash(cell + 50.0));
          float star = brightness * smoothstep(0.15, 0.0, dist);
          // Fade near horizon
          star *= smoothstep(0.05, 0.2, h);
          // Twinkle
          star *= 0.7 + 0.3 * sin(time * 1.5 + rng * 20.0);
          nightColor += vec3(star * 0.8, star * 0.8, star * 0.95);
        }
      }

      // Moon disc (bright white-yellow)
      if (h > -0.05) {
        float moonDot = dot(dir, moonDirection);
        float moonDisc = smoothstep(0.9988, 0.9996, moonDot);
        vec3 moonColor = vec3(1.0, 0.98, 0.85);
        nightColor = mix(nightColor, moonColor, moonDisc);
        // Moon glow halo
        float moonGlow = pow(max(moonDot, 0.0), 64.0) * 0.15 + pow(max(moonDot, 0.0), 8.0) * 0.04;
        nightColor += vec3(0.15, 0.15, 0.2) * moonGlow;
      }

      // === MIX DAY/NIGHT ===
      vec3 finalColor = mix(dayColor, nightColor, nightMix);
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  const uniforms = {
    topColor:     { value: new THREE.Color(0x1a5aaa) },
    horizonColor: { value: new THREE.Color(0xc8dce8) },
    bottomColor:  { value: new THREE.Color(0xe8dcc8) },
    offset:       { value: 10 },
    exponent:     { value: 0.6 },
    sunDirection: { value: new THREE.Vector3(100, 120, 80).normalize() },
    sunColor:     { value: new THREE.Color(0xffffdd) },
    sunIntensity: { value: 1.8 },
    time:         { value: 0 },
    cloudDensity: { value: 0.38 },
    nightMix:     { value: 0 },  // 0=day, 1=night
    moonDirection: { value: new THREE.Vector3(-0.5, 0.7, -0.3).normalize() },
  };

  const skyGeo = new THREE.SphereGeometry(500, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });

  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  scene.add(sky);
  return { mesh: sky, uniforms };
}


// ---------------------------------------------------------------------------
// WATER SHADER MATERIAL (animated pool water)
// ---------------------------------------------------------------------------

/**
 * Creates a custom ShaderMaterial for pool water with animated waves,
 * Fresnel reflections, caustics, and transparency.
 */
export function createWaterShaderMaterial() {
  const vertexShader = `
    uniform float time;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
      vUv = uv;
      vec3 pos = position;
      // Gentle wave displacement
      pos.z += sin(pos.x * 1.5 + time * 1.2) * 0.04
             + cos(pos.y * 2.0 + time * 0.9) * 0.03
             + sin((pos.x + pos.y) * 0.8 + time * 1.5) * 0.02;

      vec4 worldPos = modelMatrix * vec4(pos, 1.0);
      vWorldPos = worldPos.xyz;
      vNormal = normalize(normalMatrix * normal);

      vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
      vViewDir = -mvPos.xyz;

      gl_Position = projectionMatrix * mvPos;
    }
  `;

  const fragmentShader = `
    uniform float time;
    uniform vec3 waterColor;
    uniform vec3 deepColor;
    uniform vec3 skyColor;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying vec3 vViewDir;

    // Caustic pattern
    float caustic(vec2 p, float t) {
      float v = 0.0;
      v += sin(p.x * 3.7 + t * 1.1) * sin(p.y * 4.1 + t * 0.8) * 0.5;
      v += sin(p.x * 7.3 - t * 0.9) * sin(p.y * 5.9 + t * 1.3) * 0.25;
      v += sin((p.x + p.y) * 9.1 + t * 1.7) * 0.125;
      return v * 0.5 + 0.5;
    }

    void main() {
      vec3 viewDir = normalize(vViewDir);
      vec3 normal = normalize(vNormal);

      // Animated normal perturbation (ripples)
      float nx = sin(vWorldPos.x * 2.0 + time * 1.5) * 0.3
               + cos(vWorldPos.z * 3.0 + time * 1.1) * 0.2;
      float ny = cos(vWorldPos.x * 2.5 + time * 0.8) * 0.25
               + sin(vWorldPos.z * 1.8 + time * 1.4) * 0.2;
      vec3 perturbedNormal = normalize(normal + vec3(nx, 0.0, ny) * 0.15);

      // Fresnel
      float fresnel = pow(1.0 - max(dot(viewDir, perturbedNormal), 0.0), 3.0);
      fresnel = clamp(fresnel, 0.05, 0.95);

      // Caustics on pool floor
      vec2 causticUV = vWorldPos.xz * 0.15;
      float c = caustic(causticUV, time);
      vec3 causticColor = vec3(0.4, 0.8, 0.9) * c * 0.3;

      // Base water color with depth variation
      vec3 base = mix(deepColor, waterColor, 0.6 + sin(vWorldPos.x * 0.5 + vWorldPos.z * 0.3) * 0.1);
      base += causticColor;

      // Fake sky reflection
      vec3 reflected = reflect(-viewDir, perturbedNormal);
      float skyBlend = smoothstep(-0.1, 0.5, reflected.y);
      vec3 reflColor = mix(vec3(0.7, 0.8, 0.85), skyColor, skyBlend);

      // Combine: base + fresnel reflection
      vec3 finalColor = mix(base, reflColor, fresnel * 0.6);

      // Specular highlight (sun)
      vec3 sunDir = normalize(vec3(0.53, 0.64, 0.43)); // matches directional light
      float spec = pow(max(dot(reflect(-sunDir, perturbedNormal), viewDir), 0.0), 64.0);
      finalColor += vec3(1.0, 0.98, 0.9) * spec * 0.7;

      // Alpha: more opaque at edges (fresnel), more transparent looking down
      float alpha = mix(0.65, 0.92, fresnel);

      gl_FragColor = vec4(finalColor, alpha);
    }
  `;

  const uniforms = {
    time:       { value: 0 },
    waterColor: { value: new THREE.Color(0x1a9ab5) },
    deepColor:  { value: new THREE.Color(0x0a4a5a) },
    skyColor:   { value: new THREE.Color(0x6aaee8) },
  };

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}


// ---------------------------------------------------------------------------
// LOBBY FLOOR TEXTURE (marble/tile checkerboard)
// ---------------------------------------------------------------------------

export function generateLobbyFloorTexture(size = 512) {
  const { canvas, ctx } = createCanvas(size, size);
  const rand = seededRandom(707);

  const tileCount = 8;
  const tileSize = size / tileCount;

  for (let row = 0; row < tileCount; row++) {
    for (let col = 0; col < tileCount; col++) {
      const isLight = (row + col) % 2 === 0;
      const base = isLight ? [235, 225, 210] : [190, 175, 155];
      // Slight color variation per tile
      const r = base[0] + (rand() - 0.5) * 15;
      const g = base[1] + (rand() - 0.5) * 15;
      const b = base[2] + (rand() - 0.5) * 10;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize);

      // Marble veining
      ctx.globalAlpha = 0.06;
      for (let v = 0; v < 3; v++) {
        const vx = col * tileSize + rand() * tileSize;
        const vy = row * tileSize + rand() * tileSize;
        ctx.strokeStyle = isLight ? '#baa98a' : '#8a7a6a';
        ctx.lineWidth = 0.5 + rand() * 1.5;
        ctx.beginPath();
        ctx.moveTo(vx, vy);
        ctx.quadraticCurveTo(
          vx + (rand() - 0.5) * tileSize * 0.8,
          vy + (rand() - 0.5) * tileSize * 0.5,
          vx + (rand() - 0.5) * tileSize,
          vy + (rand() - 0.5) * tileSize
        );
        ctx.stroke();
      }
      ctx.globalAlpha = 1.0;

      // Grout line
      ctx.strokeStyle = 'rgba(120,110,100,0.3)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(col * tileSize, row * tileSize, tileSize, tileSize);
    }
  }

  // Subtle sheen/polish effect
  const sheen = ctx.createRadialGradient(size * 0.4, size * 0.4, 0, size * 0.4, size * 0.4, size * 0.7);
  sheen.addColorStop(0, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.02)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}


// ---------------------------------------------------------------------------
// SECTION 4: CONVENIENCE - Load all textures with automatic fallback
// ---------------------------------------------------------------------------

/**
 * Returns an object of textures, attempting remote URLs first and falling
 * back to procedural if they fail.
 *
 * Usage:
 *   const textures = await loadAllTextures({ useCorsProxy: false });
 *   myMesh.material.map = textures.sand;
 */
export async function loadAllTextures(options = {}) {
  const { useCorsProxy = false } = options;

  const [sand, grass, concrete, wall, roof, bark] = await Promise.all([
    loadTextureWithFallback(TEXTURE_URLS.sand.diffuse, generateSandTexture, { useCorsProxy, repeat: [4, 4] }),
    loadTextureWithFallback(TEXTURE_URLS.grass.diffuse, generateGrassTexture, { useCorsProxy, repeat: [6, 6] }),
    loadTextureWithFallback(TEXTURE_URLS.concrete.diffuse, generateConcreteTexture, { useCorsProxy, repeat: [4, 4] }),
    loadTextureWithFallback(TEXTURE_URLS.wall.diffuse, generateWallTexture, { useCorsProxy, repeat: [2, 2] }),
    loadTextureWithFallback(TEXTURE_URLS.roof.diffuse, generateRoofTexture, { useCorsProxy, repeat: [3, 3] }),
    loadTextureWithFallback(TEXTURE_URLS.bark.diffuse, generateBarkTexture, { useCorsProxy, repeat: [1, 2] }),
  ]);

  // Water and sky are always procedural (better results for these)
  const water = generateWaterTexture();
  water.wrapS = THREE.RepeatWrapping;
  water.wrapT = THREE.RepeatWrapping;
  water.repeat.set(2, 2);

  const sky = generateSkyTexture();

  return { sand, grass, concrete, wall, roof, water, bark, sky };
}


// ---------------------------------------------------------------------------
// SECTION 5: QUICK-START - Procedural only (zero network requests)
// ---------------------------------------------------------------------------

/**
 * Returns all textures as procedural Canvas textures immediately.
 * Use this if you want zero loading time and no network dependency.
 *
 * Usage:
 *   const textures = generateAllTextures();
 *   ground.material.map = textures.sand;
 */
export function generateAllTextures() {
  const sand = generateSandTexture();
  sand.wrapS = THREE.RepeatWrapping;
  sand.wrapT = THREE.RepeatWrapping;
  sand.repeat.set(4, 4);

  const grass = generateGrassTexture();
  grass.wrapS = THREE.RepeatWrapping;
  grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(6, 6);

  const concrete = generateConcreteTexture();
  concrete.wrapS = THREE.RepeatWrapping;
  concrete.wrapT = THREE.RepeatWrapping;
  concrete.repeat.set(4, 4);

  const wall = generateWallTexture();
  wall.wrapS = THREE.RepeatWrapping;
  wall.wrapT = THREE.RepeatWrapping;
  wall.repeat.set(2, 2);

  const roof = generateRoofTexture();
  roof.wrapS = THREE.RepeatWrapping;
  roof.wrapT = THREE.RepeatWrapping;
  roof.repeat.set(3, 3);

  const water = generateWaterTexture();
  water.wrapS = THREE.RepeatWrapping;
  water.wrapT = THREE.RepeatWrapping;
  water.repeat.set(2, 2);

  const bark = generateBarkTexture();
  bark.wrapS = THREE.RepeatWrapping;
  bark.wrapT = THREE.RepeatWrapping;
  bark.repeat.set(1, 2);

  const sky = generateSkyTexture();

  const lobbyFloor = generateLobbyFloorTexture();
  lobbyFloor.wrapS = THREE.RepeatWrapping;
  lobbyFloor.wrapT = THREE.RepeatWrapping;
  lobbyFloor.repeat.set(4, 4);

  const damask = generateDamaskWallpaper();
  damask.wrapS = THREE.RepeatWrapping;
  damask.wrapT = THREE.RepeatWrapping;

  const marble = generateMarbleTexture(512, 'carrara');
  marble.wrapS = THREE.RepeatWrapping;
  marble.wrapT = THREE.RepeatWrapping;

  const woodWalnut = generateWoodTexture(512, 'walnut');
  woodWalnut.wrapS = THREE.RepeatWrapping;
  woodWalnut.wrapT = THREE.RepeatWrapping;

  const woodOak = generateWoodTexture(512, 'oak');
  woodOak.wrapS = THREE.RepeatWrapping;
  woodOak.wrapT = THREE.RepeatWrapping;

  return { sand, grass, concrete, wall, roof, water, bark, sky, lobbyFloor, damask, marble, woodWalnut, woodOak };
}
