/**
 * Playwright Walkthrough Test
 * Tests: door opening, collision, stair traversal, balcony access, FPS
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;
const SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');

// Simple static file server
function startServer() {
  return new Promise(resolve => {
    const mimeTypes = {
      '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.webmanifest': 'application/manifest+json',
    };
    const server = http.createServer((req, res) => {
      let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
      const ext = path.extname(filePath);
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      try {
        const data = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

// Simulate keypress in the game
async function pressKey(page, key, duration = 100) {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
}

// Hold key for a duration (movement)
async function holdKey(page, key, ms) {
  // Ensure controller stays unlocked
  await page.evaluate(() => { if (window.__controller) window.__controller.isLocked = true; });
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Get player position from the game
async function getPlayerPos(page) {
  return page.evaluate(() => {
    const cam = window.__camera;
    if (cam) {
      return { x: cam.position.x, y: cam.position.y, z: cam.position.z };
    }
    return null;
  });
}

// Get FPS from the game
async function getFPS(page) {
  return page.evaluate(() => window.__perf ? window.__perf.fps : -1);
}

// Take a named screenshot
async function screenshot(page, name) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
  console.log(`  [screenshot] ${name}.png`);
}

// Check if player can move to a position (not blocked by collision)
async function canMoveTo(page, targetZ, direction = 'forward', timeoutMs = 5000) {
  const start = await getPlayerPos(page);
  const key = direction === 'forward' ? 'w' : direction === 'backward' ? 's' :
              direction === 'left' ? 'a' : 'd';
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await holdKey(page, key, 200);
    const pos = await getPlayerPos(page);
    if (direction === 'forward' && pos.z < targetZ) return { success: true, pos };
    if (direction === 'backward' && pos.z > targetZ) return { success: true, pos };
    // Check if stuck (position barely changed)
    const moved = Math.abs(pos.z - start.z) + Math.abs(pos.x - start.x);
    if (Date.now() - startTime > 2000 && moved < 0.5) {
      return { success: false, pos, stuck: true };
    }
  }
  return { success: false, pos: await getPlayerPos(page) };
}

// Teleport player to position
async function teleportTo(page, x, y, z) {
  await page.evaluate(({x, y, z}) => {
    window.__camera.position.set(x, y, z);
  }, {x, y, z});
  await page.waitForTimeout(100);
}

// Set camera to face a named direction
// Three.js: euler.y=0→-Z(north), PI/2→-X(west), PI→+Z(south), -PI/2→+X(east)
const DIR = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 };
async function lookDirection(page, dirName) {
  const yaw = DIR[dirName] || 0;
  await page.evaluate((y) => {
    const ctrl = window.__controller;
    if (ctrl && ctrl.euler) {
      ctrl.euler.y = y;
      ctrl.camera.quaternion.setFromEuler(ctrl.euler);
    }
  }, yaw);
}

// ============================================================
// TESTS
// ============================================================

const results = [];
function assert(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  results.push({ name, status, detail });
  console.log(`  [${status}] ${name}${detail ? ' – ' + detail : ''}`);
}

async function run() {
  const server = await startServer();
  console.log(`Server running on http://localhost:${PORT}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // Collect console errors
  const jsErrors = [];
  page.on('pageerror', err => { jsErrors.push(err.message); console.log(`  [PAGE ERROR] ${err.message}`); });
  page.on('console', msg => { if (msg.type() === 'error') console.log(`  [CONSOLE] ${msg.text()}`); });

  console.log('Loading page...');
  await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });

  // Wait for game to fully initialize (window.__camera gets set after init)
  console.log('Waiting for game init...');
  try {
    await page.waitForFunction(() => !!(window.__camera && window.__controller), { timeout: 30000, polling: 1000 });
  } catch (e) {
    console.log('TIMEOUT: Game did not init. Checking for errors...');
    const errs = await page.evaluate(() => window.__initErrors || 'no error array');
    console.log('Init errors:', errs);
    const logs = await page.evaluate(() => {
      // Check if there are any hints about what went wrong
      return {
        hasThree: typeof THREE !== 'undefined',
        hasCamera: typeof window.__camera !== 'undefined',
        hasCtrl: typeof window.__controller !== 'undefined',
        bodyText: document.body.innerText.substring(0, 200),
      };
    });
    console.log('State:', JSON.stringify(logs));
    throw e;
  }
  console.log('Game initialized!');
  await page.waitForTimeout(1000);
  // Force unlock controller (pointer lock doesn't work in headless)
  await page.evaluate(() => { window.__controller.isLocked = true; });
  await page.waitForTimeout(200);

  // DFW Main hotel: x=-70, z=-60, entrance at z=-77.5 (north face)
  // DWW Main hotel: x=70, z=-60, entrance at z=-77.5 (north face)
  // Player spawns at (0, 1.7, -85) on the road

  // ---------------------------------------------------------------
  // TEST 1: ENTRANCE DOORS (T1)
  // ---------------------------------------------------------------
  console.log('\n=== TEST 1: Hotel Entrance Doors ===');

  // Teleport near DFW north entrance
  await teleportTo(page, -70, 1.7, -82);
  await page.waitForTimeout(500);
  await screenshot(page, '01-before-entrance');

  // Walk south toward entrance
  const pos1 = await getPlayerPos(page);
  assert('Player starts outside hotel', pos1.z >= -82);

  // Face south (euler.y = PI in Three.js)
  await lookDirection(page, 'south');
  await page.waitForTimeout(200);

  // Walk toward entrance
  await holdKey(page, 'w', 4500);
  const pos2 = await getPlayerPos(page);
  await screenshot(page, '02-at-entrance');
  assert('Player reached entrance zone', pos2.z > -78, `z=${pos2.z.toFixed(1)}`);

  // Continue walking into the hotel
  await holdKey(page, 'w', 3000);
  const pos3 = await getPlayerPos(page);
  await screenshot(page, '03-inside-hotel');
  assert('Player entered hotel (past north wall)', pos3.z > -75, `z=${pos3.z.toFixed(1)}`);

  // ---------------------------------------------------------------
  // TEST 2: COLLISION INTEGRITY (T2)
  // ---------------------------------------------------------------
  console.log('\n=== TEST 2: Collision Integrity ===');

  // Test: can't walk through east wall of DFW main hotel
  await teleportTo(page, -70 + 57, 1.7, -60);
  await lookDirection(page, 'east');
  await page.waitForTimeout(200);
  await holdKey(page, 'w', 2000);
  const pos4 = await getPlayerPos(page);
  assert('East wall blocks player', pos4.x < -70 + 58, `x=${pos4.x.toFixed(1)}`);

  // Test: west wall
  await teleportTo(page, -70 - 57, 1.7, -60);
  await lookDirection(page, 'west');
  await holdKey(page, 'w', 2000);
  const pos5 = await getPlayerPos(page);
  assert('West wall blocks player', pos5.x > -70 - 58, `x=${pos5.x.toFixed(1)}`);

  // Test: south entrance not blocked by static collider
  const southDoorClear = await page.evaluate(() => {
    // Check that the 10m entrance gap at the south face is clear of STATIC colliders
    // (dynamic door colliders will move aside when player approaches)
    const x = -70, z = -42.5, py = 1.7; // south face center
    // Check static colliders only
    const key = (Math.floor(x / 20) + 500) * 10000 + (Math.floor(z / 20) + 500);
    const cell = window.__colliders ? [] : [];
    // Just verify no static collider at entrance center
    let blocked = false;
    for (const c of window.__colliders) {
      if (x + 0.4 > c.min.x && x - 0.4 < c.max.x &&
          z + 0.4 > c.min.z && z - 0.4 < c.max.z) {
        const feetY = py - 1.7;
        if (c.maxY < Infinity && feetY > c.maxY) continue;
        if (c.minY > -Infinity && (feetY + 1.7) < c.minY) continue;
        blocked = true; break;
      }
    }
    return !blocked;
  });
  assert('South entrance gap clear of static colliders', southDoorClear);
  await screenshot(page, '04-south-entrance');

  // Test: lobby area has no invisible colliders (direct collision check)
  const lobbyBlocked = await page.evaluate(() => {
    const check = window.__checkCollision;
    const blocked = [];
    for (let dx = -40; dx <= 40; dx += 5) {
      if (check(-70 + dx, -65, 1.7)) blocked.push(-70 + dx);
    }
    return blocked;
  });
  assert('Lobby center has no invisible colliders', lobbyBlocked.length === 0,
    lobbyBlocked.length > 0 ? `blocked at x=${lobbyBlocked.join(',')}` : '');

  // Test: DWW entrance - walk through (doors auto-open on approach)
  await teleportTo(page, 70, 1.7, -84);
  await lookDirection(page, 'south');
  await page.waitForTimeout(800); // let doors open
  await holdKey(page, 'w', 5000);
  const posDWW = await getPlayerPos(page);
  assert('DWW entrance passable', posDWW.z > -75, `z=${posDWW.z.toFixed(1)}`);

  // Test: perimeter gate not blocked (direct collision check)
  const gateBlocked = await page.evaluate(() => {
    // Check gate area at ground level
    return window.__checkCollision(-70, -82, 1.7);
  });
  assert('DFW perimeter gate not blocked', !gateBlocked);
  await screenshot(page, '04b-collision-test');

  // ---------------------------------------------------------------
  // TEST 3: STAIR TRAVERSAL (T4)
  // ---------------------------------------------------------------
  console.log('\n=== TEST 3: Stair Traversal ===');

  // Teleport to staircase entrance (DFW main: x=-70, stairX = x+W/2-4 = -70+57.5-4 = -16.5)
  // stairStartZ = z-D/2+4 = -60-17.5+4 = -73.5
  const stairX = -70 + 115 / 2 - 4;
  const stairZ = -60 - 35 / 2 + 4;
  await teleportTo(page, stairX, 1.7, stairZ - 1);
  await lookDirection(page, 'south'); // face south (up the stairs)
  await page.waitForTimeout(200);
  await screenshot(page, '05-stair-base');

  // Walk up stairs
  await holdKey(page, 'w', 5000);
  const pos7 = await getPlayerPos(page);
  await screenshot(page, '06-stair-climb');
  assert('Player climbed stairs (Y > 3)', pos7.y > 3, `y=${pos7.y.toFixed(1)}`);

  // Continue to second floor
  await holdKey(page, 'w', 5000);
  const pos8 = await getPlayerPos(page);
  assert('Player reached 1st floor (Y > 5)', pos8.y > 5, `y=${pos8.y.toFixed(1)}`);

  // ---------------------------------------------------------------
  // TEST 4: NO FLOOR FALL-THROUGH (T4)
  // ---------------------------------------------------------------
  console.log('\n=== TEST 4: Floor Stability ===');

  // Teleport to 1st floor center
  await teleportTo(page, -70, 6 + 1.7, -60);
  await page.waitForTimeout(500);
  const pos9 = await getPlayerPos(page);
  assert('Standing stable on 1st floor', pos9.y > 6, `y=${pos9.y.toFixed(1)}`);
  await screenshot(page, '07-first-floor');

  // Walk around on 1st floor
  await lookDirection(page, 90);
  await holdKey(page, 'w', 2000);
  const pos10 = await getPlayerPos(page);
  assert('No fall-through while walking on 1st floor', pos10.y > 5.5, `y=${pos10.y.toFixed(1)}`);

  // ---------------------------------------------------------------
  // TEST 5: FPS CHECK
  // ---------------------------------------------------------------
  console.log('\n=== TEST 5: Performance ===');

  // Walk around for a bit and check FPS
  await teleportTo(page, -70, 1.7, -60);
  await page.waitForTimeout(1000);
  const fps = await getFPS(page);
  // SwiftShader (headless) runs at ~20 FPS, so accept >= 10 in CI
  assert('FPS reasonable (inside hotel)', fps >= 10, `FPS=${fps}`);

  await teleportTo(page, 0, 1.7, -85);
  await page.waitForTimeout(1000);
  const fps2 = await getFPS(page);
  assert('FPS reasonable (outside)', fps2 >= 10, `FPS=${fps2}`);

  // ---------------------------------------------------------------
  // TEST 6: JS ERRORS
  // ---------------------------------------------------------------
  console.log('\n=== TEST 6: JS Errors ===');
  assert('No JS errors', jsErrors.length === 0, jsErrors.length > 0 ? jsErrors.join('; ') : '');

  // ---------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------
  console.log('\n============================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);
  if (failed > 0) {
    console.log('FAILED tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  console.log('============================\n');

  await browser.close();
  server.close();

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
