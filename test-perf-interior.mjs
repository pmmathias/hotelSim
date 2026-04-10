/**
 * Interior Performance Profiler
 * Teleports to each floor, does 360° rotation, measures FPS/draw calls/triangles
 */
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const dir = '/Users/mathiasleonhardt/Dev/hotelSim';
const PORT = 8790;

const server = await new Promise(resolve => {
  const s = http.createServer((req, res) => {
    let fp = path.join(dir, req.url === '/' ? 'index.html' : req.url);
    try {
      const ct = fp.endsWith('.js') || fp.endsWith('.mjs') ? 'application/javascript'
               : fp.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(fs.readFileSync(fp));
    } catch { res.writeHead(404); res.end(); }
  });
  s.listen(PORT, () => resolve(s));
});

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('pageerror', e => console.log('ERR:', e.message));

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!(window.__camera && window.__controller && window.__perf), { timeout: 30000, polling: 500 });
await page.evaluate(() => { window.__controller.isLocked = true; });
await page.waitForTimeout(2000);

// DFW Main: x=-70, z=-60, H=6
const tests = [
  { name: 'EG Lobby (y=1.7)',    x: -70, y: 1.7,  z: -65 },
  { name: '1.OG Hallway (y=7.7)', x: -70, y: 7.7,  z: -60 },
  { name: '1.OG Room (y=7.7)',    x: -82, y: 7.7,  z: -55 },
  { name: '1.OG Balcony (y=7.7)', x: -82, y: 7.7,  z: -41 },
  { name: '2.OG Hallway (y=13.7)', x: -70, y: 13.7, z: -60 },
  { name: '2.OG Room (y=13.7)',    x: -82, y: 13.7, z: -55 },
  { name: 'Outside road (y=1.7)', x: 0, y: 1.7, z: -85 },
  { name: 'Pool area (y=1.7)',   x: -60, y: 1.7, z: -30 },
];

console.log('╔══════════════════════════════╦══════╦═══════════╦═══════════╦════════╗');
console.log('║ Location                     ║  FPS ║ DrawCalls ║ Triangles ║Visible ║');
console.log('╠══════════════════════════════╬══════╬═══════════╬═══════════╬════════╣');

for (const t of tests) {
  // Teleport
  await page.evaluate(({ x, y, z }) => {
    window.__camera.position.set(x, y, z);
  }, t);
  await page.waitForTimeout(300);

  // 360° rotation: sample perf at 8 angles
  let totalFPS = 0, totalDC = 0, totalTri = 0, totalVis = 0, minFPS = 999, maxDC = 0;
  const angles = 8;
  for (let a = 0; a < angles; a++) {
    const yaw = (a / angles) * Math.PI * 2;
    await page.evaluate((yaw) => {
      window.__controller.euler.y = yaw;
      window.__controller.camera.quaternion.setFromEuler(window.__controller.euler);
    }, yaw);
    await page.waitForTimeout(250);

    const perf = await page.evaluate(() => ({ ...window.__perf }));
    totalFPS += perf.fps;
    totalDC += perf.drawCalls;
    totalTri += perf.triangles;
    totalVis += perf.visible;
    if (perf.fps < minFPS) minFPS = perf.fps;
    if (perf.drawCalls > maxDC) maxDC = perf.drawCalls;
  }

  const avgFPS = Math.round(totalFPS / angles);
  const avgDC = Math.round(totalDC / angles);
  const avgTri = Math.round(totalTri / angles);
  const avgVis = Math.round(totalVis / angles);

  const name = t.name.padEnd(28);
  console.log(`║ ${name} ║ ${String(avgFPS).padStart(4)} ║ ${String(avgDC).padStart(9)} ║ ${String(avgTri).padStart(9)} ║ ${String(avgVis).padStart(6)} ║`);
}

console.log('╚══════════════════════════════╩══════╩═══════════╩═══════════╩════════╝');

// Deep analysis: what takes the most in 1.OG
console.log('\n=== DEEP ANALYSIS: 1.OG Hallway ===\n');
await page.evaluate(() => {
  window.__camera.position.set(-70, 7.7, -60);
  window.__controller.euler.y = Math.PI;
  window.__controller.camera.quaternion.setFromEuler(window.__controller.euler);
});
await page.waitForTimeout(500);

const deep = await page.evaluate(() => {
  const r = window.__renderer;
  const info = r.info;
  const perf = window.__perf;

  // Count visible objects by type
  let visibleMeshes = 0, visibleGroups = 0, visibleLODs = 0;
  const scene = r.info.autoReset; // can't access scene directly

  // Count floor group stats
  const fgStats = [];
  // floorGroups is module-scoped but we can check visibility
  // Try to count objects in the scene
  return {
    fps: perf.fps,
    drawCalls: perf.drawCalls,
    triangles: perf.triangles,
    visible: perf.visible,
    total: perf.total,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length || '?',
    // Water mesh count
    waters: perf.waters,
    lods: perf.lods,
  };
});

console.log(`FPS: ${deep.fps}`);
console.log(`Draw calls: ${deep.drawCalls}`);
console.log(`Triangles: ${deep.triangles}`);
console.log(`Visible spatial: ${deep.visible} / ${deep.total}`);
console.log(`Geometries: ${deep.geometries}`);
console.log(`Textures: ${deep.textures}`);
console.log(`Shader programs: ${deep.programs}`);
console.log(`Water meshes: ${deep.waters}`);
console.log(`LOD objects: ${deep.lods}`);

// Check if Water pools are rendering reflections (huge cost)
console.log('\n=== WATER POOL REFLECTION CHECK ===');
const waterCheck = await page.evaluate(() => {
  // Count waterMeshes2 (Water addon with planar reflection)
  // These render the entire scene TWICE each
  const meshes2Count = typeof waterMeshes2 !== 'undefined' ? waterMeshes2.length : '?';
  return { waterMeshes2: meshes2Count };
});
console.log(`Water addon pools (planar reflection): ${waterCheck.waterMeshes2}`);

// Check auto-door count
const doorCheck = await page.evaluate(() => ({
  dynamicColliders: (window.__dynamicColliders || []).length,
  totalColliders: (window.__colliders || []).length,
}));
console.log(`\nDynamic colliders (auto-doors): ${doorCheck.dynamicColliders}`);
console.log(`Static colliders: ${doorCheck.totalColliders}`);

// Check bloom pass
const bloom = await page.evaluate(() => {
  if (window.composer) {
    return { passes: window.composer.passes.map(p => p.constructor.name) };
  }
  return 'no composer';
});
console.log(`\nPost-processing: ${JSON.stringify(bloom)}`);

await page.waitForTimeout(1000);
await browser.close();
server.close();
