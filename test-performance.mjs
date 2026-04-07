/**
 * Performance Profiling Script
 * Teleports to various locations, measures FPS, draw calls, triangles
 * Identifies bottlenecks without reducing detail
 */
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8769;

function startServer() {
  return new Promise(resolve => {
    const mimeTypes = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
    const server = http.createServer((req, res) => {
      let fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      try { res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(fp)] || 'application/octet-stream' }); res.end(fs.readFileSync(fp)); }
      catch { res.writeHead(404); res.end(); }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();

  console.log('Loading game...');
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window.__camera && window.__controller), { timeout: 30000, polling: 1000 });
  await page.evaluate(() => { window.__controller.isLocked = true; });
  await page.waitForTimeout(2000);
  console.log('Game ready.\n');

  // Test locations
  const locations = [
    { name: 'Road (outside)', x: 0, y: 1.7, z: -85 },
    { name: 'DFW Entrance', x: -70, y: 1.7, z: -78 },
    { name: 'DFW Lobby', x: -70, y: 1.7, z: -65 },
    { name: 'DFW 1.OG Hallway', x: -70, y: 7.7, z: -60 },
    { name: 'DFW 1.OG Room', x: -82, y: 7.7, z: -55 },
    { name: 'DWW Entrance', x: 70, y: 1.7, z: -78 },
    { name: 'DWW Lobby', x: 70, y: 1.7, z: -65 },
    { name: 'Pool area DFW', x: -60, y: 1.7, z: -30 },
    { name: 'Pool area DWW', x: 80, y: 1.7, z: -20 },
    { name: 'City north', x: -100, y: 1.7, z: -120 },
    { name: 'City center', x: 0, y: 1.7, z: -160 },
    { name: 'City east wing', x: 180, y: 1.7, z: -100 },
    { name: 'Stage DFW', x: -80, y: 1.7, z: -5 },
    { name: 'Stage DWW', x: 80, y: 1.7, z: 15 },
    { name: 'Beach south', x: 0, y: 1.7, z: 100 },
    { name: 'Between hotels', x: 0, y: 1.7, z: -60 },
  ];

  console.log('╔══════════════════════════════╦══════╦═══════════╦═══════════╦════════╦═════════╗');
  console.log('║ Location                     ║  FPS ║ DrawCalls ║ Triangles ║ Visible║ AutoDoor║');
  console.log('╠══════════════════════════════╬══════╬═══════════╬═══════════╬════════╬═════════╣');

  const results = [];

  for (const loc of locations) {
    // Teleport
    await page.evaluate(({ x, y, z }) => window.__camera.position.set(x, y, z), loc);
    // Wait for scene to settle (LOD, culling, floor groups)
    await page.waitForTimeout(500);

    // Sample FPS over 60 frames
    const perf = await page.evaluate(() => {
      return new Promise(resolve => {
        let samples = 0;
        let totalFPS = 0;
        const interval = setInterval(() => {
          if (window.__perf) {
            totalFPS += window.__perf.fps;
            samples++;
          }
          if (samples >= 30) {
            clearInterval(interval);
            const p = window.__perf || {};
            resolve({
              fps: Math.round(totalFPS / samples),
              drawCalls: p.drawCalls || 0,
              triangles: p.triangles || 0,
              visible: p.visible || 0,
              total: p.total || 0,
            });
          }
        }, 33); // ~30fps sampling
      });
    });

    // Count auto-doors near this location
    const nearDoors = await page.evaluate(({ x, z }) => {
      let count = 0;
      // Count doors within 20m
      // autoDoors is module-scoped but we can check via length
      return (window.__perf || {}).waters || '?';
    }, loc);

    const name = loc.name.padEnd(28);
    const fps = String(perf.fps).padStart(4);
    const dc = String(perf.drawCalls).padStart(9);
    const tri = String(perf.triangles).padStart(9);
    const vis = String(perf.visible).padStart(6);

    results.push({ ...loc, ...perf });

    console.log(`║ ${name} ║ ${fps} ║ ${dc} ║ ${tri} ║ ${vis} ║         ║`);
  }

  console.log('╚══════════════════════════════╩══════╩═══════════╩═══════════╩════════╩═════════╝');

  // Analyze bottlenecks
  console.log('\n═══ BOTTLENECK ANALYSIS ═══\n');

  const sorted = [...results].sort((a, b) => a.fps - b.fps);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];

  console.log(`Worst FPS: ${worst.fps} at "${worst.name}" (${worst.drawCalls} draw calls, ${worst.triangles} tris, ${worst.visible} visible)`);
  console.log(`Best FPS:  ${best.fps} at "${best.name}" (${best.drawCalls} draw calls, ${best.triangles} tris, ${best.visible} visible)`);
  console.log(`FPS range: ${worst.fps} - ${best.fps}`);

  // Correlations
  const highDC = results.filter(r => r.drawCalls > best.drawCalls * 1.5);
  if (highDC.length > 0) {
    console.log(`\nHigh draw call locations (>${Math.round(best.drawCalls * 1.5)}):`);
    highDC.forEach(r => console.log(`  ${r.name}: ${r.drawCalls} calls, ${r.fps} FPS`));
  }

  const highTri = results.filter(r => r.triangles > best.triangles * 2);
  if (highTri.length > 0) {
    console.log(`\nHigh triangle count locations (>${best.triangles * 2}):`);
    highTri.forEach(r => console.log(`  ${r.name}: ${r.triangles} tris, ${r.fps} FPS`));
  }

  // Additional diagnostics
  console.log('\n═══ RENDERER INFO ═══\n');
  const rendererInfo = await page.evaluate(() => {
    const r = window.__renderer;
    const info = r.info;
    return {
      programs: info.programs ? info.programs.length : '?',
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      maxAnisotropy: r.capabilities.getMaxAnisotropy(),
      maxTextureSize: r.capabilities.maxTextureSize,
      precision: r.capabilities.precision,
    };
  });
  console.log(`Shader programs: ${rendererInfo.programs}`);
  console.log(`Geometries in memory: ${rendererInfo.geometries}`);
  console.log(`Textures in memory: ${rendererInfo.textures}`);
  console.log(`Max anisotropy: ${rendererInfo.maxAnisotropy}`);
  console.log(`Precision: ${rendererInfo.precision}`);

  // Water mesh count
  const waterCount = await page.evaluate(() => (window.__perf || {}).waters || 0);
  console.log(`\nWater meshes (planar reflection): ${waterCount}`);
  if (waterCount > 4) {
    console.log(`  ⚠ ${waterCount} reflective water surfaces — each renders the scene TWICE!`);
    console.log(`  → This is likely the #1 bottleneck. Consider reducing MAX_REFLECTIVE_POOLS.`);
  }

  // AutoDoor count
  const doorCount = await page.evaluate(() => {
    // autoDoors is module-scoped, but we exposed __dynamicColliders
    return (window.__dynamicColliders || []).length;
  });
  console.log(`Dynamic colliders (auto-doors): ${doorCount}`);

  // Collider count
  const colliderCount = await page.evaluate(() => (window.__colliders || []).length);
  console.log(`Static colliders: ${colliderCount}`);

  // Floor count
  const floorCount = await page.evaluate(() => {
    // floors array is module-scoped
    return '(module-scoped, not accessible)';
  });

  // Bloom pass check
  console.log('\n═══ POST-PROCESSING ═══\n');
  const ppInfo = await page.evaluate(() => {
    if (!window.composer) return 'No composer';
    return {
      passes: window.composer.passes.length,
      passTypes: window.composer.passes.map(p => p.constructor.name),
    };
  });
  console.log(`Passes: ${JSON.stringify(ppInfo)}`);

  await browser.close();
  server.close();
}

run().catch(e => { console.error(e); process.exit(1); });
