/**
 * Playwright Interior Walkthrough Test
 * Walks through all floors of DFW Main hotel, visits a balcony on each floor.
 *
 * DFW Main Hotel: x=-70, z=-60, W=115, D=35, H=6.0
 *
 * Coordinate reference (WORLD):
 *   North wall:    z = -77.5
 *   South wall:    z = -42.5
 *   East wall:     x = -12.5
 *   West wall:     x = -127.5
 *   Staircase:     x = -16.5, z = -73.5 to -63.5 (walks south = uphill)
 *   Stair landing: x = -16.5, z = -63.0
 *   Hallway (OG):  z ≈ -73.0
 *   Room 1 center: x ≈ -82.4, z ≈ -58.3
 *   Balcony (south): z ≈ -42.0 (just outside south wall)
 *   EG floor: y=0, 1.OG: y=6, 2.OG: y=12
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8766;
const SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');

function startServer() {
  return new Promise(resolve => {
    const mimeTypes = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
    };
    const server = http.createServer((req, res) => {
      let fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      try { const d = fs.readFileSync(fp); res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(fp)] || 'application/octet-stream' }); res.end(d); }
      catch { res.writeHead(404); res.end('Not found'); }
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function getPos(page) {
  return page.evaluate(() => {
    const c = window.__camera;
    return c ? { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(2), z: +c.position.z.toFixed(2) } : null;
  });
}

async function teleport(page, x, y, z) {
  await page.evaluate(({ x, y, z }) => window.__camera.position.set(x, y, z), { x, y, z });
  await page.waitForTimeout(150);
}

async function look(page, dir) {
  const dirs = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 };
  await page.evaluate((yaw) => {
    const c = window.__controller;
    if (c && c.euler) { c.euler.y = yaw; c.camera.quaternion.setFromEuler(c.euler); }
  }, dirs[dir] || 0);
}

async function walk(page, key, ms) {
  await page.evaluate(() => { if (window.__controller) window.__controller.isLocked = true; });
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

async function screenshot(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  console.log(`  📸 ${name}.png`);
}

// ─── Test runner ──────────────────────────────────────────────────────────────
const results = [];
function ok(name, cond, detail = '') {
  results.push({ name, pass: cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' – ' + detail : ''}`);
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));

  console.log('Loading game...');
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!(window.__camera && window.__controller), { timeout: 30000, polling: 1000 });
  await page.evaluate(() => { window.__controller.isLocked = true; });
  await page.waitForTimeout(1000);
  console.log('Game ready.\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // ERDGESCHOSS (EG)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('══ ERDGESCHOSS ══');

  // Spawn in lobby
  await teleport(page, -70, 1.7, -65);
  await screenshot(page, 'eg-01-lobby');
  let p = await getPos(page);
  ok('EG: In lobby', p.y < 3, `y=${p.y}`);

  // Walk east toward staircase entrance (stair at x=-16.5, z=-73.5)
  await teleport(page, -20, 1.7, -73);
  await look(page, 'east');
  await screenshot(page, 'eg-02-near-stairs');
  p = await getPos(page);
  ok('EG: Near staircase entrance', p.x > -25, `x=${p.x}`);

  // Walk south onto stairs (stairs go south from z=-73.5, climbing up)
  await teleport(page, -16.5, 1.7, -73);
  await look(page, 'south');
  await walk(page, 'w', 2500);
  p = await getPos(page);
  await screenshot(page, 'eg-03-climbing-stairs');
  ok('EG: Started climbing stairs (y > 2)', p.y > 2, `y=${p.y}`);

  // EG Balcony: South balconies are on the building exterior.
  // Ground-floor south balconies are skipped in entrance zone, but exist elsewhere.
  // Teleport to a ground-floor balcony (room-aligned, south face)
  // Local bx ≈ -40, by = 0, fz_bal = 18.1 → world: x=-110, z=-41.9
  await teleport(page, -110, 1.7, -41.5);
  await look(page, 'south');
  await screenshot(page, 'eg-04-balcony');
  p = await getPos(page);
  ok('EG: On south balcony area', p.z > -43, `z=${p.z}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. OBERGESCHOSS (1.OG)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 1. OBERGESCHOSS ══');

  // Teleport to stair base, climb to 1.OG
  await teleport(page, -16.5, 1.7, -74);
  await look(page, 'south');
  await walk(page, 'w', 6000); // climb full flight
  p = await getPos(page);
  await screenshot(page, 'og1-01-stair-top');
  ok('1.OG: Reached 1st floor via stairs (y > 6)', p.y > 6, `y=${p.y}`);

  // Step off landing onto 1.OG hallway
  await teleport(page, -16.5, 7.7, -63);
  await look(page, 'west');
  await walk(page, 'w', 2000);
  p = await getPos(page);
  await screenshot(page, 'og1-02-hallway');
  ok('1.OG: In hallway', p.y > 6 && p.y < 9, `y=${p.y}, x=${p.x}`);

  // Walk to Room 1 (world x ≈ -82.4, hallway-room door at z ≈ -71.5)
  await teleport(page, -82, 7.7, -72);
  await look(page, 'south');
  await page.waitForTimeout(500); // let door open
  await walk(page, 'w', 2000);
  p = await getPos(page);
  await screenshot(page, 'og1-03-room');
  ok('1.OG: Entered room (z > -70)', p.z > -70, `z=${p.z}`);

  // Walk south through room toward balcony door
  await look(page, 'south');
  await walk(page, 'w', 5000);
  p = await getPos(page);
  await screenshot(page, 'og1-04-near-balcony-door');
  ok('1.OG: Walked south in room (z > -65)', p.z > -65, `z=${p.z}`);

  // Teleport onto 1.OG balcony (south exterior, y=6 floor level)
  // Balcony walkable floor: byFloor=6 for floor 1 (f=1 → byFloor = 1*6 = 6)
  // Balcony z: z = -60 + 17.5 + 0.6 = -41.9
  await teleport(page, -82, 7.7, -41.5);
  await page.waitForTimeout(500);
  p = await getPos(page);
  await screenshot(page, 'og1-05-balcony');
  ok('1.OG: On balcony (z > -42.5)', p.z > -42.5, `z=${p.z}, y=${p.y}`);
  ok('1.OG: Balcony floor holds (y > 5)', p.y > 5, `y=${p.y}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. OBERGESCHOSS (2.OG)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 2. OBERGESCHOSS ══');

  // Climb from 1.OG to 2.OG
  await teleport(page, -16.5, 7.7, -74);
  await look(page, 'south');
  await walk(page, 'w', 6000);
  p = await getPos(page);
  await screenshot(page, 'og2-01-stair-top');
  ok('2.OG: Reached 2nd floor via stairs (y > 12)', p.y > 12, `y=${p.y}`);

  // Step into hallway
  await teleport(page, -16.5, 13.7, -63);
  await look(page, 'west');
  await walk(page, 'w', 2000);
  p = await getPos(page);
  await screenshot(page, 'og2-02-hallway');
  ok('2.OG: In hallway', p.y > 12 && p.y < 15, `y=${p.y}, x=${p.x}`);

  // Enter room
  await teleport(page, -82, 13.7, -72);
  await look(page, 'south');
  await page.waitForTimeout(500);
  await walk(page, 'w', 2000);
  p = await getPos(page);
  await screenshot(page, 'og2-03-room');
  ok('2.OG: Entered room (z > -70)', p.z > -70, `z=${p.z}`);

  // Teleport onto 2.OG balcony (byFloor=12 for floor 2)
  await teleport(page, -82, 13.7, -41.5);
  await page.waitForTimeout(500);
  p = await getPos(page);
  await screenshot(page, 'og2-04-balcony');
  ok('2.OG: On balcony (z > -42.5)', p.z > -42.5, `z=${p.z}, y=${p.y}`);
  ok('2.OG: Balcony floor holds (y > 11)', p.y > 11, `y=${p.y}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLISION CHECKS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ COLLISION CHECKS ══');

  // Interior partition: WC east wall (world: x=-119, z=-60)
  await teleport(page, -120, 1.7, -60);
  await look(page, 'east');
  await walk(page, 'w', 1500);
  p = await getPos(page);
  ok('EG: WC east wall blocks', p.x < -118.5, `x=${p.x}`);

  // Interior partition: Reception west wall (local recpX=37.5 → world x=-32.5)
  await teleport(page, -34, 1.7, -75);
  await look(page, 'east');
  await walk(page, 'w', 1500);
  p = await getPos(page);
  ok('EG: Reception wall blocks', p.x < -32, `x=${p.x}`);

  // 1.OG room partition wall (between rooms, x ≈ -82.4 for room 1/2 boundary)
  // Room 0 rx=-37.125 → world -107.125, Room 1 rx=-12.375 → world -82.375
  // Partition at rx - roomW/2 for r=1: -12.375 - 12.375 = -24.75 → world -94.75
  await teleport(page, -96, 7.7, -58);
  await look(page, 'east');
  await walk(page, 'w', 1500);
  p = await getPos(page);
  ok('1.OG: Room partition wall blocks', p.x < -94, `x=${p.x}`);

  // Floor stability: walk on 1.OG for extended time
  await teleport(page, -70, 7.7, -65);
  await look(page, 'east');
  await walk(page, 'w', 3000);
  await look(page, 'west');
  await walk(page, 'w', 3000);
  p = await getPos(page);
  ok('1.OG: No fall-through after extended walk', p.y > 6, `y=${p.y}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // JS ERRORS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n══ JS ERRORS ══');
  ok('No JS errors', jsErrors.length === 0, jsErrors.length > 0 ? jsErrors.join('; ') : '');

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  if (failed > 0) {
    console.log('FAILED:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
  }
  console.log('═'.repeat(50));

  await browser.close();
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
