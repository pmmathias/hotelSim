// =============================================================================
// Dream World Hotels – Side, Kumköy – 3D WebGL First-Person Explorer
// =============================================================================
// Optimized: material caching, merged geometry, LOD, no grass blades,
// selective shadows, lighter post-processing
// =============================================================================

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// GTAOPass removed – too expensive (triples draw calls)
import { Water } from 'three/addons/objects/Water.js';
// RectAreaLightUniformsLib removed – too expensive, using baked lightmap instead
import {
  generateAllTextures,
  applySkyGradient,
  generateNormalMap,
  upgradeLuxuryTextures,
} from './textures.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MOVE_SPEED = 28;
const RUN_MULTIPLIER = 2.2;
const ROTATE_SPEED = 2.5;
const JUMP_FORCE = 12;
const GRAVITY = -30;
const PLAYER_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.4;
const FAR_PLANE = 1200;
const GROUND_SIZE = 2000;
const LOD_NEAR = 60;
const LOD_FAR = 200;

// ---------------------------------------------------------------------------
// Quadtree (unchanged, but now holds groups not individual meshes)
// ---------------------------------------------------------------------------
class QuadTreeNode {
  constructor(bounds, depth = 0, maxDepth = 5, maxObjects = 10) {
    this.bounds = bounds;
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.maxObjects = maxObjects;
    this.objects = [];
    this.children = null;
  }
  subdivide() {
    const { x, z, w, h } = this.bounds;
    const hw = w / 2, hh = h / 2;
    this.children = [
      new QuadTreeNode({ x: x - hw / 2, z: z - hh / 2, w: hw, h: hh }, this.depth + 1, this.maxDepth, this.maxObjects),
      new QuadTreeNode({ x: x + hw / 2, z: z - hh / 2, w: hw, h: hh }, this.depth + 1, this.maxDepth, this.maxObjects),
      new QuadTreeNode({ x: x - hw / 2, z: z + hh / 2, w: hw, h: hh }, this.depth + 1, this.maxDepth, this.maxObjects),
      new QuadTreeNode({ x: x + hw / 2, z: z + hh / 2, w: hw, h: hh }, this.depth + 1, this.maxDepth, this.maxObjects),
    ];
  }
  insert(obj) {
    if (!this._intersects(obj._qtBounds)) return false;
    if (this.children) { for (const c of this.children) c.insert(obj); return true; }
    this.objects.push(obj);
    if (this.objects.length > this.maxObjects && this.depth < this.maxDepth) {
      this.subdivide();
      for (const o of this.objects) for (const c of this.children) c.insert(o);
      this.objects = [];
    }
    return true;
  }
  query(frustum, results) {
    if (!this._frustumIntersects(frustum)) return;
    for (const obj of this.objects) { if (!obj._qtChecked) { obj._qtChecked = true; results.push(obj); } }
    if (this.children) for (const c of this.children) c.query(frustum, results);
  }
  _intersects(b) {
    const a = this.bounds;
    return !(b.x - b.w / 2 > a.x + a.w / 2 || b.x + b.w / 2 < a.x - a.w / 2 ||
             b.z - b.h / 2 > a.z + a.h / 2 || b.z + b.h / 2 < a.z - a.h / 2);
  }
  _frustumIntersects(frustum) {
    const { x, z, w, h } = this.bounds;
    return frustum.intersectsBox(new THREE.Box3(
      new THREE.Vector3(x - w / 2, -5, z - h / 2),
      new THREE.Vector3(x + w / 2, 50, z + h / 2)));
  }
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
const colliders = [];
const dynamicColliders = []; // colliders that move (e.g. sliding doors) – checked separately
const floors = [];   // { min:{x,z}, max:{x,z}, y } – walkable surfaces at different heights

function addCollider(x, z, w, d, maxY = Infinity, minY = -Infinity) {
  colliders.push({ min: { x: x - w / 2, z: z - d / 2 }, max: { x: x + w / 2, z: z + d / 2 }, maxY, minY });
}
function addFloor(x, z, w, d, y) {
  floors.push({ min: { x: x - w / 2, z: z - d / 2 }, max: { x: x + w / 2, z: z + d / 2 }, y });
}
// Spatial grid for fast collision checks
const _COL_GRID_SIZE = 20; // 20m cells
const _colGrid = new Map();

function _colGridKey(x, z) {
  return (Math.floor(x / _COL_GRID_SIZE) + 500) * 10000 + (Math.floor(z / _COL_GRID_SIZE) + 500);
}

function _rebuildColGrid() {
  _colGrid.clear();
  for (const c of colliders) {
    // Insert into all grid cells this collider overlaps
    const xMin = Math.floor(c.min.x / _COL_GRID_SIZE);
    const xMax = Math.floor(c.max.x / _COL_GRID_SIZE);
    const zMin = Math.floor(c.min.z / _COL_GRID_SIZE);
    const zMax = Math.floor(c.max.z / _COL_GRID_SIZE);
    for (let gx = xMin; gx <= xMax; gx++) {
      for (let gz = zMin; gz <= zMax; gz++) {
        const key = (gx + 500) * 10000 + (gz + 500);
        if (!_colGrid.has(key)) _colGrid.set(key, []);
        _colGrid.get(key).push(c);
      }
    }
  }
}

function checkCollision(px, pz, py) {
  const feetY = py - PLAYER_HEIGHT;
  const headY = feetY + PLAYER_HEIGHT;
  const key = _colGridKey(px, pz);
  const cell = _colGrid.get(key);
  if (cell) {
    for (let i = 0; i < cell.length; i++) {
      const c = cell[i];
      if (px + PLAYER_RADIUS > c.min.x && px - PLAYER_RADIUS < c.max.x &&
          pz + PLAYER_RADIUS > c.min.z && pz - PLAYER_RADIUS < c.max.z) {
        // Height-limited colliders: only block if player overlaps the height range
        if (c.maxY < Infinity && feetY >= c.maxY) continue;  // player at or above top
        if (c.minY > -Infinity && headY <= c.minY) continue; // player at or below bottom
        return true;
      }
    }
  }
  // Check dynamic colliders (sliding doors etc.) – small array, no grid needed
  for (let i = 0; i < dynamicColliders.length; i++) {
    const c = dynamicColliders[i];
    if (px + PLAYER_RADIUS > c.min.x && px - PLAYER_RADIUS < c.max.x &&
        pz + PLAYER_RADIUS > c.min.z && pz - PLAYER_RADIUS < c.max.z) {
      if (c.maxY < Infinity && feetY >= c.maxY) continue;
      if (c.minY > -Infinity && headY <= c.minY) continue;
      return true;
    }
  }
  return false;
}
function getFloorHeight(px, pz, playerY) {
  let bestY = 0; // ground level
  const feetY = (playerY || PLAYER_HEIGHT) - PLAYER_HEIGHT;
  for (const f of floors) {
    if (px > f.min.x && px < f.max.x && pz > f.min.z && pz < f.max.z) {
      // Only consider floors near the player's feet (within 1.5m above feet)
      // Prevents teleporting from ground to 2nd floor, but allows stepping onto nearby surfaces
      if (f.y <= feetY + 1.5 && f.y > bestY) {
        bestY = f.y;
      }
    }
  }
  return bestY;
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
let textures;
const spatialObjects = [];  // Now holds groups/LODs, not every single mesh
const lodObjects = [];      // Cached LOD references (no traverse needed)
const waterMeshes = [];
const ledStrips = [];
const autoDoors = [];     // { mesh, worldPos, openOffset, isOpen, t }
const lifts = [];         // { buildingX, buildingZ, localX, localZ, w, d, currentFloor, state, timer, targetFloor, doorL, doorR }
const floorGroups = [];   // { group, buildingX, buildingZ, floorNum, yMin, yMax }
const stageLights = [];
let skyUniforms = null;
let skyMesh = null;
let isNightMode = false;
let sunLight = null;
let ambientLight = null;
let hemiLight = null;
const lobbyLights = []; // collect all interior PointLights for day/night adjustment
let envMap = null;
let camera; // module-level ref for LOD updates

function registerSpatial(obj) {
  // Register a group, LOD, or mesh as a spatial object for quadtree
  if (!obj.geometry && !obj.isGroup && !obj.isLOD) {
    // For groups, compute bounds from children
    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    obj._qtBounds = { x: center.x, z: center.z, w: Math.max(size.x, 1), h: Math.max(size.z, 1) };
  } else if (obj.geometry) {
    if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
    const wp = new THREE.Vector3();
    obj.getWorldPosition(wp);
    const r = obj.geometry.boundingSphere.radius * Math.max(obj.scale.x, obj.scale.y, obj.scale.z);
    obj._qtBounds = { x: wp.x, z: wp.z, w: r * 2, h: r * 2 };
  } else {
    const box = new THREE.Box3().setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    obj._qtBounds = { x: center.x, z: center.z, w: Math.max(size.x, 1), h: Math.max(size.z, 1) };
  }
  obj._qtChecked = false;
  obj.frustumCulled = false; // We handle culling ourselves
  spatialObjects.push(obj);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function makeBox(w, h, d, mat, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d);
  // Scale UVs proportional to world-space size — texture repeats at constant
  // physical size everywhere. Since damask is seamlessly tileable, fractional
  // repeats at wall ends are invisible (no cut seams).
  const uvAttr = geo.attributes.uv;
  if (uvAttr) {
    const metersPerRepeat = 3; // 1 texture repeat per 3 meters of wall
    const sW = w / metersPerRepeat;
    const sH = h / metersPerRepeat;
    const sD = d / metersPerRepeat;
    for (let i = 0; i < uvAttr.count; i++) {
      const faceIdx = Math.floor(i / 4); // 6 faces, 4 verts each
      let su, sv;
      if (faceIdx < 2) { su = sW; sv = sH; }      // +/- Z faces (front/back)
      else if (faceIdx < 4) { su = sW; sv = sD; }  // +/- Y faces (top/bottom)
      else { su = sD; sv = sH; }                    // +/- X faces (left/right)
      uvAttr.setXY(i,
        uvAttr.getX(i) * su,
        uvAttr.getY(i) * sv
      );
    }
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  return mesh;
}

function makePlane(w, d, mat, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Cached material system – reuse materials to reduce draw calls
// ---------------------------------------------------------------------------
const matCache = {};

function getCachedMat(key, factory) {
  if (!matCache[key]) matCache[key] = factory();
  return matCache[key];
}

function makePBR(key, opts) {
  return getCachedMat(key, () => {
    const mat = new THREE.MeshStandardMaterial(opts);
    if (opts.map && opts.map.image) {
      mat.normalMap = generateNormalMap(opts.map.image);
      mat.normalScale = new THREE.Vector2(0.4, 0.4);
    }
    if (envMap) { mat.envMap = envMap; mat.envMapIntensity = opts.envMapIntensity ?? 0.3; }
    return mat;
  });
}

function getGlassMat() {
  return getCachedMat('glass', () => new THREE.MeshStandardMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.2,
    roughness: 0.02, metalness: 0.1,
    envMap, envMapIntensity: 0.7,
  }));
}

function getMarbleMat() {
  return getCachedMat('marble', () => new THREE.MeshStandardMaterial({
    map: textures.marbleFloor, roughness: 0.15, metalness: 0.05,
    envMap, envMapIntensity: 0.4,
  }));
}

// ── Detailed toilet model (LatheGeometry bowl + cylinder tank) ──────────
function createToilet(group, x, y, z, ceramicMat, chromeMat) {
  // All positions offset by +0.3 so toilet sits ON the floor surface (not inside it)
  const fy = y + 0.3;
  // Bowl: LatheGeometry profile
  const bowlPts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.18, 0.0),
    new THREE.Vector2(0.22, 0.05),
    new THREE.Vector2(0.23, 0.15),
    new THREE.Vector2(0.22, 0.28),
    new THREE.Vector2(0.24, 0.32),
    new THREE.Vector2(0.21, 0.35),
    new THREE.Vector2(0.17, 0.33),
    new THREE.Vector2(0.12, 0.28),
    new THREE.Vector2(0.05, 0.12),
    new THREE.Vector2(0.0, 0.08),
  ];
  const bowlGeo = new THREE.LatheGeometry(bowlPts, 16);
  const bowl = new THREE.Mesh(bowlGeo, ceramicMat);
  bowl.position.set(x, fy, z);
  bowl.receiveShadow = true;
  group.add(bowl);

  // Seat
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 6, 16), ceramicMat);
  seat.position.set(x, fy + 0.36, z);
  seat.rotation.x = Math.PI / 2;
  group.add(seat);

  // Tank
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.4, 12), ceramicMat);
  tank.position.set(x, fy + 0.35, z - 0.28);
  tank.receiveShadow = true;
  group.add(tank);

  // Tank lid
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.03, 12), ceramicMat);
  lid.position.set(x, fy + 0.56, z - 0.28);
  group.add(lid);

  // Flush handle
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 4), chromeMat);
  handle.position.set(x + 0.15, fy + 0.5, z - 0.28);
  handle.rotation.z = Math.PI / 2;
  group.add(handle);
}

// ── Detailed sink model (LatheGeometry basin + pedestal) ────────────────
function createSink(group, x, y, z, ceramicMat, chromeMat, mirrorMat, wallDir = 'z') {
  // wallDir: 'z' = wall behind sink runs along X (mirror at z-offset)
  //          'x' = wall behind sink runs along Z (mirror at x-offset)
  const fy = y + 0.3;
  // Basin: LatheGeometry
  const basinPts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.08, 0.01),
    new THREE.Vector2(0.20, 0.04),
    new THREE.Vector2(0.26, 0.10),
    new THREE.Vector2(0.28, 0.14),
    new THREE.Vector2(0.30, 0.16),
    new THREE.Vector2(0.28, 0.13),
    new THREE.Vector2(0.25, 0.10),
    new THREE.Vector2(0.22, 0.02),
    new THREE.Vector2(0.0, 0.0),
  ];
  const basin = new THREE.Mesh(new THREE.LatheGeometry(basinPts, 16), ceramicMat);
  basin.position.set(x, fy + 0.75, z);
  basin.receiveShadow = true;
  group.add(basin);

  // Pedestal
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.75, 8), ceramicMat);
  ped.position.set(x, fy + 0.375, z);
  ped.receiveShadow = true;
  group.add(ped);

  // Pedestal base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.04, 8), ceramicMat);
  base.position.set(x, fy + 0.02, z);
  group.add(base);

  // Faucet + mirror orientation depends on wallDir
  const wx = wallDir === 'x' ? -0.18 : 0;     // wall offset on X
  const wz = wallDir === 'z' ? -0.18 : 0;     // wall offset on Z
  const pip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6), chromeMat);
  pip.position.set(x + wx, fy + 1.0, z + wz);
  group.add(pip);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.12, 6), chromeMat);
  spout.position.set(x + wx * 0.67, fy + 1.05, z + wz * 0.67);
  spout.rotation.x = wallDir === 'z' ? Math.PI / 3 : 0;
  spout.rotation.z = wallDir === 'x' ? -Math.PI / 3 : 0;
  group.add(spout);
  // Handles
  for (const side of [-1, 1]) {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), chromeMat);
    if (wallDir === 'z') knob.position.set(x + side * 0.08, fy + 0.95, z - 0.18);
    else knob.position.set(x - 0.18, fy + 0.95, z + side * 0.08);
    group.add(knob);
  }

  // Mirror on wall behind sink
  if (wallDir === 'z') {
    group.add(makeBox(0.5, 0.7, 0.03, mirrorMat, x, fy + 1.5, z - 0.32));
  } else {
    group.add(makeBox(0.03, 0.7, 0.5, mirrorMat, x - 0.32, fy + 1.5, z));
  }
}

// ---------------------------------------------------------------------------
// HDR Env Map from sky
// ---------------------------------------------------------------------------
let _renderer, _scene; // stored for envmap regeneration
function generateEnvMap(renderer, scene) {
  _renderer = renderer; _scene = scene;
  refreshEnvMap();
}
function refreshEnvMap() {
  if (!_renderer || !_scene) return;
  const pmrem = new THREE.PMREMGenerator(_renderer);
  pmrem.compileCubemapShader();
  const rt = pmrem.fromScene(_scene, 0, 0.1, 600);
  envMap = rt.texture;
  _scene.environment = envMap;
  pmrem.dispose();
  for (const key in matCache) {
    if (matCache[key].envMap !== undefined) matCache[key].envMap = envMap;
  }
}

// ---------------------------------------------------------------------------
// Hotel building – merged geometry for performance
// ---------------------------------------------------------------------------
function createHotelBuilding(scene, x, z, width, depth, floors, name, color, ledPhase) {
  const floorH = 6.0;
  const totalH = floors * floorH;
  const wallT = 0.5;
  const entranceW = 10;

  // === HIGH-DETAIL GROUP (shown near) ===
  const hiGroup = new THREE.Group();

  const wallMat = makePBR('wall_' + color, { map: textures.wall, color: new THREE.Color(color), roughness: 0.85 });

  // Walls – entrances on NORTH (street) and SOUTH (pool area)
  const walls = [];
  const segW = (width - entranceW) / 2;
  // East + West walls (full)
  walls.push(makeBox(wallT, totalH, depth, wallMat, width / 2, totalH / 2, 0));
  walls.push(makeBox(wallT, totalH, depth, wallMat, -width / 2, totalH / 2, 0));
  // North wall: two segments + entrance gap
  walls.push(makeBox(segW, totalH, wallT, wallMat, -(entranceW / 2 + segW / 2), totalH / 2, -depth / 2));
  walls.push(makeBox(segW, totalH, wallT, wallMat, (entranceW / 2 + segW / 2), totalH / 2, -depth / 2));
  walls.push(makeBox(entranceW, totalH - floorH, wallT, wallMat, 0, floorH + (totalH - floorH) / 2, -depth / 2));
  // South wall: EG solid (two segments + entrance gap), OG with balcony door openings
  // EG portion (ground floor height only)
  walls.push(makeBox(segW, floorH, wallT, wallMat, -(entranceW / 2 + segW / 2), floorH / 2, depth / 2));
  walls.push(makeBox(segW, floorH, wallT, wallMat, (entranceW / 2 + segW / 2), floorH / 2, depth / 2));
  // Upper portion: split into segments with 2.2m gaps for each balcony door
  {
    const ogH = totalH - floorH;
    const sideW2 = Math.min(8, width * 0.12);
    const roomsW = width - sideW2 * 2;
    const roomCount = Math.max(1, Math.floor(roomsW / 8));
    const roomW = roomsW / roomCount;
    const doorGap = 2.2; // balcony door width
    // Build wall pieces between doors for each south wall segment (left + right of entrance)
    for (const segSign of [-1, 1]) {
      const segStart = segSign < 0 ? -width / 2 : entranceW / 2;
      const segEnd = segSign < 0 ? -entranceW / 2 : width / 2;
      let cursor = segStart;
      for (let r = 0; r < roomCount; r++) {
        const rx = -width / 2 + sideW2 + r * roomW + roomW / 2;
        if (rx - doorGap / 2 < segStart || rx + doorGap / 2 > segEnd) continue; // door outside this segment
        // Wall piece from cursor to door left edge
        const pieceW = (rx - doorGap / 2) - cursor;
        if (pieceW > 0.2) {
          walls.push(makeBox(pieceW, ogH, wallT, wallMat, cursor + pieceW / 2, floorH + ogH / 2, depth / 2));
        }
        // Wall above door (lintel)
        walls.push(makeBox(doorGap, ogH - 2.4, wallT, wallMat, rx, floorH + 2.4 + (ogH - 2.4) / 2, depth / 2));
        cursor = rx + doorGap / 2;
      }
      // Last piece from last door to segment end
      const lastW = segEnd - cursor;
      if (lastW > 0.2) {
        walls.push(makeBox(lastW, ogH, wallT, wallMat, cursor + lastW / 2, floorH + ogH / 2, depth / 2));
      }
    }
    // Above entrance (no balcony doors in center gap)
    walls.push(makeBox(entranceW, ogH, wallT, wallMat, 0, floorH + ogH / 2, depth / 2));
  }
  walls.forEach(w => { w.castShadow = true; w.receiveShadow = true; hiGroup.add(w); });

  // Glass entrance auto-doors (north + south) – slide open on approach
  const doorGlassMat = getCachedMat('door_glass', () => new THREE.MeshStandardMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.25, roughness: 0.02, metalness: 0.1,
    envMap, envMapIntensity: 0.8, side: THREE.DoubleSide,
  }));
  const doorFrameMat2 = getCachedMat('door_frame', () => new THREE.MeshStandardMaterial({
    color: 0x555555, metalness: 0.5, roughness: 0.2,
  }));
  const doorH = floorH - 0.3;
  for (const faceSign of [-1, 1]) { // -1=north, +1=south
    const dz = faceSign * (depth / 2);
    // Two sliding glass panels – each slides outward when player approaches
    // Gap between closed panels must be > 2*PLAYER_RADIUS (0.8m) – using 1.5m
    const panelW = (entranceW - 1.5) / 2;
    for (const side of [-1, 1]) {
      const dx = side * (panelW / 2 + 0.75);
      addAutoDoor(hiGroup, dx, 0, dz, panelW, doorH, 'x', side * (panelW + 0.5), x, z, {
        material: doorGlassMat,
        addCollider: true,
        thinAxis: 'z',
        triggerDist: 12,   // open early so doors are fully open when player arrives
        closeDist: 15,
        speed: 15,
      });
    }
    // Metal frame: top crossbar + side pillars (static)
    hiGroup.add(makeBox(entranceW, 0.12, 0.1, doorFrameMat2, 0, doorH, dz));
    hiGroup.add(makeBox(0.1, doorH, 0.1, doorFrameMat2, -entranceW / 2, doorH / 2, dz));
    hiGroup.add(makeBox(0.1, doorH, 0.1, doorFrameMat2, entranceW / 2, doorH / 2, dz));
  }

  // Floor slabs (top = parquet, no texture needed since covered by floor-specific materials)
  const slabMat = makePBR('slab', { color: 0x5a4030, roughness: 0.8 });
  for (let f = 1; f < floors; f++) {
    const slab = makeBox(width - wallT * 2, 0.25, depth - wallT * 2, slabMat, 0, f * floorH, 0);
    slab.receiveShadow = true;
    hiGroup.add(slab);
  }

  // Roof
  const roof = makeBox(width + 1, 0.4, depth + 1, makePBR('roof', { color: 0x999999, roughness: 0.9 }), 0, totalH + 0.2, 0);
  roof.castShadow = true; roof.receiveShadow = true;
  hiGroup.add(roof);

  // Balconies + windows
  const balconyMat = makePBR('balcony', { color: 0xcccccc, roughness: 0.6 });
  const glassMat = getGlassMat();
  const balconyW = 4.2, balconyD = 1.2;  // slightly wider balconies
  const balcGap = 0.3; // gap between balconies (LED waves visible here)
  const cols = Math.floor(width / (balconyW + balcGap));
  const startX = -(cols * (balconyW + balcGap)) / 2 + balconyW / 2;
  const isFunWorld = name.includes('Fun');

  // DFW LED materials: two checkerboard colors (warm orange + cool cyan)
  const dfwLedA = isFunWorld ? new THREE.MeshStandardMaterial({
    color: 0xff6600, emissive: 0xff6600, emissiveIntensity: 1.0, roughness: 0.15,
  }) : null;
  const dfwLedB = isFunWorld ? new THREE.MeshStandardMaterial({
    color: 0x00ccff, emissive: 0x00ccff, emissiveIntensity: 1.0, roughness: 0.15,
  }) : null;
  const dfwOrangeMat = isFunWorld ? getCachedMat('balcony_orange', () => new THREE.MeshStandardMaterial({
    color: 0xff8833, roughness: 0.7, emissive: 0xff6600, emissiveIntensity: 0.15,
  })) : null;
  const dfwLedMeshesA = [];
  const dfwLedMeshesB = [];

  for (let f = 0; f < floors; f++) {
    for (let c = 0; c < cols; c++) {
      const bx = startX + c * (balconyW + balcGap);
      const by = (f + 0.5) * floorH;

      // Skip balconies in the entrance zone (ground floor, center of building)
      const inEntranceX = Math.abs(bx) < (entranceW / 2 + balconyW / 2);
      const isGroundFloor = f === 0;

      for (const faceSign of [1, -1]) { // +1=south, -1=north
        // Skip ground-floor balconies over entrance openings
        if (isGroundFloor && inEntranceX) continue;

        const fz_bal = faceSign * (depth / 2 + balconyD / 2);
        const fz_rail = faceSign * (depth / 2 + balconyD);
        const fz_win = faceSign * (depth / 2 + 0.05);

        // === BALCONY (at floor level, with furniture + partition walls) ===
        const walkY = f * floorH;
        const balcD = balconyD + 0.5; // slightly deeper balcony (1.7m instead of 1.2m)
        const fz_balDeep = faceSign * (depth / 2 + balcD / 2);
        const fz_railDeep = faceSign * (depth / 2 + balcD);

        // Platform slab
        hiGroup.add(makeBox(balconyW, 0.15, balcD, balconyMat, bx, walkY + 0.08, fz_balDeep));
        // Front glass railing
        hiGroup.add(makeBox(balconyW, 1.0, 0.05, glassMat, bx, walkY + 0.6, fz_railDeep));
        // Side partition walls (prevent walking to neighbor balcony)
        const partMat = getCachedMat('balc_part', () => new THREE.MeshStandardMaterial({
          color: 0xcccccc, roughness: 0.5, metalness: 0.1,
        }));
        hiGroup.add(makeBox(0.08, 1.2, balcD, partMat, bx - balconyW / 2, walkY + 0.7, fz_balDeep));
        hiGroup.add(makeBox(0.08, 1.2, balcD, partMat, bx + balconyW / 2, walkY + 0.7, fz_balDeep));
        // Side partition colliders (block at balcony height only)
        addCollider(x + bx - balconyW / 2, z + fz_balDeep, 0.15, balcD, walkY + 1.4, walkY - 0.5);
        addCollider(x + bx + balconyW / 2, z + fz_balDeep, 0.15, balcD, walkY + 1.4, walkY - 0.5);

        // Balcony furniture (only upper floors, skip EG)
        if (f > 0) {
          // Small table
          hiGroup.add(makeBox(0.5, 0.04, 0.5, getCachedMat('balc_table', () => new THREE.MeshStandardMaterial({
            color: 0xaaaaaa, roughness: 0.4, metalness: 0.3 })),
            bx - 0.6, walkY + 0.65, fz_balDeep));
          hiGroup.add(makeBox(0.04, 0.55, 0.04, getCachedMat('balc_leg', () => new THREE.MeshStandardMaterial({
            color: 0x666666, metalness: 0.4 })),
            bx - 0.6, walkY + 0.35, fz_balDeep));
          // Chair
          hiGroup.add(makeBox(0.4, 0.04, 0.4, getCachedMat('balc_chair', () => new THREE.MeshStandardMaterial({
            color: 0x888888, roughness: 0.5 })),
            bx + 0.6, walkY + 0.42, fz_balDeep));
          // Potted plant
          const bpotMat = getCachedMat('pot', () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
          const bplantMat = getCachedMat('plant', () => new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.8 }));
          hiGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.25, 5), bpotMat));
          hiGroup.children[hiGroup.children.length - 1].position.set(bx - balconyW / 2 + 0.3, walkY + 0.22, fz_balDeep);
          hiGroup.add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 5, 5), bplantMat));
          hiGroup.children[hiGroup.children.length - 1].position.set(bx - balconyW / 2 + 0.3, walkY + 0.5, fz_balDeep);
        }

        // Walkable floor (covers balcony + transition from interior)
        addFloor(x + bx, z + faceSign * (depth / 2 + balcD / 2), balconyW + 1, balcD + 2, walkY);
        // Front railing collider
        addCollider(x + bx, z + fz_railDeep, balconyW + 1, 0.1, walkY + 1.2, walkY - 0.5);
        if (faceSign > 0) {
          hiGroup.add(makeBox(balconyW - 0.6, floorH * 0.6, 0.08, glassMat, bx, walkY + floorH * 0.4, fz_win));
        }

        // DFW LED frames + orange panels (skip entrance zone on ground floor)
        if (isFunWorld) {
          const isCheckerA = (f + c) % 2 === 0;
          const ledMat = isCheckerA ? dfwLedA : dfwLedB;
          const ledArr = isCheckerA ? dfwLedMeshesA : dfwLedMeshesB;
          const ledT = 0.1;
          const fz = faceSign * (depth / 2 + 0.35);

          const mt = makeBox(balconyW + 0.2, ledT, ledT, ledMat, bx, by + floorH * 0.35, fz);
          const mb = makeBox(balconyW + 0.2, ledT, ledT, ledMat, bx, by - floorH * 0.35, fz);
          const ml = makeBox(ledT, floorH * 0.7 + 0.2, ledT, ledMat, bx - balconyW / 2 - 0.1, by, fz);
          const mr = makeBox(ledT, floorH * 0.7 + 0.2, ledT, ledMat, bx + balconyW / 2 + 0.1, by, fz);
          hiGroup.add(mt); hiGroup.add(mb); hiGroup.add(ml); hiGroup.add(mr);
          ledArr.push(mt, mb, ml, mr);

          if (((f * 17 + c * 31) % 10) < 3) {
            hiGroup.add(makeBox(balconyW - 0.2, floorH * 0.65, 0.04, dfwOrangeMat,
              bx, by, faceSign * (depth / 2 + 0.28)));
          }
        }
      }
    }
  }

  // Register DFW LED meshes for animation
  if (isFunWorld && dfwLedMeshesA.length > 0) {
    ledStrips.push({ meshes: dfwLedMeshesA, mat: dfwLedA, phase: ledPhase, style: 'fun_a' });
    ledStrips.push({ meshes: dfwLedMeshesB, mat: dfwLedB, phase: ledPhase + 0.5, style: 'fun_b' });
  }

  // Entrance canopies – identical on both sides (north=street, south=pool)
  const canopyMat2 = makePBR('canopy', { color: 0xdddddd, roughness: 0.5 });
  const colMat = makePBR('pillar_ext', { color: 0xeeeeee, metalness: 0.15, roughness: 0.3 });
  for (const faceSign of [-1, 1]) { // -1=north, +1=south
    const cz = faceSign * (depth / 2 + 3);
    const colZ = faceSign * (depth / 2 + 5.5);
    hiGroup.add(makeBox(20, 0.3, 6, canopyMat2, 0, 4, cz));
    for (let i = -2; i <= 2; i++) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4, 6), colMat);
      col.position.set(i * 5, 2, colZ);
      hiGroup.add(col);
    }
  }

  // Hotel interior (all 3 floors)
  _currentBuildingX = x; _currentBuildingZ = z;
  createHotelInterior(hiGroup, width, depth, floorH, name);

  // === LOW-DETAIL (shown far) – single colored box ===
  const loGroup = new THREE.Group();
  const loBox = makeBox(width, totalH, depth, wallMat, 0, totalH / 2, 0);
  loBox.castShadow = true; loBox.receiveShadow = true;
  loGroup.add(loBox);
  loGroup.add(makeBox(width + 1, 0.4, depth + 1, makePBR('roof', { color: 0x999999, roughness: 0.9 }), 0, totalH + 0.2, 0));

  // === LOD ===
  const lod = new THREE.LOD();
  lod.position.set(x, 0, z);
  lod.addLevel(hiGroup, 0);
  lod.addLevel(loGroup, LOD_FAR);
  scene.add(lod);
  lodObjects.push(lod); // Cache for fast LOD updates

  // LED strips on hi-detail
  // LEDs only on main buildings, not boutique annexes
  if (!name.includes('Boutique')) {
    createLEDStrips(hiGroup, width, depth, totalH, floorH, floors, ledPhase, name);
  }

  // Register the LOD as single spatial object (not every child mesh!)
  registerSpatial(lod);

  // Per-wall colliders – entrances on NORTH and SOUTH
  // East + West walls (full height — no doors on these sides)
  addCollider(x + width / 2, z, wallT, depth);
  addCollider(x - width / 2, z, wallT, depth);
  // South wall: EG-only collider (upper floors have balcony doors that need to pass through)
  addCollider(x - (entranceW / 2 + segW / 2), z + depth / 2, segW, wallT, floorH, 0);
  addCollider(x + (entranceW / 2 + segW / 2), z + depth / 2, segW, wallT, floorH, 0);
  // North wall: EG-only collider (same reason — upper floor rooms face north too)
  addCollider(x - (entranceW / 2 + segW / 2), z - depth / 2, segW, wallT, floorH, 0);
  addCollider(x + (entranceW / 2 + segW / 2), z - depth / 2, segW, wallT, floorH, 0);

  return lod;
}

// ---------------------------------------------------------------------------
// Lobby interior – detailed with stairs, furniture, textures
// ---------------------------------------------------------------------------
// =============================================================================
// AUTO-DOOR SYSTEM – doors slide open when player approaches
// =============================================================================
function addAutoDoor(group, x, y, z, w, h, slideAxis, slideAmount, buildingX, buildingZ, opts = {}) {
  const isGlass = opts.material && opts.material === getGlassMat();
  const woodMat = opts.material || getCachedMat('auto_door_wood', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.35, color: 0x5a4030, metalness: 0.05,
  }));
  const frameMat = getCachedMat('door_frame_dark', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.4, color: 0x3a2818, metalness: 0.1,
  }));
  const handleMat = getCachedMat('door_handle', () => new THREE.MeshStandardMaterial({
    color: 0xddccaa, metalness: 0.85, roughness: 0.15,
  }));
  const glassMat = opts.glass || getGlassMat();

  // thinAxis: perpendicular to the wall (default = opposite of slideAxis)
  const thinAxis = opts.thinAxis || (slideAxis === 'x' ? 'z' : 'x');

  // Door PANEL is a Group containing: outer frame, inner panel, glass insert, handle
  const door = new THREE.Group();
  const thickness = 0.12;  // proper door thickness (was 0.08)

  // Helper: create a door slab with correct axis layout
  // wide = the door's width direction (along wall)
  // wide is X if thinAxis='z', else Z
  function slab(matIn, dx, dy, dz, dw, dh, dt) {
    const sx = thinAxis === 'x' ? dt : dw;
    const sy = dh;
    const sz = thinAxis === 'z' ? dt : dw;
    const ox = thinAxis === 'x' ? 0 : dx;
    const oz = thinAxis === 'z' ? 0 : dx;
    return makeBox(sx, sy, sz, matIn, ox, dy, oz);
  }

  // 1. Outer frame ring (top + bottom + 2 sides) — thicker dark wood
  const frameW = 0.08; // frame thickness on the wall surface
  // Top
  door.add(slab(frameMat, 0, h - frameW / 2, 0, w, frameW, thickness + 0.02));
  // Bottom
  door.add(slab(frameMat, 0, frameW / 2, 0, w, frameW, thickness + 0.02));
  // Left + Right side rails
  door.add(slab(frameMat, -w / 2 + frameW / 2, h / 2, 0, frameW, h, thickness + 0.02));
  door.add(slab(frameMat, w / 2 - frameW / 2, h / 2, 0, frameW, h, thickness + 0.02));

  // 2. Main panel (the door body itself) — slightly inset
  const panelW = w - frameW * 2;
  const panelH = h - frameW * 2;
  door.add(slab(woodMat, 0, h / 2, 0, panelW, panelH, thickness));

  // 3. Glass insert (upper third) — only if not already a glass door
  if (!isGlass) {
    const glassW = panelW * 0.7;
    const glassH = panelH * 0.35;
    const glassY = h * 0.7;
    // Glass slightly proud of panel surface so it's visible
    door.add(slab(glassMat, 0, glassY, 0, glassW, glassH, thickness * 0.4));
    // Cross-bar dividing glass (decorative)
    door.add(slab(frameMat, 0, glassY, 0, glassW, 0.04, thickness + 0.03));
  }

  // 4. Handle — small chrome cylinder protruding from the panel
  // Positioned ~1m up, opposite to slide direction (so it's on the "inner" edge)
  const handleY = 1.0;
  const handleOffset = w * 0.35; // 35% from center toward edge
  const handleSign = slideAmount > 0 ? -1 : 1; // handle on opposite side from slide
  if (thinAxis === 'z') {
    // Wall runs along X, door's wide direction is X
    const hx = handleSign * handleOffset;
    door.add(makeBox(0.06, 0.04, thickness + 0.08, handleMat, hx, handleY, 0));
    // Knob ball
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), handleMat);
    knob.position.set(hx, handleY, thickness / 2 + 0.05);
    door.add(knob);
  } else {
    const hz = handleSign * handleOffset;
    door.add(makeBox(thickness + 0.08, 0.04, 0.06, handleMat, 0, handleY, hz));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), handleMat);
    knob.position.set(thickness / 2 + 0.05, handleY, hz);
    door.add(knob);
  }

  door.position.set(x, y, z);
  group.add(door);

  // Optional collider that moves with the door
  let colliderRef = null;
  if (opts.addCollider) {
    const cw = thinAxis === 'x' ? 0.3 : w;
    const cd = thinAxis === 'z' ? 0.3 : w;
    colliderRef = { min: { x: 0, z: 0 }, max: { x: 0, z: 0 }, maxY: Infinity };
    const wx = buildingX + x, wz = buildingZ + z;
    colliderRef.min.x = wx - cw / 2; colliderRef.max.x = wx + cw / 2;
    colliderRef.min.z = wz - cd / 2; colliderRef.max.z = wz + cd / 2;
    dynamicColliders.push(colliderRef);
  }

  autoDoors.push({
    mesh: door,
    localX: x, localZ: z,
    buildingX, buildingZ,
    slideAxis,
    slideAmount,
    isOpen: false,
    t: 0,
    closedX: x, closedZ: z,
    colliderRef,
    triggerDist: opts.triggerDist || 3,
    closeDist: opts.closeDist || 4.5,
    speed: opts.speed || 5,
  });
}

function updateLifts(cam, dt) {
  for (const lift of lifts) {
    const wx = lift.buildingX + lift.localX;
    const wz = lift.buildingZ + lift.localZ;
    const px = cam.position.x, pz = cam.position.z, py = cam.position.y;

    // Door Y tracks current floor (so doors are visible on every floor)
    const doorY = lift.currentFloor * lift.H + lift.H / 2 - 0.1;
    lift.doorL.position.y = doorY;
    lift.doorR.position.y = doorY;

    // Check if player is inside lift shaft (very generous detection)
    const floorY = lift.currentFloor * lift.H;
    const inLift = Math.abs(px - wx) < lift.w / 2 + 0.5 &&
                   Math.abs(pz - wz) < lift.d / 2 + 0.5 &&
                   py > floorY - 2 &&
                   py < floorY + lift.H + 4;

    switch (lift.state) {
      case 'idle':
        // Doors open, waiting for player to enter
        lift.doorL.position.z = lift.doorClosedZL - 1;
        lift.doorR.position.z = lift.doorClosedZR + 1;
        if (inLift) {
          lift.state = 'closing';
          lift.timer = 0;
          lift.targetFloor = (lift.currentFloor + 1) % 3;
        }
        break;

      case 'waiting':
        // Doors open, wait for player to LEAVE before accepting next trip
        lift.doorL.position.z = lift.doorClosedZL - 1;
        lift.doorR.position.z = lift.doorClosedZR + 1;
        if (!inLift) {
          // Player stepped out → ready for next trip
          lift.state = 'idle';
        }
        break;

      case 'closing':
        lift.timer += dt;
        const closeT = Math.min(1, lift.timer / 1.0);
        lift.doorL.position.z = lift.doorClosedZL - 1 + closeT * 1;
        lift.doorR.position.z = lift.doorClosedZR + 1 - closeT * 1;
        if (closeT >= 1) {
          lift.state = 'moving';
          lift.timer = 0;
        }
        break;

      case 'moving':
        lift.timer += dt;
        const moveT = Math.min(1, lift.timer / 2.0);
        const smoothT = moveT * moveT * (3 - 2 * moveT);
        const fromY = lift.currentFloor * lift.H + PLAYER_HEIGHT;
        const toY = lift.targetFloor * lift.H + PLAYER_HEIGHT;
        if (inLift || Math.abs(px - wx) < lift.w) {
          cam.position.y = fromY + (toY - fromY) * smoothT;
        }
        // Move doors with the cabin
        const cabinY = fromY + (toY - fromY) * smoothT - PLAYER_HEIGHT + lift.H / 2 - 0.1;
        lift.doorL.position.y = cabinY;
        lift.doorR.position.y = cabinY;
        if (moveT >= 1) {
          lift.currentFloor = lift.targetFloor;
          lift.state = 'opening';
          lift.timer = 0;
        }
        break;

      case 'opening':
        lift.timer += dt;
        const openT = Math.min(1, lift.timer / 1.0);
        lift.doorL.position.z = lift.doorClosedZL - openT * 1;
        lift.doorR.position.z = lift.doorClosedZR + openT * 1;
        if (openT >= 1) {
          lift.state = 'waiting'; // wait for player to exit before next trip
          lift.timer = 0;
        }
        break;
    }
  }
}

function updateAutoDoors(camX, camZ, dt) {
  for (const d of autoDoors) {
    const wx = d.buildingX + d.localX;
    const wz = d.buildingZ + d.localZ;
    const dist = Math.sqrt((camX - wx) ** 2 + (camZ - wz) ** 2);

    const shouldOpen = dist < d.triggerDist;
    const shouldClose = dist > d.closeDist;

    if (shouldOpen && !d.isOpen) d.isOpen = true;
    if (shouldClose && d.isOpen) d.isOpen = false;

    // Smooth animation (frame-rate independent exponential approach)
    const target = d.isOpen ? 1 : 0;
    d.t += (target - d.t) * (1 - Math.exp(-dt * d.speed));

    if (d.slideAxis === 'x') {
      d.mesh.position.x = d.closedX + d.t * d.slideAmount;
    } else {
      d.mesh.position.z = d.closedZ + d.t * d.slideAmount;
    }

    // Move collider with door
    if (d.colliderRef) {
      const curX = d.buildingX + d.mesh.position.x;
      const curZ = d.buildingZ + d.mesh.position.z;
      const hw = (d.colliderRef.max.x - d.colliderRef.min.x) / 2;
      const hd = (d.colliderRef.max.z - d.colliderRef.min.z) / 2;
      d.colliderRef.min.x = curX - hw; d.colliderRef.max.x = curX + hw;
      d.colliderRef.min.z = curZ - hd; d.colliderRef.max.z = curZ + hd;
    }
  }
}

// =============================================================================
// NEW HOTEL INTERIOR (Ticket 102+) – replaces old createLobbyInterior
// =============================================================================
let _currentBuildingX = 0, _currentBuildingZ = 0; // set by createHotelBuilding for door registration

function createHotelInterior(group, width, depth, floorH, name) {
  const W = width, D = depth, H = floorH, T = 0.5;
  const isWater = name.includes('Water');
  const isFun = name.includes('Fun');
  const accentColor = isWater ? 0x1155aa : isFun ? 0xff4488 : 0x44aa88;

  // Shared materials
  const marbleMat = getMarbleMat();
  const damaskMat = getCachedMat('wall_int', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xf8f2e8, roughness: 0.75,
  }));
  const ceilMat = getCachedMat('ceiling', () => new THREE.MeshStandardMaterial({
    color: 0xf5f0e8, roughness: 0.9, side: THREE.DoubleSide,
  }));
  const woodMat = getCachedMat('desk_wood', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.3, metalness: 0.02,
  }));
  const accentMat = getCachedMat('accent_' + accentColor, () => new THREE.MeshStandardMaterial({
    color: accentColor, emissive: accentColor, emissiveIntensity: 0.3, roughness: 0.2,
  }));
  const ceilPanelMat = getCachedMat('ceil_panel', () => new THREE.MeshStandardMaterial({
    color: 0xfff8f0, emissive: 0xfff5e8, emissiveIntensity: 0.6, roughness: 0.2, side: THREE.DoubleSide,
  }));

  // === ERDGESCHOSS (y=0..H) ===
  const egGroup = new THREE.Group();
  createGroundFloor(egGroup, W, D, H, T, marbleMat, damaskMat, ceilMat, woodMat, accentMat, ceilPanelMat, isWater);
  group.add(egGroup);
  floorGroups.push({ group: egGroup, buildingX: _currentBuildingX, buildingZ: _currentBuildingZ, floorNum: 0, yMin: 0, yMax: H });

  // === STAIRCASE (east side, all 3 floors – always visible) ===
  createStaircase(group, W, D, H, marbleMat, damaskMat, ceilPanelMat);

  // === 1. OG (y=H..2H) ===
  const og1Group = new THREE.Group();
  createUpperFloor(og1Group, W, D, H, 1, damaskMat, ceilMat, woodMat, ceilPanelMat, accentColor);
  group.add(og1Group);
  floorGroups.push({ group: og1Group, buildingX: _currentBuildingX, buildingZ: _currentBuildingZ, floorNum: 1, yMin: H, yMax: H * 2 });

  // === 2. OG (y=2H..3H) ===
  const og2Group = new THREE.Group();
  createUpperFloor(og2Group, W, D, H, 2, damaskMat, ceilMat, woodMat, ceilPanelMat, accentColor);
  group.add(og2Group);
  floorGroups.push({ group: og2Group, buildingX: _currentBuildingX, buildingZ: _currentBuildingZ, floorNum: 2, yMin: H * 2, yMax: H * 3 });
}

function createStaircase(group, W, D, H, marbleMat, damaskMat, ceilPanelMat) {
  const stairW = Math.min(5, W * 0.06);  // wider stairs, scaled to building
  const stairX = W / 2 - stairW / 2 - 1; // against east wall with 1m clearance
  const stairD = Math.min(10, D * 0.4);   // max 40% of building depth
  const stairStartZ = -D / 2 + 3;

  const stairMat = getCachedMat('stair_marble', () => new THREE.MeshStandardMaterial({
    map: textures.lobbyFloor, roughness: 0.3, envMap, envMapIntensity: 0.2,
  }));
  const railMat = getCachedMat('railing', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.6, roughness: 0.2,
  }));

  // Stairwell: south back wall only (west side open to lobby for easy access)
  const swH = H * 3;
  group.add(makeBox(stairW + 1, swH, 0.15, damaskMat, stairX, swH / 2, stairStartZ + stairD + 1));
  // North wall with door opening per floor
  for (let fl = 0; fl < 3; fl++) {
    const fy = fl * H;
    // Above door
    group.add(makeBox(stairW + 0.5, H - 2.5, 0.15, damaskMat, stairX, fy + 2.5 + (H - 2.5) / 2, stairStartZ - 0.5));
  }

  // Steps for all 3 flights (EG→1.OG, 1.OG→2.OG, 2.OG→roof-landing)
  for (let flight = 0; flight < 2; flight++) {
    const baseY = flight * H;
    const stepsPerFlight = 20;
    const stepH = H / stepsPerFlight;
    const stepD = stairD / stepsPerFlight;

    for (let s = 0; s < stepsPerFlight; s++) {
      const sy = baseY + (s + 0.5) * stepH;
      const sz = stairStartZ + s * stepD;
      const step = makeBox(stairW, stepH, stepD, stairMat, stairX, sy, sz);
      step.receiveShadow = true;
      group.add(step);
    }

    // Railing (inner side, west)
    const railLen = Math.sqrt(stairD * stairD + H * H);
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, railLen, 4), railMat);
    rail.position.set(stairX - stairW / 2 + 0.3, baseY + H / 2, stairStartZ + stairD / 2);
    rail.rotation.x = Math.atan2(H, stairD);
    group.add(rail);

    // Railing posts every 4 steps
    for (let s = 0; s <= stepsPerFlight; s += 4) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 4), railMat);
      post.position.set(stairX - stairW / 2 + 0.3, baseY + s * stepH + 0.5, stairStartZ + s * stepD);
      group.add(post);
    }

    // Landing platform at top of each flight
    const landingY = (flight + 1) * H;
    group.add(makeBox(stairW + 1, 0.3, 3, stairMat, stairX, landingY, stairStartZ + stairD + 0.5));

    // Light on each landing
    group.add(makeBox(1.5, 0.04, 1, ceilPanelMat, stairX, landingY + H - 0.1, stairStartZ + stairD / 2));
  }
}

function createGroundFloor(group, W, D, H, T, marbleMat, damaskMat, ceilMat, woodMat, accentMat, ceilPanelMat, isWater) {
  // ═══════════════════════════════════════════════════════════════
  // REALISTIC HOTEL GROUND FLOOR LAYOUT
  // ═══════════════════════════════════════════════════════════════
  //
  // NORD (Straße, Eingang)
  // ┌──────┬───────────────────────────────────┬──────────┐
  // │ LIFT │          LOBBY                     │ TREPPE   │
  // │      │   Sofas, Kronleuchter, Pflanzen    │          │
  // │ WC   │   ──── Reception ────              │          │
  // │      ├──────────────┬────────────────────┤          │
  // │      │  BAR/LOUNGE  │   RESTAURANT       │          │
  // │      │  Bartresen   │   Tische           │          │
  // └──────┴──────────────┴────────────────────┴──────────┘
  // SÜD (Pool)
  //
  const y = 0;
  const bx = _currentBuildingX, bz = _currentBuildingZ;

  // Layout constants
  const liftW2 = 4, liftD2 = 4;                     // lift shaft area
  const stairArea = 5;                                // stairwell buffer
  const sideW = Math.min(8, W * 0.12);                // width reserved for lift/stair sides
  const lobbyD = D * 0.55;                            // lobby takes 55% of depth (north)
  const serviceD = D - lobbyD;                        // bar/restaurant (south)
  const wcW = Math.min(8, W * 0.15), wcD = Math.min(6, D * 0.25); // WC dimensions (scaled)

  // === FLOOR + CEILING ===
  const floorBox = makeBox(W - 1, 0.3, D - 1, marbleMat, 0, 0.15, 0);
  floorBox.receiveShadow = true;
  group.add(floorBox);
  // Decorative ceiling — visible damask with warm tint
  // (makeBox auto-scales UVs by surface area; for large rooms this gives proper tiling)
  const ceilDecorMat = getCachedMat('ceil_decor', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xe8c878, roughness: 0.7, metalness: 0.1,
  }));
  group.add(makeBox(W - 1, 0.08, D - 1, ceilDecorMat, 0, H - 0.5, 0));

  // === DAMASK WALLPAPER PANELS (cover interior face of exterior walls) ===
  const wallpaperMat = getCachedMat('wallpaper_eg', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xf8efd6, roughness: 0.78,
  }));
  // West wall (interior side)
  group.add(makeBox(0.06, H - 0.4, D - 1, wallpaperMat, -W / 2 + 0.4, (H - 0.4) / 2 + 0.2, 0));
  // East wall (interior side)
  group.add(makeBox(0.06, H - 0.4, D - 1, wallpaperMat, W / 2 - 0.4, (H - 0.4) / 2 + 0.2, 0));
  // North wall (left + right of entrance gap)
  const npW = (W - 14) / 2;
  group.add(makeBox(npW, H - 0.4, 0.06, wallpaperMat, -(npW / 2 + 7), (H - 0.4) / 2 + 0.2, -D / 2 + 0.4));
  group.add(makeBox(npW, H - 0.4, 0.06, wallpaperMat, (npW / 2 + 7), (H - 0.4) / 2 + 0.2, -D / 2 + 0.4));
  // South wall (left + right of entrance gap)
  group.add(makeBox(npW, H - 0.4, 0.06, wallpaperMat, -(npW / 2 + 7), (H - 0.4) / 2 + 0.2, D / 2 - 0.4));
  group.add(makeBox(npW, H - 0.4, 0.06, wallpaperMat, (npW / 2 + 7), (H - 0.4) / 2 + 0.2, D / 2 - 0.4));

  // Helper: add wall + collider in one call (LOCAL coords → world via bx/bz)
  // maxY = H so EG walls don't block upper floors (1.OG/2.OG have their own walls)
  function wall(wx, wz, ww, wd, mat, label) {
    group.add(makeBox(ww, H, wd, mat || damaskMat, wx, H / 2, wz));
    addCollider(bx + wx, bz + wz, ww, wd, H, 0);
  }

  // === PARTITION: Lobby/Service divider (horizontal, across building) ===
  // lobbyD from north, serviceD from south
  const divZ = -D / 2 + lobbyD; // divider Z position
  // Two segments with 4m opening in center
  const divSegW = (W - sideW * 2 - 4) / 2;
  wall(-(divSegW / 2 + 2 + sideW / 2), divZ, divSegW, T, damaskMat);
  wall((divSegW / 2 + 2 + sideW / 2), divZ, divSegW, T, damaskMat);

  // === PARTITION: Bar | Restaurant divider (vertical, south half) ===
  const barW = (W - sideW * 2) * 0.45; // bar = 45% of center
  const restW = (W - sideW * 2) - barW; // restaurant = 55%
  const barCenterX = -W / 2 + sideW + barW / 2;
  const restCenterX = -W / 2 + sideW + barW + restW / 2;
  const serviceZ = divZ + serviceD / 2; // center of service area
  wall(-W / 2 + sideW + barW, serviceZ, T, serviceD - 1, damaskMat);

  // === WC ROOM (northwest, next to lift) ===
  const wcX = -W / 2 + sideW / 2;
  const wcZ = -D / 2 + lobbyD / 2 + 2;
  // WC south wall
  wall(wcX, wcZ + wcD / 2, wcW, T, damaskMat);
  // WC east wall (with 1.2m door opening at south end)
  const wcEastSegD = wcD - 1.5;
  wall(wcX + wcW / 2, wcZ - wcD / 2 + wcEastSegD / 2, T, wcEastSegD, damaskMat);
  // WC door
  addAutoDoor(group, wcX + wcW / 2, 0, wcZ + wcD / 2 - 0.6, 1.2, 2.2, 'z', -1.5,
    _currentBuildingX, _currentBuildingZ, { thinAxis: 'x' });

  // Shared ceramic/chrome materials for WC fixtures
  const ceramicMat = getCachedMat('ceramic_white', () => new THREE.MeshStandardMaterial({
    color: 0xf2f2f0, roughness: 0.15, metalness: 0.02, envMap, envMapIntensity: 0.3,
  }));
  const chromeMat = getCachedMat('chrome', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.9, roughness: 0.05, envMap, envMapIntensity: 0.6,
  }));
  const wcMirrorMat = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({
    color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0,
  }));
  // WC tile floor
  const tileMat = getCachedMat('wc_tiles', () => new THREE.MeshStandardMaterial({
    color: 0xd8d0c8, roughness: 0.25,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  group.add(makePlane(wcW - 1, wcD - 1, tileMat, wcX, 0.35, wcZ));
  // Stall partitions + toilets
  const stallWallMat = getCachedMat('stall_wall', () => new THREE.MeshStandardMaterial({ map: textures.concrete, color: 0xcccccc, roughness: 0.6 }));
  for (let si = 0; si < 3; si++) {
    const sz = wcZ - wcD / 2 + 1.5 + si * 1.8;
    if (si > 0) group.add(makeBox(1.8, 1.8, 0.08, stallWallMat, wcX - 1.5, 1.1, sz - 0.9));
    createToilet(group, wcX - 2, 0, sz, ceramicMat, chromeMat);
  }
  // Sinks
  for (let si = 0; si < 2; si++) {
    const sz = wcZ - 1 + si * 2;
    createSink(group, wcX + 2, 0, sz, ceramicMat, chromeMat, wcMirrorMat, 'x');
  }
  // WC ceiling light
  group.add(makeBox(2, 0.04, 2, ceilPanelMat, wcX, H - 0.12, wcZ));

  // === LIFT SHAFT (handled by createGroundFloor caller, just label area) ===
  const liftX = -W / 2 + 4;
  const liftZ = -D / 2 + 4;
  // Lift shaft walls + colliders
  const liftW = 3.5, liftD = 3.5;
  const liftTotalH = H * 3;
  const liftMetalMat = getCachedMat('lift_metal', () => new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.6, roughness: 0.2 }));
  const liftWallMat = getCachedMat('lift_wall', () => new THREE.MeshStandardMaterial({ map: textures.marbleWall, color: 0xeeeae0, roughness: 0.3, metalness: 0.15 }));
  group.add(makeBox(0.15, liftTotalH, liftD, liftWallMat, liftX - liftW / 2, liftTotalH / 2, liftZ));
  group.add(makeBox(liftW, liftTotalH, 0.15, liftWallMat, liftX, liftTotalH / 2, liftZ - liftD / 2));
  group.add(makeBox(liftW, liftTotalH, 0.15, liftWallMat, liftX, liftTotalH / 2, liftZ + liftD / 2));
  group.add(makeBox(0.15, liftTotalH, (liftD - 2) / 2, liftMetalMat, liftX + liftW / 2, liftTotalH / 2, liftZ - liftD / 2 + (liftD - 2) / 4));
  group.add(makeBox(0.15, liftTotalH, (liftD - 2) / 2, liftMetalMat, liftX + liftW / 2, liftTotalH / 2, liftZ + liftD / 2 - (liftD - 2) / 4));
  for (let fl = 0; fl < 3; fl++) group.add(makeBox(0.15, 0.5, 2, liftMetalMat, liftX + liftW / 2, (fl + 1) * H - 0.25, liftZ));
  addCollider(bx + liftX - liftW / 2, bz + liftZ, 0.3, liftD);
  addCollider(bx + liftX, bz + liftZ - liftD / 2, liftW, 0.3);
  addCollider(bx + liftX, bz + liftZ + liftD / 2, liftW, 0.3);
  // Lift doors
  const liftDoorMat = getCachedMat('lift_door', () => new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.7, roughness: 0.15 }));
  const liftDoorL = makeBox(0.06, H - 0.8, 1, liftDoorMat, liftX + liftW / 2 + 0.05, H / 2 - 0.1, liftZ - 0.5);
  const liftDoorR = makeBox(0.06, H - 0.8, 1, liftDoorMat, liftX + liftW / 2 + 0.05, H / 2 - 0.1, liftZ + 0.5);
  group.add(liftDoorL); group.add(liftDoorR);
  lifts.push({
    buildingX: _currentBuildingX, buildingZ: _currentBuildingZ,
    localX: liftX, localZ: liftZ, w: liftW, d: liftD, H,
    currentFloor: 0, state: 'idle', timer: 0, targetFloor: 0,
    doorL: liftDoorL, doorR: liftDoorR,
    doorClosedZL: liftZ - 0.5, doorClosedZR: liftZ + 0.5,
  });
  // Lift interior (mirror, buttons, light)
  const mirrorMat2 = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({ color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0 }));
  group.add(makeBox(0.04, H - 1.5, liftD - 0.5, mirrorMat2, liftX - liftW / 2 + 0.1, H / 2, liftZ));
  const btnPanelMat = getCachedMat('btn_panel', () => new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5, metalness: 0.3 }));
  group.add(makeBox(0.3, 0.6, 0.04, btnPanelMat, liftX, 1.3, liftZ + liftD / 2 - 0.1));
  const btnGlow = new THREE.MeshStandardMaterial({ color: 0x44ff44, emissive: 0x44ff44, emissiveIntensity: 0.8 });
  for (let bi = 0; bi < 3; bi++) group.add(makeBox(0.08, 0.08, 0.02, btnGlow, liftX, 1.1 + bi * 0.15, liftZ + liftD / 2 - 0.08));
  group.add(makeBox(1.5, 0.04, 1.5, ceilPanelMat, liftX, H - 0.1, liftZ));

  // === LOBBY FURNITURE ===
  // Chandelier
  const chandelierMat = getCachedMat('chandelier', () => new THREE.MeshStandardMaterial({ color: 0xddcc88, metalness: 0.6, roughness: 0.2 }));
  const chandelierGlow = new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0.8 });
  const lobbyCenter = -D / 2 + lobbyD / 2;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.08, 8, 20), chandelierMat);
  ring.position.set(0, H - 0.6, lobbyCenter); ring.rotation.x = Math.PI / 2; group.add(ring);
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 4), chandelierMat));
  group.children[group.children.length - 1].position.set(0, H - 0.3, lobbyCenter);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), chandelierGlow);
    bulb.position.set(Math.cos(a) * 2, H - 0.6, lobbyCenter + Math.sin(a) * 2); group.add(bulb);
  }

  // Sofas (2 groups in lobby)
  const sofaMat = getCachedMat('sofa_lobby', () => new THREE.MeshStandardMaterial({ color: isWater ? 0x2a4a6a : 0x6a2a3a, roughness: 0.85 }));
  const sofaSpread = Math.min(18, W / 2 - sideW - 3);
  for (const side of [-1, 1]) {
    const sx = side * sofaSpread, sz = lobbyCenter;
    group.add(makeBox(4, 0.4, 1.2, sofaMat, sx, 0.55, sz));
    group.add(makeBox(4, 0.5, 0.2, sofaMat, sx, 0.9, sz - 0.5));
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx - 1.9, 0.8, sz));
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx + 1.9, 0.8, sz));
  }
  // Coffee table
  group.add(makeBox(2.5, 0.05, 1, woodMat, 0, 0.55, lobbyCenter));
  // Lobby rug
  const rugMat = getCachedMat('rug_' + (isWater ? 'w' : 'f'), () => new THREE.MeshStandardMaterial({
    color: isWater ? 0x1a3a5a : 0x5a1a2a, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
  }));
  group.add(makePlane(12, 8, rugMat, 0, 0.35, lobbyCenter));
  // Plants
  const potMat = getCachedMat('pot', () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
  const plantMat = getCachedMat('plant', () => new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.8 }));
  const plantX = Math.min(30, W / 2 - 5);
  for (const [px, pz] of [[-plantX, -D / 2 + 3], [plantX, -D / 2 + 3], [-plantX, divZ - 1], [plantX, divZ - 1]]) {
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.6, 6), potMat));
    group.children[group.children.length - 1].position.set(px, 0.45, pz);
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), plantMat));
    group.children[group.children.length - 1].position.set(px, 1.1, pz);
  }

  // === RECEPTION DESK (center of lobby, facing north entrance) ===
  const deskTopMat = getCachedMat('desk_top', () => new THREE.MeshStandardMaterial({ color: 0x2a1a08, roughness: 0.15, envMap, envMapIntensity: 0.3 }));
  const rX = 0, rZ = lobbyCenter + 3;
  group.add(makeBox(10, 1.0, 1.5, woodMat, rX, 0.65, rZ));
  group.add(makeBox(10.2, 0.06, 1.7, deskTopMat, rX, 1.17, rZ));
  group.add(makeBox(10, 0.1, 0.05, accentMat, rX, 0.9, rZ + 0.8));
  // Monitors
  const monMat = getCachedMat('monitor', () => new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.3 }));
  const screenMat2 = new THREE.MeshStandardMaterial({ color: 0x88ccff, emissive: 0x88ccff, emissiveIntensity: 0.4 });
  for (const mx of [-3, 0, 3]) {
    group.add(makeBox(0.6, 0.4, 0.04, monMat, rX + mx, 1.45, rZ - 0.2));
    group.add(makeBox(0.5, 0.3, 0.02, screenMat2, rX + mx, 1.45, rZ - 0.22));
  }

  // === BAR (south-west) ===
  group.add(makeBox(barW * 0.6, 1.1, 0.6, woodMat, barCenterX, 0.55, divZ + 2));
  group.add(makeBox(barW * 0.6 + 0.1, 0.05, 0.7, deskTopMat, barCenterX, 1.12, divZ + 2));
  // Bar stools
  const stoolCount = Math.max(2, Math.floor(barW / 4));
  for (let i = 0; i < stoolCount; i++) {
    const sx2 = barCenterX - barW * 0.3 + i * (barW * 0.6) / Math.max(1, stoolCount - 1);
    group.add(makeBox(0.35, 0.03, 0.35, getCachedMat('stool', () => new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.7 })), sx2, 0.7, divZ + 3));
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.7, 6), getCachedMat('stool_leg', () => new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5 }))));
    group.children[group.children.length - 1].position.set(sx2, 0.35, divZ + 3);
  }

  // === RESTAURANT (south-east, tables) ===
  const tableMat = getCachedMat('table_rest', () => new THREE.MeshStandardMaterial({ map: textures.woodWalnut, roughness: 0.35 }));
  const restZCenter = divZ + serviceD / 2;
  const tableRows = Math.max(1, Math.floor(serviceD / 5));
  const tableCols = Math.max(1, Math.floor(restW / 5));
  for (let row = 0; row < tableRows; row++) {
    for (let col = 0; col < tableCols; col++) {
      const tx = restCenterX - restW / 2 + 3 + col * (restW - 6) / Math.max(1, tableCols - 1 || 1);
      const tz = restZCenter - serviceD / 2 + 3 + row * (serviceD - 4) / Math.max(1, tableRows - 1 || 1);
      group.add(makeBox(1.2, 0.04, 1.2, tableMat, tx, 0.75, tz));
      group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.73, 6),
        getCachedMat('table_leg', () => new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.3 }))));
      group.children[group.children.length - 1].position.set(tx, 0.375, tz);
      // 4 chairs per table
      for (const [cdx, cdz] of [[-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]]) {
        group.add(makeBox(0.4, 0.03, 0.4, getCachedMat('chair_rest', () => new THREE.MeshStandardMaterial({ color: isWater ? 0x2a4a6a : 0x6a2a3a, roughness: 0.8 })), tx + cdx, 0.45, tz + cdz));
      }
    }
  }

  // === ACCENT STRIP (south interior wall) ===
  group.add(makeBox(W - 2, 0.6, 0.07, accentMat, 0, 0.3, D / 2 - 0.5));

  // === LIGHTING (3 pendant lights) ===
  const lightPositions = [
    { x: 0, z: lobbyCenter, int: 4 },         // lobby center
    { x: barCenterX, z: restZCenter, int: 3 }, // bar/restaurant
    { x: restCenterX, z: restZCenter, int: 3.5 }, // restaurant
  ];
  for (const lp of lightPositions) {
    const pl = new THREE.PointLight(0xfff0dd, lp.int, 45);
    pl.position.set(lp.x, H - 1.5, lp.z);
    pl._dayIntensity = lp.int;
    group.add(pl);
    lobbyLights.push(pl);
    group.add(makeBox(3.5, 0.06, 1.2, ceilPanelMat, lp.x, H - 0.08, lp.z));
    group.add(makeBox(0.03, 1.4, 0.03, getCachedMat('pendant_rod', () =>
      new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5 })),
      lp.x, H - 0.75, lp.z));
  }
}

// =============================================================================
// UPPER FLOOR (1.OG or 2.OG) – Central Hallway + 12 Rooms
// =============================================================================
function createUpperFloor(group, W, D, H, floorNum, damaskMat, ceilMat, woodMat, ceilPanelMat, accentColor) {
  // ═══════════════════════════════════════════════════════════════
  // REALISTIC HOTEL FLOOR: 12 rooms (6 north, 6 south), central hallway
  //
  // ┌──────┬───┬───┬───┬───┬───┬───┬──────────────┬─────────┐
  // │ LIFT │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │              │ TREPPE  │
  // │      ├───┴───┴───┴───┴───┴───┤  (open area)  │         │
  // │      │     HALLWAY (3m)       │              │         │
  // │      ├───┬───┬───┬───┬───┬───┤              │         │
  // │      │ 7 │ 8 │ 9 │10 │11 │12 │              │         │
  // └──────┴───┴───┴───┴───┴───┴───┴──────────────┴─────────┘
  //
  const y = floorNum * H;
  const ubx = _currentBuildingX, ubz = _currentBuildingZ;

  // Layout
  const sideW = Math.min(8, W * 0.12); // reserved for lift/staircase (scaled for small buildings)
  const hallD2 = 3; // hallway depth
  const hallZ = 0;  // hallway centered in building
  const roomsW = W - sideW * 2; // usable width for rooms
  const roomCount = Math.max(1, Math.floor(roomsW / 8)); // ~8m per room (realistic hotel room width)
  const roomW = roomsW / roomCount;
  const roomDN = (D - hallD2) / 2 - 0.5; // north room depth
  const roomDS = (D - hallD2) / 2 - 0.5; // south room depth
  const roomStartX = -W / 2 + sideW;

  // Materials
  const laminateMat = getCachedMat('laminate', () => new THREE.MeshStandardMaterial({
    map: textures.parquet, color: 0xeae0d0, roughness: 0.45,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  const wallRoomMat = getCachedMat('wall_room', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xf0ebe0, roughness: 0.8,
  }));
  const doorFrameMat = getCachedMat('doorframe', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.35, color: 0x8a7060,
  }));
  const glassMat2 = getCachedMat('glass_door', () => new THREE.MeshStandardMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.2, roughness: 0.02,
    envMap, envMapIntensity: 0.7,
  }));
  const bedFrameMat = getCachedMat('bedframe', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.4,
  }));
  const bedMat = getCachedMat('bedsheet', () => new THREE.MeshStandardMaterial({
    color: 0xf5f0e8, roughness: 0.9,
  }));
  const nightMat = getCachedMat('nightstand', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.35,
  }));

  // === FLOOR SLAB ===
  const slabW = W - 6; // leave openings for stairwell and lift
  group.add(makeBox(slabW, 0.3, D - 2, laminateMat, 0, y, 0));

  // === CEILING (textured box, ornate tinted damask) ===
  const ceilDecorMat = getCachedMat('ceil_decor', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xe8c878, roughness: 0.7, metalness: 0.1,
  }));
  group.add(makeBox(W - 2, 0.08, D - 2, ceilDecorMat, 0, y + H - 0.5, 0));

  // === HALLWAY (runs full building width, connects lift to staircase) ===
  const hallNorth = hallZ - hallD2 / 2;  // = -1.5
  const hallSouth = hallZ + hallD2 / 2;  // = +1.5
  // Carpet runner
  group.add(makePlane(W - 4, hallD2 - 0.3, getCachedMat('carpet_hall', () => new THREE.MeshStandardMaterial({
    color: accentColor, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -14,
  })), 0, y + 0.2, hallZ));

  // Hallway lights (3 panels + 1 PointLight)
  for (let hx = -W / 4; hx <= W / 4; hx += W / 4) {
    group.add(makeBox(2, 0.04, 1, ceilPanelMat, hx, y + H - 0.1, hallZ));
  }
  const hallLight = new THREE.PointLight(0xfff5e0, 1.5, 30);
  hallLight.position.set(0, y + H - 1.5, hallZ);
  hallLight._dayIntensity = 1.5;
  group.add(hallLight);
  lobbyLights.push(hallLight);

  // === ROOMS (6 north + 6 south) ===
  for (let side = 0; side < 2; side++) { // 0=north, 1=south
    const isSouth = side === 1;
    const roomD2 = isSouth ? roomDS : roomDN;
    const faceSign = isSouth ? 1 : -1;
    const hallEdge = isSouth ? hallSouth : hallNorth;
    const rz = hallEdge + faceSign * (roomD2 / 2 + 0.25); // room center Z

    for (let r = 0; r < roomCount; r++) {
      const rx = roomStartX + r * roomW + roomW / 2;

      // Room partition wall (between adjacent rooms)
      if (r > 0) {
        group.add(makeBox(0.15, H - 0.5, roomD2, wallRoomMat, rx - roomW / 2, y + (H - 0.5) / 2, rz));
        addCollider(ubx + rx - roomW / 2, ubz + rz, 0.3, roomD2, y + H, y);
      }

      // Hallway wall with door opening (door EXACTLY matches wall opening)
      const doorW2 = 2.0;
      const doorH2 = 2.2;
      const openingW = doorW2; // door fills the opening completely
      const wallSegW = (roomW - openingW) / 2;
      if (wallSegW > 0.3) {
        // Left segment (full from room edge to opening)
        group.add(makeBox(wallSegW, H - 0.5, 0.15, wallRoomMat, rx - roomW / 2 + wallSegW / 2, y + (H - 0.5) / 2, hallEdge));
        addCollider(ubx + rx - roomW / 2 + wallSegW / 2, ubz + hallEdge, wallSegW, 0.3, y + H, y);
        // Right segment
        group.add(makeBox(wallSegW, H - 0.5, 0.15, wallRoomMat, rx + roomW / 2 - wallSegW / 2, y + (H - 0.5) / 2, hallEdge));
        addCollider(ubx + rx + roomW / 2 - wallSegW / 2, ubz + hallEdge, wallSegW, 0.3, y + H, y);
      }
      // Wall above door (lintel)
      const lintelH = H - 0.5 - doorH2;
      if (lintelH > 0.1) {
        group.add(makeBox(openingW, lintelH, 0.15, wallRoomMat, rx, y + doorH2 + lintelH / 2, hallEdge));
        addCollider(ubx + rx, ubz + hallEdge, openingW, 0.3, y + H, y + doorH2);
      }
      // Auto-door (snugly fits the opening)
      addAutoDoor(group, rx, y, hallEdge, doorW2, doorH2, 'x', doorW2 + 0.3,
        _currentBuildingX, _currentBuildingZ, { thinAxis: 'z' });

      // Room floor
      group.add(makePlane(roomW - 1, roomD2 - 1, laminateMat, rx, y + 0.2, rz));

      // === BED (against outer wall) ===
      const outerZ = rz + faceSign * (roomD2 / 2 - 1.5);
      group.add(makeBox(2.2, 0.35, 1.8, bedFrameMat, rx, y + 0.32, outerZ));
      group.add(makeBox(2.0, 0.2, 1.6, bedMat, rx, y + 0.55, outerZ));
      group.add(makeBox(2.2, 0.8, 0.1, bedFrameMat, rx, y + 0.85, outerZ + faceSign * (-0.85)));
      // Nightstand
      group.add(makeBox(0.5, 0.5, 0.4, nightMat, rx + 1.4, y + 0.4, outerZ));
      // Lamp
      group.add(makeBox(0.15, 0.3, 0.15, getCachedMat('roomlamp', () => new THREE.MeshStandardMaterial({
        color: 0xffeecc, emissive: 0xffddaa, emissiveIntensity: 0.6 })),
        rx + 1.4, y + 0.8, outerZ));

      // === BALCONY GLASS DOOR (south rooms only, at outer wall → leads to balcony) ===
      if (isSouth) {
        const balcDoorZ = D / 2 - 0.15; // at the building exterior wall
        addAutoDoor(group, rx, y, balcDoorZ, 2.0, 2.2, 'x', 2.3,
          _currentBuildingX, _currentBuildingZ, {
            thinAxis: 'z',
            material: glassMat2, // transparent glass door
          });
        // Fixed glass panel above door
        group.add(makeBox(2.0, 0.8, 0.08, glassMat2, rx, y + 2.6, balcDoorZ));
      }

      // === BATHROOM (corner of room, near hallway) ===
      if (r % 3 === 0) { // every 3rd room has detailed bathroom (performance)
        const bathW2 = 2.5, bathD3 = 2.5;
        const bathX = rx - roomW / 2 + bathW2 / 2 + 0.5;
        const bathZ = rz - faceSign * (roomD2 / 2 - bathD3 / 2 - 0.5);
        // Partition wall
        group.add(makeBox(0.12, H - 1, bathD3, wallRoomMat, bathX + bathW2 / 2, y + (H - 1) / 2, bathZ));
        // Fixtures
        const ceramicM = getCachedMat('ceramic_white', () => new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.15, metalness: 0.02, envMap, envMapIntensity: 0.3 }));
        const chromeM = getCachedMat('chrome', () => new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.05, envMap, envMapIntensity: 0.6 }));
        const mirrorM = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({ color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0 }));
        createToilet(group, bathX - 0.3, y, bathZ - 0.5 * faceSign, ceramicM, chromeM);
        createSink(group, bathX + 0.8, y, bathZ + 0.3 * faceSign, ceramicM, chromeM, mirrorM);
      }

      // Room ceiling light
      const ceilLampMat = getCachedMat('ceillamp', () => new THREE.MeshStandardMaterial({
        color: 0xfff8f0, emissive: 0xfff0dd, emissiveIntensity: 0.5, side: THREE.DoubleSide,
      }));
      group.add(makeBox(1.2, 0.04, 1.2, ceilLampMat, rx, y + H - 0.12, rz));
    }
  }
}
// =============================================================================
// KUMKÖY CITY – Streets, Shops, Restaurants, Neon Lights
// =============================================================================
function createCity(scene) {
  // City forms a RING around the hotels
  // North: z=-95 to z=-230 (shopping street)
  // East: x=160 to x=250 (east wing)
  // West: x=-160 to x=-250 (west wing)
  const cityZStart = -95, cityZEnd = -230;
  const cityXMin = -250, cityXMax = 250;
  const blockSize = 40, streetW = 8;
  const cityGroup = new THREE.Group();

  // === MATERIALS (textured, realistic) ===
  const roadMat2 = getCachedMat('city_road', () => new THREE.MeshStandardMaterial({
    color: 0x333333, roughness: 0.9, map: textures.concrete,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
  const sidewalkMat2 = getCachedMat('city_sidewalk', () => new THREE.MeshStandardMaterial({
    map: textures.concrete, color: 0xccccbb, roughness: 0.75,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
  const shopRoofMat = getCachedMat('shop_roof', () => new THREE.MeshStandardMaterial({
    color: 0xcc6633, roughness: 0.8,
  }));
  const glassMat3 = getCachedMat('shopglass', () => new THREE.MeshStandardMaterial({
    color: 0x88aacc, transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0.1,
    envMap, envMapIntensity: 0.6,
  }));
  const curbMat = getCachedMat('curb', () => new THREE.MeshStandardMaterial({
    color: 0x999999, roughness: 0.7,
  }));
  const benchMat = getCachedMat('bench', () => new THREE.MeshStandardMaterial({
    color: 0x5a4030, roughness: 0.6,
  }));
  const binMat = getCachedMat('bin', () => new THREE.MeshStandardMaterial({
    color: 0x444444, metalness: 0.3, roughness: 0.5,
  }));

  // Facade textures (5 distinct variations using brick/stone/plaster textures)
  const facadeTexKeys = ['facadeBrickRed', 'facadeBrickTan', 'facadePlasterStone', 'facadeStone', 'facadePlaster'];
  const facadeColors = [0xf5e8d8, 0xe8dccc, 0xddd0b8, 0xf0e0c0, 0xe8d5bf]; // subtle tints
  const facadeMats = facadeTexKeys.map((key, i) =>
    getCachedMat('facade_' + i, () => new THREE.MeshStandardMaterial({
      map: textures[key], color: facadeColors[i], roughness: 0.85,
    }))
  );

  // Sockel (dark base) material
  const sockelMat = getCachedMat('sockel', () => new THREE.MeshStandardMaterial({
    color: 0x6a6058, roughness: 0.9,
  }));

  // Shopfront warm glow (behind glass, simulates lit interior)
  const interiorGlowMat = getCachedMat('shop_glow', () => new THREE.MeshStandardMaterial({
    color: 0xffeedd, emissive: 0xffddbb, emissiveIntensity: 0.5, roughness: 0.9,
  }));

  // === STREETS (use thin BoxGeometry to avoid z-fighting with ground plane) ===
  for (let x = cityXMin; x <= cityXMax; x += blockSize + streetW) {
    const r = makeBox(streetW, 0.12, Math.abs(cityZEnd - cityZStart), roadMat2, x, 0.06, (cityZStart + cityZEnd) / 2);
    r.receiveShadow = true; cityGroup.add(r);
  }
  for (let z = cityZStart - streetW; z >= cityZEnd; z -= blockSize + streetW) {
    const r = makeBox(cityXMax - cityXMin, 0.12, streetW, roadMat2, 0, 0.06, z);
    r.receiveShadow = true; cityGroup.add(r);
    // Sidewalks (raised boxes, no z-fighting)
    for (const side of [-1, 1]) {
      const sw = makeBox(cityXMax - cityXMin, 0.15, 2.5, sidewalkMat2, 0, 0.1, z + side * (streetW / 2 + 1.25));
      sw.receiveShadow = true; cityGroup.add(sw);
      // Curb edge
      cityGroup.add(makeBox(cityXMax - cityXMin, 0.2, 0.2, curbMat, 0, 0.17, z + side * streetW / 2));
    }
    // Zebra crossings (on top of road boxes)
    for (let cx = cityXMin; cx <= cityXMax; cx += blockSize + streetW) {
      for (let stripe = -3; stripe <= 3; stripe++) {
        cityGroup.add(makeBox(1.2, 0.02, 0.5, getCachedMat('zebra', () => new THREE.MeshStandardMaterial({
          color: 0xeeeeee, roughness: 0.8,
        })), cx, 0.13, z + stripe * 1));
      }
    }
  }

  // === SHOPS (textured, with windows, doors, sockel, schaufenster) ===
  const neonColors = [0xff4488, 0x44ff88, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xff6633, 0x33ffcc];
  const awningColors = [0xcc3333, 0x3333cc, 0x33cc33, 0xccaa33, 0xcc33aa];

  let shopCount = 0;
  for (let bx = cityXMin + streetW; bx < cityXMax - blockSize; bx += blockSize + streetW) {
    for (let bz = cityZStart - streetW - 2; bz > cityZEnd + blockSize; bz -= blockSize + streetW) {
      const shopsOnEdge = 2 + Math.floor(Math.random() * 3);
      const shopW = (blockSize - 4) / shopsOnEdge;

      for (let si = 0; si < shopsOnEdge; si++) {
        const sx = bx + 2 + si * shopW + shopW / 2;
        const sz = bz - 1;
        const sH = 4 + Math.random() * 3;
        const sD = 6 + Math.random() * 4;
        const facadeMat = facadeMats[shopCount % 5];

        // Main building walls (4 sides, door in FRONT next to schaufenster)
        const shopBodyW = shopW - 1;
        const shopCZ = sz - sD / 2; // center Z of shop interior
        const doorW3 = 1.2; // door width
        // Left wall (full)
        cityGroup.add(makeBox(0.3, sH, sD, facadeMat, sx - shopBodyW / 2, sH / 2, shopCZ));
        // Right wall (full)
        cityGroup.add(makeBox(0.3, sH, sD, facadeMat, sx + shopBodyW / 2, sH / 2, shopCZ));
        // Back wall (full)
        cityGroup.add(makeBox(shopBodyW, sH, 0.3, facadeMat, sx, sH / 2, sz - sD + 0.15));
        // Front wall: [left segment] [door gap] [schaufenster gap] [right segment]
        // Door on the right side of front, schaufenster on the left
        const winW = shopBodyW * 0.55; // schaufenster = 55% of front
        const doorSegW = shopBodyW - winW - doorW3 - 0.3; // remaining wall between door and window
        // Right edge segment (small pillar next to right wall)
        if (doorSegW > 0.3) {
          cityGroup.add(makeBox(doorSegW / 2, sH, 0.3, facadeMat, sx + shopBodyW / 2 - doorSegW / 4, sH / 2, sz));
        }
        // Left edge segment (left of window)
        cityGroup.add(makeBox(0.5, sH, 0.3, facadeMat, sx - shopBodyW / 2 + 0.25, sH / 2, sz));
        // Above door
        cityGroup.add(makeBox(doorW3 + 0.2, sH - 2.4, 0.3, facadeMat, sx + shopBodyW / 2 - doorW3 / 2 - (doorSegW > 0.3 ? doorSegW / 2 : 0) - 0.1, 2.4 + (sH - 2.4) / 2, sz));
        // Above schaufenster
        cityGroup.add(makeBox(winW, sH - 2.8, 0.3, facadeMat, sx - shopBodyW / 2 + 0.5 + winW / 2, 2.8 + (sH - 2.8) / 2, sz));

        // Dark sockel
        cityGroup.add(makeBox(shopW - 0.8, 0.8, 0.15, sockelMat, sx, 0.4, sz + 0.05));
        // Roof
        cityGroup.add(makeBox(shopW, 0.2, sD + 0.5, shopRoofMat, sx, sH + 0.1, shopCZ));
        // Schaufenster glass (left portion of front)
        cityGroup.add(makeBox(winW, 2.0, 0.08, glassMat3, sx - shopBodyW / 2 + 0.5 + winW / 2, 1.8, sz + 0.05));
        // Upper floor windows
        if (sH > 5) {
          for (const wx of [-shopW / 4, shopW / 4])
            cityGroup.add(makeBox(1.2, 1.0, 0.06, glassMat3, sx + wx, sH - 1.5, sz + 0.05));
        }

        // Glass door at FRONT of shop (right side of facade, slides left along X)
        const shopDoorX = sx + shopBodyW / 2 - (doorSegW > 0.3 ? doorSegW / 2 : 0) - doorW3 / 2 - 0.1;
        addAutoDoor(cityGroup, shopDoorX, 0, sz, doorW3, 2.2, 'x', -doorW3 - 0.2, 0, 0, {
          thinAxis: 'z', triggerDist: 3, closeDist: 5, speed: 8,
          material: glassMat3, // transparent glass door
        });

        // Awning
        const awningMat = getCachedMat('awning_' + (shopCount % 5), () => new THREE.MeshStandardMaterial({
          color: awningColors[shopCount % 5], roughness: 0.8, side: THREE.DoubleSide,
        }));
        cityGroup.add(makeBox(shopW - 0.5, 0.1, 1.8, awningMat, sx, 3.0, sz + 0.9));

        // Neon sign
        const neonColor = neonColors[shopCount % neonColors.length];
        const signMat3 = new THREE.MeshStandardMaterial({
          color: neonColor, emissive: neonColor, emissiveIntensity: 0.3, roughness: 0.2,
        });
        cityGroup.add(makeBox(shopW - 2, 0.6, 0.08, signMat3, sx, sH - 0.4, sz + 0.12));
        ledStrips.push({ meshes: [cityGroup.children[cityGroup.children.length - 1]],
          mat: signMat3, phase: shopCount * 0.3, style: 'neon' });

        // Flower box
        if (shopCount % 3 === 0) {
          const potMat2 = getCachedMat('pot', () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
          const plantMat2 = getCachedMat('plant', () => new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.8 }));
          cityGroup.add(makeBox(winW * 0.6, 0.2, 0.25, potMat2, sx, 0.85, sz + 0.15));
          cityGroup.add(makeBox(winW * 0.5, 0.3, 0.15, plantMat2, sx, 1.1, sz + 0.15));
        }

        // === SHOP INTERIOR ===
        // Floor (tile)
        const shopTileMat = getCachedMat('shop_tile', () => new THREE.MeshStandardMaterial({
          color: 0xd8d0c0, roughness: 0.4,
          polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
        }));
        cityGroup.add(makePlane(shopBodyW - 0.5, sD - 1, shopTileMat, sx, 0.32, shopCZ));
        // Ceiling light
        const shopLightMat = getCachedMat('shop_ceil_light', () => new THREE.MeshStandardMaterial({
          color: 0xfff8f0, emissive: 0xfff0dd, emissiveIntensity: 0.5, side: THREE.DoubleSide,
        }));
        cityGroup.add(makeBox(1.5, 0.04, 1.0, shopLightMat, sx, sH - 0.1, shopCZ));
        // Shelves (back wall, 2 units)
        const shelfMat = getCachedMat('shelf', () => new THREE.MeshStandardMaterial({
          map: textures.woodWalnut, roughness: 0.45,
        }));
        const shelfW = shopBodyW * 0.35;
        for (const ssx of [-1, 1]) {
          const shelfX = sx + ssx * (shopBodyW / 2 - shelfW / 2 - 0.5);
          cityGroup.add(makeBox(shelfW, 2.0, 0.4, shelfMat, shelfX, 1.3, sz - sD + 0.6));
          // Shop products on shelves (varied by shop type)
          const shopType = shopCount % 5; // 0=clothing, 1=souvenirs, 2=food, 3=jewelry, 4=toys
          const colors = [
            [0xcc3333, 0x3366cc, 0xf5f5f0, 0x2a2a2a, 0xcc9933], // clothing: red/blue/white/black/tan
            [0xffcc00, 0x44bbff, 0xff6699, 0x88dd44, 0xff8833], // souvenirs: bright
            [0xdd8833, 0xaacc44, 0xff4444, 0xffee88, 0x885522], // food: warm
            [0xdddddd, 0xffd700, 0xc0c0c0, 0x88ccff, 0xff88cc], // jewelry: metallic
            [0xff4488, 0x44ccff, 0xffdd22, 0x66dd66, 0xdd66ff], // toys: vibrant
          ][shopType];
          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              const ic = colors[(row * 3 + col + ssx) % 5];
              const ix = shelfX + (col - 1) * shelfW * 0.28;
              const iy = 0.45 + row * 0.55;
              const mat = getCachedMat('prod_' + ic, () => new THREE.MeshStandardMaterial({
                color: ic, roughness: 0.5, metalness: shopType === 3 ? 0.6 : 0,
              }));
              // Alternate shapes: boxes, cylinders, small spheres
              if ((row + col) % 3 === 0) {
                cityGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 6), mat));
                cityGroup.children[cityGroup.children.length - 1].position.set(ix, iy, sz - sD + 0.5);
              } else if ((row + col) % 3 === 1) {
                cityGroup.add(makeBox(0.12, 0.15, 0.08, mat, ix, iy, sz - sD + 0.5));
              } else {
                cityGroup.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 5), mat));
                cityGroup.children[cityGroup.children.length - 1].position.set(ix, iy, sz - sD + 0.5);
              }
            }
          }
        }
        // Counter (center)
        cityGroup.add(makeBox(shopBodyW * 0.4, 1.0, 0.6, shelfMat, sx, 0.5, shopCZ + 1));

        // Wall colliders (left, right, back full — front has door gap)
        addCollider(sx - shopBodyW / 2, shopCZ, 0.5, sD);           // left (full)
        addCollider(sx + shopBodyW / 2, shopCZ, 0.5, sD);           // right (full)
        addCollider(sx, sz - sD + 0.15, shopBodyW, 0.5);            // back (full)
        // Front: left of door
        const frontCollL = shopDoorX - doorW3 / 2 - (sx - shopBodyW / 2);
        if (frontCollL > 1) addCollider(sx - shopBodyW / 2 + frontCollL / 2, sz, frontCollL, 0.5);
        // Front: right of door
        const frontRightEdge = sx + shopBodyW / 2;
        const frontCollRStart = shopDoorX + doorW3 / 2;
        const frontCollR = frontRightEdge - frontCollRStart;
        if (frontCollR > 0.5) addCollider(frontCollRStart + frontCollR / 2, sz, frontCollR, 0.5);
        shopCount++;
      }

      // North side buildings (simpler, residential style)
      for (let si = 0; si < 2; si++) {
        const sx = bx + 5 + si * (blockSize / 2 - 3);
        const sz = bz - blockSize + 1;
        const sH = 5 + Math.random() * 4;
        const sD = 8;
        cityGroup.add(makeBox(blockSize / 2 - 4, sH, sD, facadeMats[(shopCount + 2) % 5], sx, sH / 2, sz + sD / 2));
        cityGroup.add(makeBox(blockSize / 2 - 3, 0.2, sD + 0.5, shopRoofMat, sx, sH + 0.1, sz + sD / 2));
        // Windows
        for (let wy = 2; wy < sH - 1; wy += 2.5) {
          for (let wx = -5; wx <= 5; wx += 3.5) {
            cityGroup.add(makeBox(1.0, 1.2, 0.06, glassMat3, sx + wx, wy, sz + 0.05));
          }
        }
        addCollider(sx, sz + sD / 2, blockSize / 2 - 4, sD);
        shopCount++;
      }
    }
  }

  // === STREET FURNITURE ===
  let furnitureCount = 0;
  for (let z = cityZStart - 15; z > cityZEnd; z -= 25) {
    for (let x = cityXMin + 20; x < cityXMax; x += 50) {
      // Street lamp
      const lampMat2 = getCachedMat('lamp', () => new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.4 }));
      const bulbMat2 = getCachedMat('bulb', () => new THREE.MeshStandardMaterial({ color: 0xffffcc, emissive: 0xffffaa, emissiveIntensity: 0.8 }));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 4), lampMat2);
      pole.position.set(x, 2.5, z); cityGroup.add(pole);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 4, 4), bulbMat2);
      bulb.position.set(x, 5.1, z); cityGroup.add(bulb);

      // Bench (every other lamp)
      if (furnitureCount % 2 === 0) {
        cityGroup.add(makeBox(1.8, 0.04, 0.5, benchMat, x + 2, 0.48, z));
        cityGroup.add(makeBox(1.8, 0.35, 0.06, benchMat, x + 2, 0.62, z - 0.22));
        cityGroup.add(makeBox(0.06, 0.45, 0.06, getCachedMat('bench_leg', () =>
          new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.3 })),
          x + 1.2, 0.23, z));
        cityGroup.add(makeBox(0.06, 0.45, 0.06, getCachedMat('bench_leg', () =>
          new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.3 })),
          x + 2.8, 0.23, z));
      }
      // Waste bin (every 3rd)
      if (furnitureCount % 3 === 0) {
        cityGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.7, 6), binMat));
        cityGroup.children[cityGroup.children.length - 1].position.set(x - 1.5, 0.35, z);
      }
      furnitureCount++;
    }
  }

  // === EAST + WEST WINGS (shops along hotel sides) ===
  for (const sideX of [-1, 1]) {
    const wingX = sideX * 180; // east or west wing
    // Road running north-south along hotel side
    cityGroup.add(makeBox(streetW, 0.12, 200, roadMat2, wingX, 0.06, -60));
    cityGroup.add(makeBox(2.5, 0.15, 200, sidewalkMat2, wingX - streetW / 2 - 1.5, 0.1, -60));
    cityGroup.add(makeBox(2.5, 0.15, 200, sidewalkMat2, wingX + streetW / 2 + 1.5, 0.1, -60));

    // 6 shops along each side
    for (let si = 0; si < 6; si++) {
      const sz = -160 + si * 28;
      const sH = 4 + Math.random() * 3;
      const sW = 12, sD = 8;
      const shopSide = sideX > 0 ? 1 : -1;
      const shopX = wingX + shopSide * (streetW / 2 + sD / 2 + 2);
      const facadeMat2 = facadeMats[si % 5];

      // Wing shop: walls (4 sides, door on street-facing side)
      const faceSide = -shopSide; // street-facing wall direction
      const faceX = shopX + faceSide * sD / 2; // street-facing wall X
      // Back wall
      cityGroup.add(makeBox(0.3, sH, sW, facadeMat2, shopX - faceSide * sD / 2, sH / 2, sz));
      // North + South walls
      cityGroup.add(makeBox(sD, sH, 0.3, facadeMat2, shopX, sH / 2, sz - sW / 2));
      cityGroup.add(makeBox(sD, sH, 0.3, facadeMat2, shopX, sH / 2, sz + sW / 2));
      // Front wall (with window gap)
      cityGroup.add(makeBox(0.3, sH - 2.8, sW, facadeMat2, faceX, 2.8 + (sH - 2.8) / 2, sz));
      // Roof
      cityGroup.add(makeBox(sD + 0.5, 0.2, sW + 1, shopRoofMat, shopX, sH + 0.1, sz));
      // Schaufenster glass
      cityGroup.add(makeBox(0.08, 2.0, sW - 3, glassMat3, faceX + faceSide * 0.05, 1.8, sz));
      // Door (auto-door, slides along Z)
      addAutoDoor(cityGroup, faceX, 0, sz + sW / 2 - 1.5, 1.0, 2.2, 'z', -1.3, 0, 0, {
        thinAxis: 'x', triggerDist: 3, closeDist: 5, speed: 8,
      });
      // Neon sign
      const nc = neonColors[(shopCount + si) % neonColors.length];
      const nsm = new THREE.MeshStandardMaterial({ color: nc, emissive: nc, emissiveIntensity: 0.3, roughness: 0.2 });
      cityGroup.add(makeBox(0.08, 0.6, sW - 2, nsm, faceX + faceSide * 0.1, sH - 0.4, sz));
      ledStrips.push({ meshes: [cityGroup.children[cityGroup.children.length - 1]], mat: nsm, phase: si * 0.5, style: 'neon' });
      // Interior: floor + shelves + counter
      const shopTileMat2 = getCachedMat('shop_tile', () => new THREE.MeshStandardMaterial({
        color: 0xd8d0c0, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
      }));
      cityGroup.add(makePlane(sD - 1, sW - 1, shopTileMat2, shopX, 0.32, sz));
      const shelfMat2 = getCachedMat('shelf', () => new THREE.MeshStandardMaterial({ map: textures.woodWalnut, roughness: 0.45 }));
      cityGroup.add(makeBox(0.4, 2.0, sW * 0.35, shelfMat2, shopX - faceSide * (sD / 2 - 0.6), 1.3, sz));
      cityGroup.add(makeBox(sD * 0.3, 1.0, 0.6, shelfMat2, shopX, 0.5, sz));
      const shopLightMat2 = getCachedMat('shop_ceil_light', () => new THREE.MeshStandardMaterial({
        color: 0xfff8f0, emissive: 0xfff0dd, emissiveIntensity: 0.5, side: THREE.DoubleSide,
      }));
      cityGroup.add(makeBox(1.0, 0.04, 1.5, shopLightMat2, shopX, sH - 0.1, sz));
      // Wall colliders (3 sides + door gap)
      addCollider(shopX - faceSide * sD / 2, sz, 0.5, sW);         // back
      addCollider(shopX, sz - sW / 2, sD, 0.5);                     // north
      addCollider(shopX, sz + sW / 2, sD, 0.5);                     // south (door gap handled by auto-door)
    }
  }

  // === PALM TREES along main streets ===
  for (let z = cityZStart - 20; z > cityZEnd + 20; z -= 30) {
    for (const x of [cityXMin + 10, cityXMax - 10]) {
      createPalmTree(scene, x, z, 7 + Math.random() * 4);
    }
  }

  scene.add(cityGroup);
  registerSpatial(cityGroup);
}

// === OLD createLobbyInterior (kept for reference, no longer called) ===
function registerStairFloors(x, z, width, depth, floorH) {
  // Must match createStaircase dimensions exactly
  const stairW = Math.min(5, width * 0.06);
  const stairX = x + width / 2 - stairW / 2 - 1;
  const stairD = Math.min(10, depth * 0.4);
  const stairStartZ = z - depth / 2 + 3;

  for (let flight = 0; flight < 2; flight++) {
    const baseY = flight * floorH;
    const stepsPerFlight = 20;
    const stepH = floorH / stepsPerFlight;
    const stepD = stairD / stepsPerFlight;

    for (let s = 0; s < stepsPerFlight; s += 2) {
      addFloor(stairX, stairStartZ + s * stepD, stairW + 1, stepD * 2 + 0.3, baseY + (s + 2) * stepH);
    }

    addFloor(stairX, stairStartZ + stairD + 0.5, stairW + 2, 3, (flight + 1) * floorH);
  }

  // Ground floor walkable surface (full interior minus 0.5m wall clearance)
  addFloor(x, z, width - 1, depth - 1, 0);
  // Floor slabs 1.OG + 2.OG (full interior so players reach rooms near outer walls)
  for (let fl = 1; fl <= 2; fl++) {
    addFloor(x, z, width - 1, depth - 1, fl * floorH);
  }

  // South stairwell wall collider only (west side open to lobby)
  addCollider(stairX, stairStartZ + stairD + 1, stairW + 1, 0.3);
}

// ---------------------------------------------------------------------------
// LED strips
// ---------------------------------------------------------------------------
function createLEDStrips(group, width, depth, totalH, floorH, floors, phase, name) {
  const stripH = 0.15;
  const isWater = name.includes('Water');

  if (isWater) {
    // === DREAM WATER WORLD: WAVE-SHAPED LED strips between every floor ===
    const meshesBlue = [];
    const meshesPink = [];
    const blueMat = new THREE.MeshStandardMaterial({
      color: 0x2266ff, emissive: 0x2266ff, emissiveIntensity: 1.2, roughness: 0.15,
    });
    const pinkMat = new THREE.MeshStandardMaterial({
      color: 0xff44aa, emissive: 0xff44aa, emissiveIntensity: 1.2, roughness: 0.15,
    });

    // Create a sine-wave tube along the building width
    function makeWaveTube(mat, baseY, faceZ, phaseOffset) {
      const points = [];
      const segments = 40;
      const amplitude = 0.4; // wave height
      const frequency = 4;   // number of waves across building width
      for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        const wx = -width / 2 + t * width;
        const wy = baseY + Math.sin(t * Math.PI * 2 * frequency + phaseOffset) * amplitude;
        points.push(new THREE.Vector3(wx, wy, faceZ));
      }
      const curve = new THREE.CatmullRomCurve3(points);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.1, 4, false), mat);
      return tube;
    }

    for (let f = 1; f < floors; f++) {
      const sy = f * floorH;
      const mat = (f % 2 === 0) ? blueMat : pinkMat;
      const meshArr = (f % 2 === 0) ? meshesBlue : meshesPink;
      const wavePhase = f * 1.2; // each floor has different wave phase

      // South front (pool-facing) – sine wave, in FRONT of balconies so visible
      const m1 = makeWaveTube(mat, sy, depth / 2 + 1.8, wavePhase);
      meshArr.push(m1);
      group.add(m1);
      // North front (street-facing) – mirrored sine wave, in front of balconies
      const m2 = makeWaveTube(mat, sy, -(depth / 2 + 1.8), wavePhase + Math.PI);
      meshArr.push(m2);
      group.add(m2);
    }

    // Roofline in blue (wave-shaped too), in front of balconies
    for (const fz of [depth / 2 + 1.8, -(depth / 2 + 1.8)]) {
      const m = makeWaveTube(blueMat, totalH + 0.05, fz, 0);
      meshesBlue.push(m);
      group.add(m);
    }

    ledStrips.push({ meshes: meshesBlue, mat: blueMat, phase, style: 'water_blue' });
    ledStrips.push({ meshes: meshesPink, mat: pinkMat, phase: phase + 0.5, style: 'water_pink' });

  } else {
    // === DREAM FUN WORLD + others: roofline + vertical corners ===
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0xff8800, emissive: 0xff8800, emissiveIntensity: 1.0, roughness: 0.2,
    });
    const meshes = [];
    const add = (w, h, d, x, y, z) => {
      const m = makeBox(w, h, d, ledMat, x, y, z);
      meshes.push(m);
      group.add(m);
    };

    // Roofline (offset outside the wall by 0.35)
    add(width + 0.5, stripH, stripH, 0, totalH + 0.05, depth / 2 + 0.35);
    add(width + 0.5, stripH, stripH, 0, totalH + 0.05, -(depth / 2 + 0.35));
    add(stripH, stripH, depth + 0.5, width / 2 + 0.35, totalH + 0.05, 0);
    add(stripH, stripH, depth + 0.5, -(width / 2 + 0.35), totalH + 0.05, 0);

    // Vertical corners (offset outside)
    for (const cx of [-(width / 2 + 0.35), width / 2 + 0.35]) {
      for (const cz of [-(depth / 2 + 0.35), depth / 2 + 0.35]) {
        add(stripH, totalH, stripH, cx, totalH / 2, cz);
      }
    }

    ledStrips.push({ meshes, mat: ledMat, phase, style: 'fun' });
  }
}

// ---------------------------------------------------------------------------
// Pool with Water addon
// ---------------------------------------------------------------------------
// ── Custom Pool Water Shader (Dual Normal Maps + Fresnel + Caustics) ────
// No planar reflection = no extra scene render = zero perf cost
let _poolNormTex1 = null, _poolNormTex2 = null;

function _genPoolNormal(seed) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  // Hash-based noise to break sine regularity
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 1013904223) | 0;
    h = ((h >> 13) ^ h) * 1274126177; h = ((h >> 16) ^ h);
    return (h & 0xffff) / 65536.0;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size, v = y / size;
      let nx = 0, ny = 0;
      // 5 octaves with hash perturbation
      const perturb = hash(x, y) * 0.3 - 0.15;
      nx += Math.sin((u + perturb) * 6.28 * 3 + v * 4.0 + seed) * 0.10;
      ny += Math.cos((v + perturb) * 6.28 * 3 + u * 3.5 + seed) * 0.10;
      nx += Math.sin(u * 6.28 * 7 + v * 6.28 * 5 + seed * 2) * 0.07;
      ny += Math.cos(v * 6.28 * 6 - u * 6.28 * 4 + seed * 2) * 0.07;
      nx += Math.sin(u * 6.28 * 13 + v * 6.28 * 9 + seed * 3) * 0.04;
      ny += Math.cos(v * 6.28 * 11 + u * 6.28 * 15 + seed * 3) * 0.04;
      nx += Math.sin(u * 6.28 * 23 - v * 6.28 * 19 + seed * 5) * 0.025;
      ny += Math.cos(v * 6.28 * 21 + u * 6.28 * 25 + seed * 5) * 0.025;
      nx += (hash(x * 3, y * 7) - 0.5) * 0.03; // micro noise
      ny += (hash(x * 7, y * 3) - 0.5) * 0.03;
      d[i]     = Math.min(255, Math.max(0, nx * 512 + 128)) | 0;
      d[i + 1] = Math.min(255, Math.max(0, ny * 512 + 128)) | 0;
      d[i + 2] = 215;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function getPoolNormals() { if (!_poolNormTex1) _poolNormTex1 = _genPoolNormal(0); return _poolNormTex1; }
function getPoolNormals2() { if (!_poolNormTex2) _poolNormTex2 = _genPoolNormal(7.3); return _poolNormTex2; }

// Loaded water normal map texture (much more organic than procedural sine waves)
let _waterNormalsTex = null;
function getWaterNormals() {
  if (!_waterNormalsTex) {
    _waterNormalsTex = new THREE.TextureLoader().load(
      'https://raw.githubusercontent.com/mrdoob/three.js/r164/examples/textures/waternormals.jpg',
      (tex) => { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; }
    );
    _waterNormalsTex.wrapS = _waterNormalsTex.wrapT = THREE.RepeatWrapping;
  }
  return _waterNormalsTex;
}

let _poolReflectCount = 0;
const MAX_REFLECT_POOLS = 2; // only 2 largest get expensive planar reflection

// Custom shader fallback for smaller pools (no planar reflection)
function createPoolWaterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uNormal1: { value: getPoolNormals() },
      uNormal2: { value: getPoolNormals2() },
      uEnvMap: { value: envMap },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.4).normalize() },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform sampler2D uNormal1, uNormal2;
      uniform samplerCube uEnvMap;
      uniform vec3 uSunDir;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vViewDir;

      void main() {
        // === DUAL NORMAL MAPS (different scales + scroll directions) ===
        vec2 uv1 = vWorldPos.xz * 0.08 + uTime * vec2(0.012, 0.009);
        vec2 uv2 = vWorldPos.xz * 0.18 + uTime * vec2(-0.008, 0.014);
        vec3 n1 = texture2D(uNormal1, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uNormal2, uv2).xyz * 2.0 - 1.0;
        // Combine normals: perturb the up-vector (0,1,0) by normal map XY
        vec3 N = normalize(vec3((n1.x + n2.x) * 0.25, 1.0, (n1.y + n2.y) * 0.25));

        // === FRESNEL (Schlick approximation) ===
        float cosTheta = max(dot(vViewDir, N), 0.0);
        float R0 = 0.02; // water IOR ~1.33
        float fresnel = R0 + (1.0 - R0) * pow(1.0 - cosTheta, 5.0);

        // === REFLECTION (env map) ===
        vec3 reflDir = reflect(-vViewDir, N);
        vec3 reflected = textureCube(uEnvMap, reflDir).rgb;

        // === BASE WATER COLOR (bright pool turquoise with depth tint) ===
        vec3 shallow = vec3(0.15, 0.75, 0.85); // bright turquoise
        vec3 deep = vec3(0.02, 0.30, 0.55);    // deeper blue
        float depthMix = smoothstep(0.3, 0.9, cosTheta); // steep = shallow, grazing = deep
        vec3 waterColor = mix(deep, shallow, depthMix);

        // === SPECULAR HIGHLIGHT (sun glint) ===
        vec3 halfVec = normalize(vViewDir + uSunDir);
        float spec = pow(max(dot(N, halfVec), 0.0), 256.0) * 1.5;

        // === CAUSTICS (subtle animated light patterns) ===
        vec2 cp = vWorldPos.xz * 0.5;
        float c1 = smoothstep(0.3, 0.0, abs(sin(cp.x * 14.0 + uTime * 1.8) * cos(cp.y * 13.0 - uTime * 1.2)) - 0.22);
        float c2 = smoothstep(0.3, 0.0, abs(sin(cp.x * 9.0 - uTime * 0.9) * cos(cp.y * 10.5 + uTime * 0.7)) - 0.22);
        float caustic = (c1 + c2) * 0.08;

        // === COMBINE ===
        vec3 color = mix(waterColor + caustic, reflected, fresnel * 0.7);
        color += vec3(1.0, 0.95, 0.85) * spec; // sun glint (warm white)

        gl_FragColor = vec4(color, 0.90);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

const poolWaterMeshes = []; // custom shader fallback pools
const waterMeshes2 = [];    // Water addon pools (planar reflection)

function createPool(scene, x, z, w, d) {
  // ALL pools use Water addon (identical look everywhere)
  const waterSurface = new Water(new THREE.PlaneGeometry(w, d), {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: getWaterNormals(),
    sunDirection: new THREE.Vector3(0.5, 0.7, 0.4).normalize(),
    sunColor: 0xffffff,
    waterColor: 0x0a5e6e,
    distortionScale: 2.5,
    fog: false,
    alpha: 0.9,
  });
  waterSurface.material.uniforms['size'].value = 1.0;
  waterSurface.rotation.x = -Math.PI / 2;
  waterSurface.position.set(x, 0.35, z);
  scene.add(waterSurface);
  waterMeshes2.push(waterSurface);
  registerSpatial(waterSurface);

  // Pool floor (visible through water – light blue tiles)
  const poolFloorMat = getCachedMat('poolfloor', () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x7ec8d8, roughness: 0.6 });
    return mat;
  });
  const poolFloor = makePlane(w - 0.2, d - 0.2, poolFloorMat, x, -0.3, z);
  scene.add(poolFloor);

  // Pool walls (inside basin – light blue)
  const poolWallMat = getCachedMat('poolwall', () => new THREE.MeshStandardMaterial({ color: 0x6ab8cc, roughness: 0.5 }));
  scene.add(makeBox(w, 0.7, 0.15, poolWallMat, x, 0.0, z - d / 2 + 0.07));
  scene.add(makeBox(w, 0.7, 0.15, poolWallMat, x, 0.0, z + d / 2 - 0.07));
  scene.add(makeBox(0.15, 0.7, d, poolWallMat, x - w / 2 + 0.07, 0.0, z));
  scene.add(makeBox(0.15, 0.7, d, poolWallMat, x + w / 2 - 0.07, 0.0, z));

  // Pool rim (single shared material)
  const rimMat = makePBR('rim', { color: 0xe8e0d0, roughness: 0.5 });
  const rimW = 0.4, rimH = 0.5;
  const rimGroup = new THREE.Group();
  rimGroup.add(makeBox(w + rimW * 2, rimH, rimW, rimMat, x, rimH / 2, z - d / 2 - rimW / 2));
  rimGroup.add(makeBox(w + rimW * 2, rimH, rimW, rimMat, x, rimH / 2, z + d / 2 + rimW / 2));
  rimGroup.add(makeBox(rimW, rimH, d, rimMat, x - w / 2 - rimW / 2, rimH / 2, z));
  rimGroup.add(makeBox(rimW, rimH, d, rimMat, x + w / 2 + rimW / 2, rimH / 2, z));
  scene.add(rimGroup);

  // Pool deck
  const deckMat = makePBR('concrete_po', {
    map: textures.concrete, roughness: 0.8,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  scene.add(makePlane(w + 10, d + 10, deckMat, x, 0.04, z));
}

// ---------------------------------------------------------------------------
// Waterslide – reduced geometry segments
// ---------------------------------------------------------------------------
function createWaterSlide(scene, x, z, height, colors) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const towerMat = makePBR('tower', { color: 0x888888, roughness: 0.6, metalness: 0.3 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, height, 6), towerMat);
    leg.position.set(Math.cos(a) * 3, height / 2, Math.sin(a) * 3);
    leg.castShadow = true;
    group.add(leg);
  }

  group.add(makeBox(8, 0.3, 8, makePBR('platform', { color: 0x666666, roughness: 0.7 }), 0, height, 0));

  // Reduced stair detail
  const stairMat = makePBR('stairs', { color: 0x999999 });
  for (let s = 0; s < Math.floor(height / 0.6); s++) {
    group.add(makeBox(1.2, 0.3, 0.8, stairMat, -4, s * 0.6 + 0.15, s * 0.4 - 3));
  }

  // Slide tubes – varied curve types per slide for visual diversity
  colors.forEach((color, idx) => {
    const tubeMat = makePBR('tube_' + color, { color, roughness: 0.3 });
    const points = [];
    const curveType = idx % 4; // 0=wide spiral, 1=tight spiral, 2=S-curve, 3=straight drop
    const startAngle = idx * Math.PI / 2;

    for (let s = 0; s <= 16; s++) {
      const t = s / 16;
      const y = height * (1 - t * t * 0.7 - t * 0.3); // parabolic descent
      let px, pz;

      if (curveType === 0) {
        // Wide lazy spiral
        const a = t * 1.2 * Math.PI * 2 + startAngle;
        const r = (5 + idx * 2) * t + 2;
        px = Math.cos(a) * r;
        pz = Math.sin(a) * r;
      } else if (curveType === 1) {
        // Tight corkscrew
        const a = t * 2.5 * Math.PI * 2 + startAngle;
        const r = 3.5 + idx;
        px = Math.cos(a) * r;
        pz = Math.sin(a) * r;
      } else if (curveType === 2) {
        // S-curve (swooping left then right)
        const dist = (6 + idx * 2) * t;
        px = Math.sin(t * Math.PI * 2) * (4 + idx) + Math.cos(startAngle) * dist * 0.3;
        pz = dist + Math.sin(startAngle) * 2;
      } else {
        // Steep straight drop with slight curve at end
        const dist = (5 + idx * 1.5) * t;
        px = Math.cos(startAngle) * dist + Math.sin(t * Math.PI) * 2;
        pz = Math.sin(startAngle) * dist;
      }

      points.push(new THREE.Vector3(px, y, pz));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 24, 0.6, 8, false), tubeMat);
    tube.castShadow = true;
    group.add(tube);
  });

  // Railing on platform edges (so you don't fall off)
  const railMat2 = makePBR('rail_slide', { color: 0xcccccc, metalness: 0.5, roughness: 0.2 });
  for (const [rx, rz] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
    const isX = Math.abs(rx) > 0;
    const rw = isX ? 0.08 : 8;
    const rd = isX ? 8 : 0.08;
    group.add(makeBox(rw, 1.2, rd, railMat2, rx, height + 0.6, rz));
  }

  scene.add(group);
  registerSpatial(group);

  // Platform railing colliders – only block at platform height, not at ground
  addCollider(x + 4, z, 0.3, 8, height + 1.2, height - 1);
  addCollider(x - 4, z, 0.3, 8, height + 1.2, height - 1);
  addCollider(x, z + 4, 8, 0.3, height + 1.2, height - 1);
  addCollider(x, z - 4, 8, 0.3, height + 1.2, height - 1);

  // Register stair steps as walkable floors (world coordinates)
  // Use fewer, larger step-zones (merge every 2 steps) to reduce floor count
  const stairSteps = Math.floor(height / 0.6);
  for (let s = 0; s < stairSteps; s += 2) {
    addFloor(
      x - 4,
      z + (-3 + s * 0.4),
      2.0,
      1.0,
      (s + 2) * 0.6
    );
  }
  // Platform on top
  addFloor(x, z, 8.5, 8.5, height);
}

// ---------------------------------------------------------------------------
// Palm tree (always full detail – cheap enough, LOD pop was ugly)
// ---------------------------------------------------------------------------
function createPalmTree(scene, x, z, height = 8) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const trunkMat = makePBR('bark', { map: textures.bark, roughness: 0.9 });
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector3(Math.sin(t * Math.PI * 0.3) * 1.5, t * height, 0));
  }
  const trunk = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.2, 5, false), trunkMat);
  trunk.castShadow = true;
  group.add(trunk);

  const leafMat = getCachedMat('leaf', () => new THREE.MeshStandardMaterial({ color: 0x2d6e1e, roughness: 0.8, side: THREE.DoubleSide }));
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const frondLen = 3 + Math.random() * 2;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(frondLen * 0.3, 0.8, frondLen, -0.5);
    shape.quadraticCurveTo(frondLen * 0.3, -0.3, 0, 0);
    const frond = new THREE.Mesh(new THREE.ShapeGeometry(shape, 2), leafMat);
    frond.position.set(pts[8].x, height, 0);
    frond.rotation.y = angle;
    frond.rotation.x = -0.3 - Math.random() * 0.4;
    group.add(frond);
  }

  scene.add(group);
  registerSpatial(group);
  addCollider(x, z, 0.8, 0.8, 1.0); // palm trunk, jumpable
}

// ---------------------------------------------------------------------------
// Lounger & parasol (simplified)
// ---------------------------------------------------------------------------
function createLounger(scene, x, z, rotation = 0) {
  const mat = makePBR('lounger', { color: 0xf5f0e0, roughness: 0.7 });
  const frameMat = makePBR('frame', { color: 0xaaaaaa, roughness: 0.3, metalness: 0.4 });
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotation;
  // Frame rails (2 long metal bars)
  group.add(makeBox(0.04, 0.06, 2.0, frameMat, -0.3, 0.35, 0));
  group.add(makeBox(0.04, 0.06, 2.0, frameMat, 0.3, 0.35, 0));
  // 4 legs
  group.add(makeBox(0.04, 0.35, 0.04, frameMat, -0.3, 0.175, -0.85));
  group.add(makeBox(0.04, 0.35, 0.04, frameMat, 0.3, 0.175, -0.85));
  group.add(makeBox(0.04, 0.35, 0.04, frameMat, -0.3, 0.175, 0.85));
  group.add(makeBox(0.04, 0.35, 0.04, frameMat, 0.3, 0.175, 0.85));
  // Seat surface (flat section)
  group.add(makeBox(0.65, 0.04, 1.3, mat, 0, 0.4, 0.3));
  // Backrest (angled via a pivot group)
  const backPivot = new THREE.Group();
  backPivot.position.set(0, 0.4, -0.35);
  backPivot.rotation.x = -0.45; // ~25° angle
  backPivot.add(makeBox(0.65, 0.04, 0.7, mat, 0, 0.17, -0.15));
  group.add(backPivot);
  scene.add(group);
  registerSpatial(group);
}

function createParasol(scene, x, z, color = 0xe8d8b8) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 4), makePBR('pole', { color: 0x888888, metalness: 0.3 }));
  pole.position.y = 1.25;
  group.add(pole);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.5, 6, 1, true),
    getCachedMat('parasol_' + color, () => new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 })));
  canopy.position.y = 2.3;
  canopy.castShadow = true;
  group.add(canopy);
  scene.add(group);
  registerSpatial(group);
}

// ---------------------------------------------------------------------------
// Amphitheater (simplified geometry)
// ---------------------------------------------------------------------------
function createAmphitheater(scene, x, z, rotation = 0, size = 'small') {
  const isLarge = size === 'large';
  const group = new THREE.Group();
  const groundY = getTerrainY(x, z);
  group.position.set(x, groundY, z);
  group.rotation.y = rotation;

  // === MEGA STAGE DIMENSIONS ===
  const stageW = isLarge ? 32 : 18;
  const stageD = isLarge ? 14 : 10;
  const stageH = isLarge ? 1.8 : 1.4;
  const canopyH = isLarge ? 10 : 7;
  const tiers = isLarge ? 9 : 5;

  // === STAGE PLATFORM (glossy black) ===
  const stageMat = getCachedMat('stage_black', () => new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.15, metalness: 0.2,
    envMap, envMapIntensity: 0.5,
  }));
  const stage = makeBox(stageW, stageH, stageD, stageMat, 0, stageH / 2, 0);
  stage.castShadow = true; stage.receiveShadow = true;
  group.add(stage);

  // Stage floor with LED strips
  const stageFloorMat = getCachedMat('stagefloor_led', () => new THREE.MeshStandardMaterial({
    color: 0x2a2a2a, roughness: 0.3, emissive: 0x111122, emissiveIntensity: 0.2,
  }));
  group.add(makeBox(stageW - 0.5, 0.05, stageD - 0.5, stageFloorMat, 0, stageH + 0.02, 0));

  // Stage edge LED strip (glowing rim around the stage)
  const edgeLedMat = new THREE.MeshStandardMaterial({
    color: 0x4488ff, emissive: 0x4488ff, emissiveIntensity: 1.5, roughness: 0.1,
  });
  group.add(makeBox(stageW + 0.2, 0.15, 0.15, edgeLedMat, 0, stageH, stageD / 2 + 0.1));
  group.add(makeBox(stageW + 0.2, 0.15, 0.15, edgeLedMat, 0, stageH, -(stageD / 2 + 0.1)));
  group.add(makeBox(0.15, 0.15, stageD + 0.2, edgeLedMat, stageW / 2 + 0.1, stageH, 0));
  group.add(makeBox(0.15, 0.15, stageD + 0.2, edgeLedMat, -(stageW / 2 + 0.1), stageH, 0));
  ledStrips.push({ meshes: [group.children[group.children.length - 4], group.children[group.children.length - 3],
    group.children[group.children.length - 2], group.children[group.children.length - 1]],
    mat: edgeLedMat, phase: isLarge ? 0 : 1.5, style: 'stage' });

  // === MASSIVE BACKDROP WALL (both sizes!) ===
  const backdropH = isLarge ? 8 : 5;
  const backdropMat = getCachedMat('backdrop', () => new THREE.MeshStandardMaterial({
    color: 0x1a1a2a, roughness: 0.85,
  }));
  group.add(makeBox(stageW, backdropH, 0.4, backdropMat, 0, stageH + backdropH / 2, -stageD / 2 + 0.2));

  // LED screen with animated Canvas texture (scrolling text + patterns)
  const screenW = stageW - 3;
  const screenH = backdropH - 1.5;
  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = 512; screenCanvas.height = 128;
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.wrapS = THREE.RepeatWrapping;
  const screenMat = new THREE.MeshStandardMaterial({
    map: screenTex, emissive: 0xffffff, emissiveIntensity: 2.0, emissiveMap: screenTex, roughness: 0.05,
  });
  const screenMesh = makeBox(screenW, screenH, 0.1, screenMat, 0, stageH + backdropH / 2 + 0.3, -stageD / 2 + 0.45);
  group.add(screenMesh);
  // Register for animation
  if (!window.__screenCanvases) window.__screenCanvases = [];
  window.__screenCanvases.push({ canvas: screenCanvas, tex: screenTex, isLarge });
  ledStrips.push({ meshes: [screenMesh], mat: screenMat,
    phase: isLarge ? 0.3 : 1.8, style: 'screen' });

  // Backdrop LED frame around screen
  const frameLedMat = new THREE.MeshStandardMaterial({
    color: 0xff44aa, emissive: 0xff44aa, emissiveIntensity: 1.5, roughness: 0.1,
  });
  const fl = 0.12;
  group.add(makeBox(screenW + 0.5, fl, fl, frameLedMat, 0, stageH + backdropH - 0.3, -stageD / 2 + 0.5));
  group.add(makeBox(screenW + 0.5, fl, fl, frameLedMat, 0, stageH + 1.1, -stageD / 2 + 0.5));
  group.add(makeBox(fl, screenH + 0.5, fl, frameLedMat, -screenW / 2 - 0.2, stageH + backdropH / 2 + 0.3, -stageD / 2 + 0.5));
  group.add(makeBox(fl, screenH + 0.5, fl, frameLedMat, screenW / 2 + 0.2, stageH + backdropH / 2 + 0.3, -stageD / 2 + 0.5));
  ledStrips.push({ meshes: [group.children[group.children.length - 4], group.children[group.children.length - 3],
    group.children[group.children.length - 2], group.children[group.children.length - 1]],
    mat: frameLedMat, phase: isLarge ? 0.7 : 2.2, style: 'frame' });

  // === SPEAKER TOWERS (simplified – 1 box per side) ===
  const speakerMat = getCachedMat('speaker', () => new THREE.MeshStandardMaterial({
    color: 0x222222, roughness: 0.7, metalness: 0.2,
  }));
  const speakerH = isLarge ? 5 : 3;
  for (const sx of [-stageW / 2 - 1.5, stageW / 2 + 1.5]) {
    group.add(makeBox(1.5, speakerH, 1.2, speakerMat, sx, speakerH / 2 + stageH, 0));
  }

  // === TRUSS STRUCTURE (overhead lighting rig) ===
  const trussMat = getCachedMat('truss', () => new THREE.MeshStandardMaterial({
    color: 0x888888, metalness: 0.6, roughness: 0.2,
  }));
  const trussH = canopyH;
  // Canopy/Roof (DoubleSide so visible from below)
  const canopyMat2 = getCachedMat('stage_canopy', () => new THREE.MeshStandardMaterial({
    color: 0x333333, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide,
  }));
  group.add(makeBox(stageW + 6, 0.25, stageD + 4, canopyMat2, 0, trussH + 0.1, 0));

  // Truss: 2 horizontal bars + 4 legs (simplified, no cross bars)
  for (const tz of [-stageD / 2 - 1, stageD / 2 + 1]) {
    group.add(makeBox(stageW + 4, 0.2, 0.2, trussMat, 0, trussH, tz));
  }
  for (const [tx, tz] of [[-stageW / 2 - 1, -stageD / 2 - 1], [stageW / 2 + 1, -stageD / 2 - 1],
                           [-stageW / 2 - 1, stageD / 2 + 1], [stageW / 2 + 1, stageD / 2 + 1]]) {
    group.add(makeBox(0.25, trussH, 0.25, trussMat, tx, trussH / 2, tz));
  }

  // === DISCO / MOVING HEAD LIGHTS on truss ===
  const discoColors = [0xff0044, 0x44ff00, 0x0088ff, 0xff8800, 0xff00ff, 0x00ffff];
  // Disco lights (simplified – fewer, shared housing material)
  const discoCount = isLarge ? 36 : 6;
  const housingMat = getCachedMat('disco_housing', () => new THREE.MeshStandardMaterial({
    color: 0x333333, metalness: 0.5, roughness: 0.3,
  }));
  for (let i = 0; i < discoCount; i++) {
    const dx = -stageW / 2 + (i + 0.5) * stageW / discoCount;
    group.add(makeBox(0.4, 0.5, 0.4, housingMat, dx, trussH - 0.3, 0));
    const beamColor = discoColors[i % discoColors.length];
    const beamMat = new THREE.MeshStandardMaterial({
      color: beamColor, emissive: beamColor, emissiveIntensity: 2.0, roughness: 0.1,
    });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 3), beamMat); // 3 sides instead of 4
    beam.position.set(dx, trussH - 0.6, 0);
    beam.rotation.x = Math.PI;
    group.add(beam);
    ledStrips.push({ meshes: [beam], mat: beamMat, phase: i * 1.5, style: 'disco' });
  }

  // SpotLights (real lights for stage illumination)
  const spotColors = isLarge ? [0xff4444, 0x4444ff] : [0xff4444];
  spotColors.forEach((color, i) => {
    const spot = new THREE.SpotLight(color, isLarge ? 5 : 3, isLarge ? 40 : 25, Math.PI / 5, 0.6, 1);
    const spacing = stageW / (spotColors.length + 1);
    spot.position.set(-stageW / 2 + spacing * (i + 1), trussH - 0.5, -2);
    spot.target.position.set(-stageW / 4 + i * stageW / spotColors.length, 0, 2);
    spot.castShadow = false;
    group.add(spot);
    group.add(spot.target);
    stageLights.push({ light: spot, phase: i * 1.5 });
  });

  // === SEATING ROWS (flat on ground, semicircular) ===
  const chairInstMat = getCachedMat('stage_chair', () => new THREE.MeshStandardMaterial({
    color: 0x4a3a2a, roughness: 0.7,
  }));
  const tierSpacing = isLarge ? 2.2 : 2.5;
  const firstR = isLarge ? 16 : 11;
  for (let tier = 0; tier < tiers; tier++) {
    const innerR = firstR + tier * tierSpacing;
    const outerR = innerR + (isLarge ? 1.8 : 2.0);
    const rowZ = stageD / 2 + 2 + tier * tierSpacing;

    // Chairs on this row (InstancedMesh) — all sitting on ground (y=0)
    const chairsPerTier = Math.max(4, Math.floor((innerR * Math.PI) / 1.2));
    // Chair = seat (0.45×0.03×0.45) on 4 legs (0.03×0.45×0.03) + backrest (0.45×0.4×0.03)
    // Using a simple box for the seat + thin box for backrest (2 meshes per instanced set)
    const seatGeo = new THREE.BoxGeometry(0.45, 0.45, 0.45);
    const chairs = new THREE.InstancedMesh(seatGeo, chairInstMat, chairsPerTier);
    const dummy = new THREE.Object3D();
    for (let ci = 0; ci < chairsPerTier; ci++) {
      const angle = (ci / chairsPerTier) * Math.PI;
      const r = (innerR + outerR) / 2;
      dummy.position.set(
        Math.cos(angle) * r,
        0.225,  // chair center at 0.225m (bottom at 0, top at 0.45m) — ON THE GROUND
        rowZ + Math.sin(angle) * r * 0.05
      );
      dummy.rotation.y = angle + Math.PI / 2;
      dummy.updateMatrix();
      chairs.setMatrixAt(ci, dummy.matrix);
    }
    chairs.instanceMatrix.needsUpdate = true;
    group.add(chairs);
  }

  // Stage access steps (front, 3 steps leading up)
  const stepCount = 3;
  const stepH2 = stageH / stepCount;
  const stepD2 = 0.8;
  const stepMat = getCachedMat('stage_step', () => new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.3 }));
  for (let s = 0; s < stepCount; s++) {
    const sy = (s + 0.5) * stepH2;
    const stepZ = stageD / 2 + (stepCount - s) * stepD2;
    group.add(makeBox(stageW * 0.4, stepH2, stepD2, stepMat, 0, sy, stepZ));
  }

  scene.add(group);
  registerSpatial(group);

  // Stage floor: walkable surface on top
  addFloor(x, z, stageW + 2, stageD + 4, groundY + stageH);
  // Stage steps: intermediate floors so player can walk up (each step < 1.5m tolerance)
  for (let s = 0; s < stepCount; s++) {
    addFloor(x, z + stageD / 2 + (stepCount - s) * stepD2, stageW * 0.4 + 1, stepD2 + 0.5, groundY + (s + 1) * stepH2);
  }
  // Stage sides: collider blocks walking through stage base (only below stage top)
  addCollider(x, z, stageW, stageD, groundY + stageH, -1);
  // Backdrop wall collider (prevents walking through the screen)
  addCollider(x, z - stageD / 2, stageW, 0.5);
  // No seat collider – player can walk freely between seats and jump on stage
  // (seat collider removed – was blocking access to stage area)
}

// ---------------------------------------------------------------------------
// Procedural terrain with gentle Mediterranean hills + height-blended textures
// (Inspired by VogelSimulator's parabolic arc terrain + splatmap shader)
// ---------------------------------------------------------------------------

// FBM noise for terrain (same approach as VogelSimulator/utils/noise.js)
function _hash(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
function _valueNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = _hash(ix, iy), b = _hash(ix + 1, iy);
  const c = _hash(ix, iy + 1), d = _hash(ix + 1, iy + 1);
  return a + sx * (b - a) + sy * (c - a) + sx * sy * (a - b - c + d);
}
function terrainFbm(x, y, octaves = 4) {
  let v = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * _valueNoise(x * freq, y * freq);
    max += amp; amp *= 0.5; freq *= 2;
  }
  return v / max;
}

// Flat zones: rectangles where terrain must be y=0
// Covers both hotels, pools, slides, amphitheaters, road, beach
const FLAT_ZONES = [
  // Road corridor (flat transition zone between hills and hotels)
  { xMin: -1000, xMax: 1000, zMin: -110, zMax: -85 },
];

// Height function for the terrain
function getTerrainY(x, z) {
  // Check if inside any flat zone (with smooth falloff at edges)
  let flatness = 0;
  for (const fz of FLAT_ZONES) {
    // Distance inside the zone (negative = inside, positive = outside)
    const dx = Math.max(fz.xMin - x, 0, x - fz.xMax);
    const dz = Math.max(fz.zMin - z, 0, z - fz.zMax);
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Smooth transition over 25m from flat zone edge
    const f = 1 - smoothClamp(dist / 25);
    flatness = Math.max(flatness, f);
  }

  if (flatness >= 0.999) return 0;

  // City area (z > -250) is completely flat for streets + buildings
  // Hills only at world edges (z < -250)
  if (z > -250) return 0;

  // Smooth transition from flat city to hills
  const hillFade = smoothClamp((-250 - z) / 50);

  // Rolling hills at the far edges
  const hillHeight = terrainFbm(x * 0.003, z * 0.003, 4) * 45
                   + terrainFbm(x * 0.01, z * 0.01, 3) * 15
                   + terrainFbm(x * 0.025, z * 0.025, 2) * 5;

  // Mountains at the very edge
  const northBoost = z < -300 ? smoothClamp((-300 - z) / 100) * 50 : 0;

  const raw = (hillHeight + northBoost) * hillFade;
  const y = Math.max(0, raw) * (1 - flatness);
  return y;
}

function createTerrain(scene) {
  const size = GROUND_SIZE;
  const segments = 120; // more segments for larger world
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  // Displace vertices by terrain height
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainY(x, z);
    pos.setY(i, y);

    // Vertex colors: height-based splatmap with slope detection
    // (VogelSimulator approach: sand → grass → earth/terracotta → rock)
    const h = y;
    const noise = terrainFbm(x * 0.025, z * 0.025, 2);

    // Compute slope from neighbors
    const dx = getTerrainY(x + 1, z) - getTerrainY(x - 1, z);
    const dz2 = getTerrainY(x, z + 1) - getTerrainY(x, z - 1);
    const slope = Math.sqrt(dx * dx + dz2 * dz2) / 2; // 0=flat, higher=steep

    const hn = h + noise * 4; // noisy height for blending

    // Layer factors (like VogelSimulator TerrainShader.js)
    let sandF = 1 - smoothClamp((hn - 0.5) / 2);
    let grassF = smoothClamp((hn - 0.3) / 2) * (1 - smoothClamp((hn - 8) / 6));
    let earthF = smoothClamp((hn - 5) / 5) * (1 - smoothClamp((hn - 18) / 8));
    let rockF = smoothClamp((hn - 14) / 8);

    // Steep slopes become rock (VogelSimulator: slopeRock)
    const slopeRock = smoothClamp((slope - 0.3) / 0.4);
    rockF = Math.max(rockF, slopeRock * 0.8);
    grassF *= (1 - slopeRock * 0.6);
    earthF *= (1 - slopeRock * 0.3);

    const total = sandF + grassF + earthF + rockF + 0.001;
    sandF /= total; grassF /= total; earthF /= total; rockF /= total;

    // Colors: Sand=warm tan, Grass=Mediterranean green, Earth=terracotta, Rock=limestone
    const r = sandF * 0.88 + grassF * 0.30 + earthF * 0.62 + rockF * 0.72;
    const g = sandF * 0.80 + grassF * 0.52 + earthF * 0.40 + rockF * 0.68;
    const b = sandF * 0.60 + grassF * 0.18 + earthF * 0.25 + rockF * 0.60;

    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    map: textures.grass,  // grass texture modulated by vertex color
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });

  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);
}

function smoothClamp(t) { return Math.max(0, Math.min(1, t)); }

// --- HEIGHTMAP CACHE: O(1) bilinear lookup instead of live FBM ---
let _heightCache = null;
const _HC_RES = 256; // 256x256 grid
const _HC_HALF = GROUND_SIZE / 2;
const _HC_CELL = GROUND_SIZE / _HC_RES;

function buildHeightmapCache() {
  _heightCache = new Float32Array(_HC_RES * _HC_RES);
  for (let iz = 0; iz < _HC_RES; iz++) {
    const wz = -_HC_HALF + (iz + 0.5) * _HC_CELL;
    for (let ix = 0; ix < _HC_RES; ix++) {
      const wx = -_HC_HALF + (ix + 0.5) * _HC_CELL;
      _heightCache[iz * _HC_RES + ix] = getTerrainY(wx, wz);
    }
  }
}

function getTerrainYCached(x, z) {
  if (!_heightCache) return getTerrainY(x, z);
  // Bilinear interpolation from cached grid
  const fx = (x + _HC_HALF) / _HC_CELL - 0.5;
  const fz = (z + _HC_HALF) / _HC_CELL - 0.5;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const ix0 = Math.max(0, Math.min(_HC_RES - 1, ix));
  const ix1 = Math.max(0, Math.min(_HC_RES - 1, ix + 1));
  const iz0 = Math.max(0, Math.min(_HC_RES - 1, iz));
  const iz1 = Math.max(0, Math.min(_HC_RES - 1, iz + 1));
  const h00 = _heightCache[iz0 * _HC_RES + ix0];
  const h10 = _heightCache[iz0 * _HC_RES + ix1];
  const h01 = _heightCache[iz1 * _HC_RES + ix0];
  const h11 = _heightCache[iz1 * _HC_RES + ix1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// ---------------------------------------------------------------------------
// Cloud sprites (inspired by VogelSimulator's CloudPlane.js)
// ---------------------------------------------------------------------------
const cloudSprites = [];

function generateCloudCanvas() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  const blobs = 6 + Math.floor(Math.random() * 6);
  for (let i = 0; i < blobs; i++) {
    const bx = size / 2 + (Math.random() - 0.5) * size * 0.5;
    const by = size / 2 + (Math.random() - 0.5) * size * 0.3;
    const r = 25 + Math.random() * 55;
    const grad = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.7)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.3)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function createCloudLayer(scene) {
  // Generate 4 unique cloud textures
  const cloudTextures = [];
  for (let i = 0; i < 4; i++) {
    const tex = new THREE.CanvasTexture(generateCloudCanvas());
    tex.premultiplyAlpha = true;
    cloudTextures.push(tex);
  }

  const cloudY = 150;
  const spread = 400;
  const count = 30;

  for (let i = 0; i < count; i++) {
    const tex = cloudTextures[i % 4];
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.5 + Math.random() * 0.3,
      depthWrite: false, fog: true,
    });
    const sprite = new THREE.Sprite(mat);
    const scale = 40 + Math.random() * 80;
    sprite.scale.set(scale, scale * 0.4, 1);
    sprite.position.set(
      (Math.random() - 0.5) * spread * 2,
      cloudY + Math.random() * 30,
      (Math.random() - 0.5) * spread * 2
    );
    scene.add(sprite);
    cloudSprites.push({
      sprite,
      vx: (Math.random() - 0.5) * 2,
      vz: (Math.random() - 0.5) * 1,
    });
  }
}

// ---------------------------------------------------------------------------
// Build full scene
// ---------------------------------------------------------------------------
function buildScene(scene) {
  textures = generateAllTextures();

  // Sky
  const skyResult = applySkyGradient(scene);
  skyUniforms = skyResult.uniforms;
  skyMesh = skyResult.mesh;

  // 3D Moon object (visible at night, follows camera like sky)
  const moonGeo = new THREE.SphereGeometry(8, 16, 16);
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xffffee, emissive: 0xffffdd, emissiveIntensity: 3.0, roughness: 0.8,
  });
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.position.set(-200, 300, -150); // high in the sky
  moonMesh.visible = false; // only at night
  scene.add(moonMesh);
  window.__moonMesh = moonMesh;

  // === TERRAIN with gentle hills (inspired by VogelSimulator) ===
  createTerrain(scene);

  // === CLOUD SPRITES (inspired by VogelSimulator) ===
  createCloudLayer(scene);

  // Road
  scene.add(makePlane(GROUND_SIZE, 12, makePBR('road', {
    color: 0x444444, roughness: 0.9,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }), 0, 0.06, -95));

  // Road markings (fewer)
  const markMat = makePBR('marks', { color: 0xcccccc, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 });
  for (let mx = -280; mx < 280; mx += 20) scene.add(makePlane(8, 0.2, markMat, mx, 0.14, -95)); // wider spacing

  // Sidewalk
  scene.add(makePlane(GROUND_SIZE, 4, makePBR('sidewalk', {
    map: textures.concrete, roughness: 0.85,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }), 0, 0.08, -88));

  // ===== DREAM WATER WORLD =====
  const dwwX = 70, dwwZ = -30;  // Water World = RIGHT side
  createHotelBuilding(scene, dwwX, dwwZ - 30, 115, 35, 6, 'DWW Main Water', '#f0ead8', 0);
  registerStairFloors(dwwX, dwwZ - 30, 115, 35, 6.0);
  createHotelBuilding(scene, dwwX + 45, dwwZ - 30, 50, 22, 4, 'DWW Annex Water', '#ede6d4', 0.5);
  registerStairFloors(dwwX + 45, dwwZ - 30, 50, 22, 6.0);
  // DWW small boutique wing (2 floors, cozy premium rooms)
  // Position: inside DWW perimeter (x=35..175), clear of west hedge at x=35
  // DWW Boutique: clearly separated to the right of DWW Main
  createHotelBuilding(scene, dwwX + 65, dwwZ - 20, 25, 16, 2, 'DWW Boutique Water', '#f5ede0', 0.8);
  registerStairFloors(dwwX + 65, dwwZ - 20, 25, 16, 6.0);

  const signMat = getCachedMat('sign', () => new THREE.MeshStandardMaterial({
    color: 0x1155aa, emissive: 0x1155aa, emissiveIntensity: 0.5, roughness: 0.3 }));
  scene.add(makeBox(30, 3, 0.3, signMat, dwwX, 22, dwwZ - 12));

  createPool(scene, dwwX - 15, dwwZ + 20, 50, 25);
  createPool(scene, dwwX + 35, dwwZ + 25, 15, 10);
  createPool(scene, dwwX - 50, dwwZ + 15, 20, 12);
  // DWW: 6 waterslides across 3 towers (different heights/styles)
  // Tower 1: Tall "Aqua Tower" – 3 big slides (blue/yellow/red)
  // DWW slides: positioned near pools, AWAY from stage (stage is at dwwX+10, dwwZ+55)
  createWaterSlide(scene, dwwX + 40, dwwZ + 30, 14, [0x2288ff, 0xffcc00, 0xff4444]);
  createWaterSlide(scene, dwwX - 15, dwwZ + 32, 10, [0x44dd88, 0xff8800]);
  createWaterSlide(scene, dwwX - 35, dwwZ + 25, 5, [0x66ccff]);

  // Fewer loungers (every other)
  for (let i = 0; i < 20; i += 2) {
    const lx = dwwX - 38 + i * 4;
    createLounger(scene, lx, dwwZ + 35, 0);
    if (i % 6 === 0) createParasol(scene, lx, dwwZ + 36, 0xe0d0b0);
  }

  // DWW stage: smaller, fully inside DWW perimeter (x=35..175)
  createAmphitheater(scene, dwwX + 10, dwwZ + 55, 0, 'small');

  // ===== DREAM FUN WORLD =====
  const dfwX = -70, dfwZ = -30; // Fun World = LEFT side
  createHotelBuilding(scene, dfwX, dfwZ - 30, 115, 35, 6, 'DFW Main Fun', '#eee8d6', 1.0);
  registerStairFloors(dfwX, dfwZ - 30, 115, 35, 6.0);
  scene.add(makeBox(28, 3, 0.3, signMat, dfwX, 22, dfwZ - 12));
  createHotelBuilding(scene, dfwX + 45, dfwZ - 25, 35, 15, 3, 'Qum Village', '#f2ebe0', 1.5);
  registerStairFloors(dfwX + 45, dfwZ - 25, 35, 15, 6.0);
  // DFW small boutique wing (2 floors, premium rooms)
  // DFW Boutique: clearly separated to the left of DFW Main
  createHotelBuilding(scene, dfwX - 65, dfwZ - 20, 25, 16, 2, 'DFW Boutique Fun', '#f0e8d8', 2.0);
  registerStairFloors(dfwX - 65, dfwZ - 20, 25, 16, 6.0);

  createPool(scene, dfwX + 10, dfwZ + 20, 55, 28);
  createPool(scene, dfwX - 30, dfwZ + 25, 12, 8);
  createPool(scene, dfwX + 50, dfwZ + 15, 18, 12); // moved left to stay inside DFW perimeter
  // DFW: 5 waterslides across 3 towers
  // Tower 1: Tall main tower – 2 big slides (pink/cyan)
  // DFW slides: positioned near pools, AWAY from stage (stage is at dfwX-10, dfwZ+55)
  // DFW slides: all clearly on DFW side (x < -10)
  createWaterSlide(scene, dfwX + 15, dfwZ + 35, 15, [0xff3366, 0x33ccff]);
  createWaterSlide(scene, dfwX + 35, dfwZ + 32, 11, [0xffdd00, 0x44ff44]);
  createWaterSlide(scene, dfwX + 50, dfwZ + 25, 5, [0xff9900]);

  for (let i = 0; i < 22; i += 2) {
    const lx = dfwX - 30 + i * 4;
    createLounger(scene, lx, dfwZ + 36, 0);
    if (i % 6 === 0) createParasol(scene, lx, dfwZ + 37);
  }

  // DFW stage: BIGGER, fully inside DFW perimeter (x=-140..30)
  createAmphitheater(scene, dfwX - 10, dfwZ + 55, 0, 'large');

  // ===== SHARED =====
  const pathMat = makePBR('path', {
    map: textures.concrete, roughness: 0.75,
    polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
  });
  scene.add(makePlane(4, 80, pathMat, 0, 0.10, dfwZ));
  scene.add(makePlane(140, 3, pathMat, 0, 0.10, dfwZ + 10));

  // Palm trees (with LOD)
  const palmPositions = [
    [-120, -10], [-110, 5], [-100, 15], [-85, -15], [-75, 10],
    [-60, 30], [-50, -5], [-40, 20], [-35, 45], [-25, 5],
    [-115, 35], [-95, 40], [-80, 50], [-55, 55],
    [30, -10], [40, 5], [55, 15], [65, -15], [80, 10],
    [95, 30], [110, -5], [120, 20], [50, 45], [75, 50],
    [100, 40], [130, 35], [140, 15], [45, -20],
    [-5, -15], [5, 20], [-10, 35], [10, 45], [0, -5],
    [-60, -82], [-30, -82], [0, -82], [30, -82], [60, -82],
    [90, -82], [-90, -82], [120, -82], [-120, -82],
    [-50, 60], [-20, 65], [20, 70], [50, 65], [80, 60],
  ];
  palmPositions.forEach(([px, pz]) => createPalmTree(scene, px, pz, 6 + Math.random() * 5));

  // NO grass blades! Grass texture on ground is enough.

  // Lawns (textured planes – no geometry blades)
  const lawnMat = makePBR('lawn', {
    map: textures.grass, roughness: 0.95, color: 0x44aa33,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  for (const [lx, lz, lw, ld] of [[dwwX, dwwZ + 55, 60, 30], [dfwX, dfwZ + 55, 70, 30], [0, -70, 30, 20], [dfwX + 80, dfwZ + 5, 30, 20]]) {
    scene.add(makePlane(lw, ld, lawnMat, lx, 0.12, lz));
  }

  // Beach
  scene.add(makePlane(GROUND_SIZE, 200, makePBR('sand', {
    map: textures.sand, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }), 0, 0.02, 200));

  // Sea
  // Sea: simple env-mapped material (no planar reflection – saves 50% draw calls)
  const seaMat = getCachedMat('sea_mat', () => new THREE.MeshStandardMaterial({
    color: 0x0a4a6a, roughness: 0.1, metalness: 0.15,
    envMap, envMapIntensity: 0.9,
    transparent: true, opacity: 0.9,
  }));
  const sea = makePlane(GROUND_SIZE, 600, seaMat, 0, -0.1, 400);
  scene.add(sea);

  // Beach furniture (fewer)
  for (let bx = -100; bx < 100; bx += 16) {
    createParasol(scene, bx, 115, 0xcc8844);
    createLounger(scene, bx - 1, 117, Math.PI / 2);
    createLounger(scene, bx + 1, 113, Math.PI / 2);
  }

  // === HOTEL PERIMETER FENCES (jumpable, textured) ===
  // Textured hedge: grass texture tinted dark green + slight roughness variation
  const hedgeMat = getCachedMat('hedge_tex', () => new THREE.MeshStandardMaterial({
    map: textures.grass,
    color: 0x1a4a12,
    roughness: 0.95,
  }));
  // Decorative stone base strip under hedge
  const hedgeBaseMat = getCachedMat('hedge_base', () => new THREE.MeshStandardMaterial({
    color: 0x8a8070, roughness: 0.7,
  }));
  const fenceH = 1.8;
  const fenceT = 0.6;
  const baseH = 0.3;
  const gateMat = makePBR('gate', { color: 0xdddddd, roughness: 0.3, metalness: 0.3 });
  const gateW = 8; // wide entrance gates (as wide as the hotel entrance)

  // Helper: add a fence segment with proper texture repeat
  function addFenceSegment(w, d, x, y, z) {
    // Split long fences into segments that follow terrain height
    const maxDim = Math.max(w, d);
    const segLen = 15; // 15m per segment
    const segCount = Math.max(1, Math.ceil(maxDim / segLen));
    const isHorizontal = w > d; // runs along X or Z?

    for (let s = 0; s < segCount; s++) {
      let sx, sz, sw, sd;
      if (isHorizontal) {
        sw = w / segCount; sd = d;
        sx = x - w / 2 + (s + 0.5) * sw;
        sz = z;
      } else {
        sw = w; sd = d / segCount;
        sx = x;
        sz = z - d / 2 + (s + 0.5) * sd;
      }

      const tY = getTerrainY(sx, sz);
      const hedgeGeo = new THREE.BoxGeometry(sw, fenceH - baseH + tY * 0.5, sd); // taller on hills
      const hMesh = new THREE.Mesh(hedgeGeo, hedgeMat.clone());
      hMesh.material.map = textures.grass.clone();
      hMesh.material.map.wrapS = THREE.RepeatWrapping;
      hMesh.material.map.wrapT = THREE.RepeatWrapping;
      hMesh.material.map.repeat.set(Math.max(1, Math.round(Math.max(sw, sd) / 2)), 1);
      hMesh.position.set(sx, tY + baseH + (fenceH - baseH) / 2, sz);
      hMesh.castShadow = true; hMesh.receiveShadow = true;
      scene.add(hMesh);

      const base = makeBox(sw, baseH, sd, hedgeBaseMat, sx, tY + baseH / 2, sz);
      base.receiveShadow = true;
      scene.add(base);
    }
    // Single collider for the whole segment (at max terrain height for safety)
    addCollider(x, z, w, d);
  }

  // Simple perimeter: 4 continuous walls with gate on north
  function createPerimeter(xMin, xMax, zMin, zMax, gateX) {
    const w = xMax - xMin;
    const d = zMax - zMin;
    const cx = (xMin + xMax) / 2;
    const cz = (zMin + zMax) / 2;

    // South wall (full)
    addFenceSegment(w, fenceT, cx, 0, zMax);
    // East wall (full length)
    addFenceSegment(fenceT, d, xMax, 0, cz);
    // West wall (full length)
    addFenceSegment(fenceT, d, xMin, 0, cz);

    // North wall (with gate opening)
    const gateLeft = gateX - gateW / 2 - xMin;
    const gateRight = xMax - (gateX + gateW / 2);
    if (gateLeft > 1)
      addFenceSegment(gateLeft, fenceT, xMin + gateLeft / 2, 0, zMin);
    if (gateRight > 1)
      addFenceSegment(gateRight, fenceT, xMax - gateRight / 2, 0, zMin);

    // Gate pillars + arch
    for (const offset of [-gateW / 2, gateW / 2]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3, 6), gateMat);
      p.position.set(gateX + offset, 1.5, zMin);
      scene.add(p);
    }
    scene.add(makeBox(gateW + 1, 0.4, 0.8, gateMat, gateX, 3.2, zMin));
    scene.add(makeBox(gateW - 1, 0.3, 0.1, new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 }),
      gateX, 3.0, zMin - 0.45));
  }

  // TWO EQUAL-SIZE perimeters (each 150m wide, symmetric)
  const outerZMin = -82, outerZMax = 155;
  // DFW: x = -153 to -3 (150m)
  createPerimeter(-153, -3, outerZMin, outerZMax, dfwX);
  // DWW: x = 3 to 153 (150m)
  createPerimeter(3, 153, outerZMin, outerZMax, dwwX);

  // Flowers (fewer, bigger)
  const flowerColors = [0xff6699, 0xff3366, 0xffaa00, 0xff66cc, 0xcc44ff];
  for (let i = 0; i < 20; i++) {
    const fx = -100 + Math.random() * 200, fz = -75 + Math.random() * 140;
    scene.add(makeBox(0.5 + Math.random() * 0.5, 0.4, 0.5 + Math.random() * 0.5,
      getCachedMat('flower_' + (i % 5), () => new THREE.MeshStandardMaterial({
        color: flowerColors[i % 5], roughness: 0.8 })),
      fx, 0.2, fz));
  }

  // Lamps (wider spacing)
  const lampMat = makePBR('lamp', { color: 0x555555, metalness: 0.4 });
  const bulbMat = getCachedMat('bulb', () => new THREE.MeshStandardMaterial({
    color: 0xffffcc, emissive: 0xffffaa, emissiveIntensity: 0.8 }));
  for (let lx = -150; lx <= 150; lx += 50) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 4), lampMat);
    pole.position.set(lx, 2.5, -88);
    scene.add(pole);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), bulbMat);
    bulb.position.set(lx, 5.1, -88);
    scene.add(bulb);
  }

  // ===== KUMKÖY CITY (north of road) =====
  createCity(scene);

  // ===== LIGHTING =====
  sunLight = new THREE.DirectionalLight(0xfff5e0, 2.0);
  sunLight.position.set(100, 120, 80);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 300;
  sunLight.shadow.camera.left = -150;
  sunLight.shadow.camera.right = 150;
  sunLight.shadow.camera.top = 150;
  sunLight.shadow.camera.bottom = -150;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);

  ambientLight = new THREE.AmbientLight(0x88aacc, 0.5);
  scene.add(ambientLight);
  hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x555533, 0.4);
  scene.add(hemiLight);
}

// ---------------------------------------------------------------------------
// FPS Controller
// ---------------------------------------------------------------------------
// Mobile detection
const _isMobile = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth <= 1280;

class FPSController {
  constructor(cam, domElement) {
    this.camera = cam;
    this.domElement = domElement;
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.isLocked = false;
    this.verticalVelocity = 0;
    this.canJump = true;
    this.keys = { forward: false, backward: false, left: false, right: false, rotateLeft: false, rotateRight: false, run: false };
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();

    // Mobile tilt controls
    this.tiltForward = 0;
    this.tiltStrafe = 0;
    this.tiltRotate = 0;
    this.isMobile = _isMobile;

    if (this.isMobile) {
      this._setupMobile();
    } else {
      this._setupDesktop();
    }
  }

  _setupDesktop() {
    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.keys.forward = true; break;
        case 'KeyS': case 'ArrowDown': this.keys.backward = true; break;
        case 'KeyA': this.keys.left = true; break;
        case 'KeyD': this.keys.right = true; break;
        case 'ArrowLeft': this.keys.rotateLeft = true; break;
        case 'ArrowRight': this.keys.rotateRight = true; break;
        case 'ShiftLeft': case 'ShiftRight': this.keys.run = true; break;
        case 'Space': if (this.canJump) { this.verticalVelocity = JUMP_FORCE; this.canJump = false; } break;
      }
    });
    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.keys.forward = false; break;
        case 'KeyS': case 'ArrowDown': this.keys.backward = false; break;
        case 'KeyA': this.keys.left = false; break;
        case 'KeyD': this.keys.right = false; break;
        case 'ArrowLeft': this.keys.rotateLeft = false; break;
        case 'ArrowRight': this.keys.rotateRight = false; break;
        case 'ShiftLeft': case 'ShiftRight': this.keys.run = false; break;
      }
    });
    document.addEventListener('pointerlockchange', () => { this.isLocked = document.pointerLockElement === this.domElement; });
    this.domElement.addEventListener('click', () => this.domElement.requestPointerLock());
  }

  _setupMobile() {
    this.isLocked = true; // always active on mobile

    // Device orientation for tilt-based movement + rotation
    const startOrientation = () => {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(r => {
          if (r === 'granted') window.addEventListener('deviceorientation', (e) => this._handleTilt(e));
        });
      } else {
        window.addEventListener('deviceorientation', (e) => this._handleTilt(e));
      }
    };

    // Show mobile play button
    const playUI = document.getElementById('mobilePlay');
    if (playUI) {
      playUI.style.display = 'flex';
      document.getElementById('mobilePlayBtn').addEventListener('click', () => {
        playUI.style.display = 'none';
        startOrientation();

        // === FULLSCREEN: try every method ===
        const el = document.documentElement;
        let wentFullscreen = false;

        // 1. Standard Fullscreen API (Chrome, Firefox, Edge)
        if (el.requestFullscreen) {
          el.requestFullscreen().then(() => { wentFullscreen = true; }).catch(() => {});
        }
        // 2. WebKit prefixed (older Chrome, some Android)
        else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen();
          wentFullscreen = true;
        }
        // 3. MS prefixed (old Edge)
        else if (el.msRequestFullscreen) {
          el.msRequestFullscreen();
          wentFullscreen = true;
        }

        // 4. Safari iOS workaround: minimize toolbar via scroll
        if (!wentFullscreen) {
          document.body.style.overflow = 'auto';
          document.body.style.height = '110vh';
          window.scrollTo(0, 1);
          setTimeout(() => {
            document.body.style.overflow = 'hidden';
            document.body.style.height = '100%';
            _resizeRenderer();
          }, 600);
        }

        // Landscape lock (Android only, iOS ignores)
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }

        // Resize after fullscreen settles
        setTimeout(_resizeRenderer, 300);
        setTimeout(_resizeRenderer, 1000);
      });
    }

    // Fullscreen guide buttons
    const guideEl = document.getElementById('fullscreenGuide');
    const guideBtn = document.getElementById('fullscreenHelpBtn');
    const guideClose = document.getElementById('fullscreenGuideClose');
    if (guideBtn && guideEl) {
      guideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        guideEl.style.display = 'flex';
      });
    }
    if (guideClose && guideEl) {
      guideClose.addEventListener('click', () => { guideEl.style.display = 'none'; });
    }

    // Resize helper
    function _resizeRenderer() {
      const w = window.innerWidth, h = window.innerHeight;
      if (window.__renderer) window.__renderer.setSize(w, h);
      if (window.__camera) { window.__camera.aspect = w / h; window.__camera.updateProjectionMatrix(); }
      if (window.composer) window.composer.setSize(w, h);
    }
    window.addEventListener('resize', _resizeRenderer);
    window.addEventListener('orientationchange', () => setTimeout(_resizeRenderer, 300));

    // Tap on canvas = jump (not on buttons)
    this.domElement.addEventListener('touchstart', (e) => {
      if (e.target.closest('#daynight') || e.target.closest('#hud')) return;
      e.preventDefault();
      if (this.canJump) { this.verticalVelocity = JUMP_FORCE; this.canJump = false; }
    }, { passive: false });
  }

  _handleTilt(event) {
    if (event.beta === null || event.gamma === null) return;
    const beta = event.beta;
    const gamma = event.gamma;

    // Deadzone = sweetspot where you stand still
    const moveDeadzone = 12;  // degrees – generous sweetspot
    const rotDeadzone = 8;    // degrees for rotation
    const maxMoveTilt = 30;
    const maxRotTilt = 40;

    // Landscape: phone held sideways
    // beta = rotation around the phone's short axis (tilting the top edge toward/away from you)
    // gamma = rotation around the phone's long axis (rolling left/right)
    // In landscape-left: beta controls forward/back, gamma controls left/right turn

    // Forward/back: beta. Neutral ~0 in landscape when held ~flat-ish
    // Tilt phone top towards you (beta increases) = walk back
    // Tilt phone top away from you (beta decreases) = walk forward
    let fwdTilt = -beta; // negative beta = tilted forward = walk forward

    // Left/right ROTATION: gamma. Tilt phone left (gamma negative) = turn left
    let rotTilt = -gamma;

    // Apply deadzone (sweetspot in the middle where nothing happens)
    if (Math.abs(fwdTilt) < moveDeadzone) fwdTilt = 0;
    else fwdTilt = (fwdTilt - Math.sign(fwdTilt) * moveDeadzone); // subtract deadzone

    if (Math.abs(rotTilt) < rotDeadzone) rotTilt = 0;
    else rotTilt = (rotTilt - Math.sign(rotTilt) * rotDeadzone);

    this.tiltForward = Math.max(-1, Math.min(1, fwdTilt / maxMoveTilt));
    this.tiltStrafe = 0; // strafe not used on mobile, rotation instead
    this.tiltRotate = Math.max(-1, Math.min(1, rotTilt / maxRotTilt));
  }

  update(dt) {
    if (!this.isLocked) return;
    this.euler.setFromQuaternion(this.camera.quaternion);
    if (this.keys.rotateLeft) this.euler.y += ROTATE_SPEED * dt;
    if (this.keys.rotateRight) this.euler.y -= ROTATE_SPEED * dt;
    // Mobile tilt rotation
    if (this.isMobile && this.tiltRotate !== 0) {
      this.euler.y += this.tiltRotate * ROTATE_SPEED * 1.5 * dt;
    }
    this.camera.quaternion.setFromEuler(this.euler);

    // Indoor speed: halved when player is inside a hotel building
    // (detected via same bounds as floor culling: dx<60, dz<20 from building center)
    let indoorFactor = 1;
    const px = this.camera.position.x, pz = this.camera.position.z;
    for (const fg of floorGroups) {
      if (Math.abs(px - fg.buildingX) < 60 && Math.abs(pz - fg.buildingZ) < 20) {
        indoorFactor = 0.5;
        break;
      }
    }
    const speed = MOVE_SPEED * (this.keys.run ? RUN_MULTIPLIER : 1) * indoorFactor * dt;
    const fwd = this._fwd;
    this.camera.getWorldDirection(fwd);
    fwd.y = 0; fwd.normalize();
    const right = this._right;
    right.set(0, 1, 0);
    right.crossVectors(fwd, right).normalize();
    const move = this._move;
    move.set(0, 0, 0);

    // Keyboard input
    if (this.keys.forward) move.add(fwd);
    if (this.keys.backward) move.sub(fwd);
    if (this.keys.left) move.sub(right);
    if (this.keys.right) move.add(right);

    // Mobile tilt input (additive)
    if (this.isMobile) {
      move.addScaledVector(fwd, this.tiltForward);
      move.addScaledVector(right, this.tiltStrafe);
    }

    if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed);

    // Substep collision to prevent tunneling through thin walls
    const py = this.camera.position.y;
    const stepSize = 0.3; // max 0.3m per substep
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(move.x), Math.abs(move.z)) / stepSize));
    const sx = move.x / steps, sz = move.z / steps;
    for (let s = 0; s < steps; s++) {
      const nx = this.camera.position.x + sx;
      if (!checkCollision(nx, this.camera.position.z, py)) this.camera.position.x = nx;
      else break;
    }
    for (let s = 0; s < steps; s++) {
      const nz = this.camera.position.z + sz;
      if (!checkCollision(this.camera.position.x, nz, py)) this.camera.position.z = nz;
      else break;
    }

    // Floor height detection (terrain + stairs + upper floors)
    const terrainY = getTerrainYCached(this.camera.position.x, this.camera.position.z);
    const floorY = Math.max(terrainY, getFloorHeight(this.camera.position.x, this.camera.position.z, this.camera.position.y));
    const targetY = floorY + PLAYER_HEIGHT;

    this.verticalVelocity += GRAVITY * dt;
    this.camera.position.y += this.verticalVelocity * dt;
    if (this.camera.position.y <= targetY) {
      this.camera.position.y = targetY;
      this.verticalVelocity = 0;
      this.canJump = true;
    }
    const half = GROUND_SIZE / 2 - 2;
    this.camera.position.x = Math.max(-half, Math.min(half, this.camera.position.x));
    this.camera.position.z = Math.max(-half, Math.min(half, this.camera.position.z));
  }
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
class Minimap {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.visible = true;
    this.scale = 0.28;
  }
  toggle() { this.visible = !this.visible; this.canvas.style.display = this.visible ? 'block' : 'none'; }
  draw(cam) {
    if (!this.visible) return;
    const w = this.canvas.width = 180, h = this.canvas.height = 180;
    const ctx = this.ctx, s = this.scale, cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,30,20,0.8)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(200,180,150,0.7)';
    for (const c of colliders) ctx.fillRect(cx + c.min.x * s, cy + c.min.z * s, (c.max.x - c.min.x) * s, (c.max.z - c.min.z) * s);
    ctx.fillStyle = 'rgba(100,100,100,0.6)';
    ctx.fillRect(0, cy + (-95 - 6) * s, w, 12 * s);
    const px = cx + cam.position.x * s, py = cy + cam.position.z * s;
    ctx.fillStyle = '#0f0';
    ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    cam.getWorldDirection(_tmpMinimapDir);
    ctx.strokeStyle = '#0f0'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + _tmpMinimapDir.x * 15, py + _tmpMinimapDir.z * 15); ctx.stroke();
    ctx.fillStyle = '#aaf'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Fun World', cx - 70 * s, cy - 55 * s);
    ctx.fillText('Water World', cx + 70 * s, cy - 55 * s);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let renderer, scene, controller, quadtree, minimap, composer;
let debugEl, loadBar;
let showDebug = false;
const clock = new THREE.Clock();
const _tmpColor = new THREE.Color(); // pre-allocated for LED animation
const _tmpMinimapDir = new THREE.Vector3(); // pre-allocated for minimap
const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
let elapsedTime = 0;

function init() {
  loadBar = document.getElementById('loadBar');
  debugEl = document.getElementById('debug');

  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, _isMobile ? 1.0 : 1.5));
  renderer.shadowMap.enabled = !_isMobile; // disable shadows on mobile for performance
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.body.appendChild(renderer.domElement);

  loadBar.style.width = '20%';

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xc8dce8, 0.002);

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, FAR_PLANE);
  camera.position.set(0, PLAYER_HEIGHT, -85); // spawn on the road, between both hotels

  loadBar.style.width = '30%';
  buildScene(scene);
  loadBar.style.width = '60%';

  // Async: upgrade interior textures to high-res Poly Haven CC0 versions
  // (procedural fallback already in place — this just swaps to better maps)
  upgradeLuxuryTextures(textures, (key, newTex) => {
    // Map texture keys → cached material names
    const matKey = {
      marbleFloor: 'marble',
      marbleWall: 'lift_wall',
      parquet: 'laminate',
      herringbone: 'stair_marble',
      // City shop facades (5 cached materials, indexed by key order)
      facadeBrickRed: 'facade_0',
      facadeBrickTan: 'facade_1',
      facadePlasterStone: 'facade_2',
      facadeStone: 'facade_3',
      facadePlaster: 'facade_4',
    }[key];
    if (matKey && matCache[matKey]) {
      matCache[matKey].map = newTex;
      matCache[matKey].needsUpdate = true;
    }
  });

  generateEnvMap(renderer, scene);
  buildHeightmapCache(); // O(1) terrain lookups from now on
  _rebuildColGrid();     // spatial collision grid
  loadBar.style.width = '70%';

  quadtree = new QuadTreeNode({ x: 0, z: 0, w: GROUND_SIZE, h: GROUND_SIZE }, 0, 5, 10);
  for (const obj of spatialObjects) quadtree.insert(obj);
  loadBar.style.width = '80%';

  // Post-processing: Bloom + Output (lightweight pipeline)
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.3, 0.4, 0.88));
  composer.addPass(new OutputPass());

  loadBar.style.width = '90%';

  controller = new FPSController(camera, renderer.domElement);
  window.__controller = controller;
  window.__renderer = renderer;
  window.__camera = camera;
  // Toggle HUD for mobile
  if (_isMobile) {
    const cd = document.getElementById('controlsDesktop');
    const cm = document.getElementById('controlsMobile');
    if (cd) cd.style.display = 'none';
    if (cm) cm.style.display = 'inline';
  }
  window.__checkCollision = checkCollision;
  window.__colliders = colliders;
  window.__dynamicColliders = dynamicColliders;
  window.__colGrid = _colGrid;
  window.__scene = scene;
  window.__floors = floors;
  window.composer = composer;
  window.THREE = THREE;
  minimap = new Minimap('minimap');

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') minimap.toggle();
    if (e.code === 'KeyF') { showDebug = !showDebug; debugEl.style.display = showDebug ? 'block' : 'none'; }
  });

  // Day/Night toggle buttons
  function setDayMode() {
    isNightMode = false;
    sunLight.intensity = 2.0;
    ambientLight.intensity = 0.5;
    ambientLight.color.set(0x88aacc);
    hemiLight.intensity = 0.4;
    scene.fog.color.set(0xc8dce8);
    scene.fog.density = 0.002;
    if (skyUniforms) {
      skyUniforms.nightMix.value = 0.0;
      skyUniforms.sunIntensity.value = 1.8;
    }
    renderer.toneMappingExposure = 1.2;
    // Show cloud sprites during day
    for (const c of cloudSprites) c.sprite.visible = true;
    if (window.__moonMesh) window.__moonMesh.visible = false;
    // Interior lights: always same brightness (day level)
    for (const ll of lobbyLights) ll.intensity = ll._dayIntensity * 6;
    document.getElementById('btnDay').classList.add('active');
    document.getElementById('btnNight').classList.remove('active');
    // Regenerate envmap with day sky (delayed so shader updates first)
    setTimeout(refreshEnvMap, 100);
  }
  function setNightMode() {
    isNightMode = true;
    // Rotate screen pattern each time night is activated
    window.__screenPattern = (window.__screenPattern || 0) + 1;
    sunLight.intensity = 2.0;           // SAME as day (keeps interiors identical)
    ambientLight.intensity = 0.5;       // SAME as day
    ambientLight.color.set(0x88aacc);  // SAME as day
    hemiLight.intensity = 0.4;  // SAME as day
    scene.fog.color.set(0x010103);
    scene.fog.density = 0.006; // thicker fog so outside stays dark despite higher ambient
    if (skyUniforms) {
      skyUniforms.nightMix.value = 1.0;
      skyUniforms.sunIntensity.value = 0.0;
    }
    renderer.toneMappingExposure = 1.2; // SAME as day so interiors look identical
    // Hide cloud sprites
    for (const c of cloudSprites) c.sprite.visible = false;
    if (window.__moonMesh) window.__moonMesh.visible = true;
    // Interior lights: MUCH brighter to compensate for no ambient/sun
    for (const ll of lobbyLights) ll.intensity = ll._dayIntensity * 6;
    document.getElementById('btnNight').classList.add('active');
    document.getElementById('btnDay').classList.remove('active');
    // Regenerate envmap with night sky
    setTimeout(refreshEnvMap, 100);
  }
  document.getElementById('btnDay').addEventListener('click', setDayMode);
  document.getElementById('btnNight').addEventListener('click', setNightMode);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  loadBar.style.width = '100%';
  setTimeout(() => { document.getElementById('loading').style.display = 'none'; }, 400);

  animate();
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
let visibleCount = 0;
let frameCount = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsedTime += dt;
  frameCount++;

  // Update auto-doors BEFORE player movement so colliders are current.
  // If the doors are updated AFTER movement, the player collides with
  // the previous frame's door position — causing visible opening but
  // invisible closed-door colliders blocking passage.
  updateAutoDoors(camera.position.x, camera.position.z, dt);

  controller.update(dt);

  // Update LODs via cached array (no scene.traverse!)
  for (let i = 0; i < lodObjects.length; i++) lodObjects[i].update(camera);

  // Frustum culling
  camera.updateMatrixWorld();
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);
  for (let i = 0; i < spatialObjects.length; i++) {
    spatialObjects[i].visible = false;
    spatialObjects[i]._qtChecked = false;
  }
  const visible = [];
  quadtree.query(frustum, visible);
  visibleCount = visible.length;
  for (let i = 0; i < visible.length; i++) visible[i].visible = true;

  // Sky + clouds
  if (skyUniforms) skyUniforms.time.value = elapsedTime;
  // Drift clouds slowly (every 2nd frame)
  if (frameCount % 2 === 0) {
    for (const c of cloudSprites) {
      c.sprite.position.x += c.vx * dt;
      c.sprite.position.z += c.vz * dt;
      // Wrap around
      if (c.sprite.position.x > 500) c.sprite.position.x -= 1000;
      if (c.sprite.position.x < -500) c.sprite.position.x += 1000;
      if (c.sprite.position.z > 500) c.sprite.position.z -= 1000;
      if (c.sprite.position.z < -500) c.sprite.position.z += 1000;
    }
  }

  // Water addon pools (planar reflection): update time
  for (const w of waterMeshes2) {
    w.material.uniforms['time'].value += 0.4 / 60.0; // pool-calm, not ocean-choppy
  }
  // Custom shader pools (no reflection): update time
  for (const pm of poolWaterMeshes) {
    pm.material.uniforms.uTime.value = elapsedTime;
  }

  // Lift physics (every frame for smooth movement)
  updateLifts(camera, dt);

  // LED screens: animate at night, dark at day
  if (frameCount % 4 === 0 && window.__screenCanvases) {
    if (!isNightMode) {
      // Day: screens off (dark grey)
      for (const sc of window.__screenCanvases) {
        const ctx = sc.canvas.getContext('2d');
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, sc.canvas.width, sc.canvas.height);
        sc.tex.needsUpdate = true;
      }
    } else {
    // Night: rotating patterns (changes each time night mode is activated)
    if (!window.__screenPattern) window.__screenPattern = 0;
    for (const sc of window.__screenCanvases) {
      const ctx = sc.canvas.getContext('2d');
      const w = sc.canvas.width, h = sc.canvas.height;
      const t = elapsedTime;
      const pattern = window.__screenPattern % 8;

      // Dark background (near black)
      ctx.fillStyle = '#060612';
      ctx.fillRect(0, 0, w, h);

      // DFW (large) = warm colors (orange/pink/gold), DWW (small) = cool colors (blue/cyan/teal)
      const warm = sc.isLarge;
      const cx = w / 2, cy = h / 2;

      switch (pattern) {
        case 0: { // Centered pulsing rings
          for (let i = 5; i >= 0; i--) {
            const r = 15 + i * 12 + Math.sin(t * 2 + i * 0.7) * 6;
            const alpha = 0.4 + Math.sin(t * 3 + i) * 0.2;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = warm
              ? `rgba(255,${120 + i * 20},${50 + i * 10},${alpha})`
              : `rgba(${50 + i * 10},${150 + i * 15},255,${alpha})`;
            ctx.lineWidth = 2; ctx.stroke();
          }
          break;
        }
        case 1: { // Floating stars (small, centered cluster)
          for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2 + t * 0.5;
            const r = 20 + Math.sin(t + i * 1.3) * 18;
            const sx = cx + Math.cos(a) * r;
            const sy = cy + Math.sin(a) * r * 0.5;
            const size = 1.5 + Math.sin(t * 3 + i) * 1;
            ctx.fillStyle = warm
              ? `hsl(${30 + i * 5}, 100%, ${60 + Math.sin(t * 2 + i) * 15}%)`
              : `hsl(${190 + i * 5}, 90%, ${55 + Math.sin(t * 2 + i) * 15}%)`;
            ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 2: { // Geometric diamond rotation
          ctx.save(); ctx.translate(cx, cy);
          for (let i = 0; i < 6; i++) {
            ctx.rotate(t * 0.3 + i * Math.PI / 3);
            const s = 10 + i * 8 + Math.sin(t * 2) * 3;
            ctx.strokeStyle = warm
              ? `rgba(255,${100 + i * 25},${30 + i * 10},0.6)`
              : `rgba(${30 + i * 10},${160 + i * 15},255,0.6)`;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(-s / 2, -s / 2, s, s);
          }
          ctx.restore();
          break;
        }
        case 3: { // Sine wave pattern (centered, not full-screen)
          ctx.strokeStyle = warm ? '#ff6633' : '#3388ff';
          ctx.lineWidth = 2;
          for (let line = -2; line <= 2; line++) {
            ctx.beginPath();
            for (let x = cx - 180; x < cx + 180; x += 3) {
              const dx = (x - cx) / 180;
              const env = 1 - dx * dx; // fade at edges
              ctx.lineTo(x, cy + line * 12 + Math.sin(dx * 8 + t * 3 + line) * 15 * env);
            }
            ctx.globalAlpha = 0.4 + line * 0.1;
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 4: { // Pulsing hotel name (centered, subtle glow)
          const name = sc.isLarge ? 'DREAM FUN WORLD' : 'DREAM WATER WORLD';
          ctx.font = 'bold 36px sans-serif';
          ctx.textAlign = 'center';
          const glow = 0.5 + Math.sin(t * 2) * 0.3;
          ctx.fillStyle = warm
            ? `rgba(255,140,50,${glow})`
            : `rgba(80,180,255,${glow})`;
          ctx.fillText(name, cx, cy + 12);
          ctx.textAlign = 'left';
          break;
        }
        case 5: { // Rotating dot circle
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2 + t * 1.5;
            const r = 30 + Math.sin(t * 2 + i * 0.5) * 8;
            const dotR = 3 + Math.sin(t * 4 + i) * 1.5;
            ctx.fillStyle = warm
              ? `hsl(${(i * 22 + 10) % 60}, 100%, ${50 + Math.sin(t + i) * 15}%)`
              : `hsl(${(i * 22 + 180) % 240 + 160}, 80%, ${45 + Math.sin(t + i) * 15}%)`;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.6, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 6: { // Particle fountain (centered, upward motion)
          for (let i = 0; i < 25; i++) {
            const age = (t * 0.8 + i * 0.2) % 2;
            const px = cx + Math.sin(i * 2.7 + t * 0.3) * age * 40;
            const py = cy + 30 - age * 50;
            const alpha = Math.max(0, 1 - age * 0.6);
            ctx.fillStyle = warm
              ? `rgba(255,${160 - age * 60},${60 - age * 30},${alpha})`
              : `rgba(${80 - age * 30},${200 - age * 40},255,${alpha})`;
            ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
          }
          break;
        }
        case 7: { // "WELCOME" with subtle star accent
          ctx.font = 'bold 42px sans-serif';
          ctx.textAlign = 'center';
          const pulse = 0.6 + Math.sin(t * 1.5) * 0.2;
          ctx.fillStyle = warm ? `rgba(255,200,100,${pulse})` : `rgba(100,200,255,${pulse})`;
          ctx.fillText('WELCOME', cx, cy + 14);
          // Small star accents
          for (let i = 0; i < 6; i++) {
            const sx = cx - 120 + i * 48;
            const sy = cy - 25 + Math.sin(t * 2 + i) * 5;
            ctx.fillStyle = warm ? `rgba(255,180,80,0.5)` : `rgba(100,180,255,0.5)`;
            ctx.beginPath(); ctx.arc(sx, sy, 1.5, 0, Math.PI * 2); ctx.fill();
          }
          ctx.textAlign = 'left';
          break;
        }
      }
      sc.tex.needsUpdate = true;
    }
    } // end night block
  }

  // Visible-driven floor culling: render interiors when they COULD be seen
  // Run every 2 frames for responsiveness when crossing building/floor boundaries
  if (frameCount % 2 === 0) {
    const py = camera.position.y;
    const px = camera.position.x;
    const pz = camera.position.z;
    const playerFloor = Math.max(0, Math.round((py - PLAYER_HEIGHT) / 6));

    for (const fg of floorGroups) {
      const dx = Math.abs(px - fg.buildingX);
      const dz = Math.abs(pz - fg.buildingZ);
      // Aggressive thresholds: only render interiors of buildings the player is actually in/near
      const inBuilding = dx < 60 && dz < 20;
      const nearBuilding = dx < 70 && dz < 30;

      if (!nearBuilding) {
        fg.group.visible = false;
        continue;
      }

      if (inBuilding) {
        // Inside: ONLY current floor
        fg.group.visible = fg.floorNum === playerFloor;
      } else {
        // Outside but near (e.g. on balcony): show current floor + EG
        // This ensures rooms are visible from balconies and vice versa
        fg.group.visible = fg.floorNum === 0 || fg.floorNum === playerFloor;
      }
    }
  }

  // LED strips: animated at night – BRIGHT!
  if (frameCount % 2 === 0 && isNightMode) {
    for (const strip of ledStrips) {
      if (strip.style === 'screen') {
        // Stage LED screens: cycle through pattern colors (not just hue)
        // Alternates between warm/cool palettes every ~3 seconds
        const pattern = Math.floor(elapsedTime * 0.35 + strip.phase) % 5;
        const t = (elapsedTime * 0.5 + strip.phase) % 1.0;
        switch (pattern) {
          case 0: _tmpColor.setRGB(0.1 + t * 0.3, 0.1, 0.8 - t * 0.4); break; // deep blue→purple
          case 1: _tmpColor.setRGB(0.9, 0.3 + t * 0.5, 0.1); break;           // fire orange→yellow
          case 2: _tmpColor.setRGB(0.1, 0.6 + t * 0.3, 0.4 + t * 0.3); break; // teal→aqua
          case 3: _tmpColor.setRGB(0.7 + t * 0.3, 0.1, 0.5 + t * 0.3); break; // magenta→pink
          case 4: _tmpColor.setRGB(t * 0.3, 0.8 - t * 0.3, 0.1 + t * 0.5); break; // green→cyan
        }
        const pulse = 1.0 + Math.sin(elapsedTime * 4 + strip.phase * 5) * 0.4;
        strip.mat.emissive.copy(_tmpColor);
        strip.mat.emissiveIntensity = pulse * 52.5;
        strip.mat.color.copy(_tmpColor);
      } else if (strip.style === 'disco') {
        // Disco lights: rapid strobe-like color flashing
        const hue = (elapsedTime * 0.5 + strip.phase) % 1.0;
        _tmpColor.setHSL(hue, 1.0, 0.6);
        const strobe = Math.sin(elapsedTime * 8 + strip.phase * 7) > 0 ? 105.0 : 16.0;
        strip.mat.emissive.copy(_tmpColor);
        strip.mat.emissiveIntensity = strobe;
        strip.mat.color.copy(_tmpColor);
      } else {
        if (strip.style === 'neon') {
          // City neon signs: blink on/off + color pulse
          const blink = Math.sin(elapsedTime * 3 + strip.phase * 5) > -0.3 ? 1 : 0.1;
          const intensity = 4.0 * blink;
          strip.mat.emissiveIntensity = intensity;
          continue;
        }
        // Multi-color: each strip gets its OWN hue based on phase
        const hue = (elapsedTime * 0.08 + strip.phase * 0.7) % 1.0;
        _tmpColor.setHSL(hue, 1.0, 0.45);
        const intensity = 63.0 + Math.sin(elapsedTime * 2.5 + strip.phase * 6) * 26.0;
        strip.mat.emissive.copy(_tmpColor);
        strip.mat.emissiveIntensity = intensity;
        strip.mat.color.copy(_tmpColor);
      }
    }
  }

  // Day: LEDs show as plain grey/off strips (not glowing, not colorful)
  if (frameCount % 2 === 0 && !isNightMode) {
    for (const strip of ledStrips) {
      strip.mat.emissiveIntensity = 0;
      strip.mat.emissive.setRGB(0, 0, 0);
      strip.mat.color.setRGB(0.4, 0.4, 0.4); // neutral grey, like switched-off LEDs
    }
  }

  // Stage lights (only at night)
  if (frameCount % 3 === 0) {
    for (const sl of stageLights) {
      if (isNightMode) {
        sl.light.color.setHSL((elapsedTime * 0.15 + sl.phase) % 1.0, 0.9, 0.6);
        sl.light.intensity = 15 + Math.sin(elapsedTime * 1.5 + sl.phase) * 8;
      } else {
        sl.light.intensity = 0;
      }
    }
  }

  renderer.info.autoReset = false;
  renderer.info.reset();
  // Sky dome follows camera exactly (prevent walking out of skydome)
  // Y must track camera too – otherwise sky bleeds through ceilings (depthTest:false)
  if (skyMesh) {
    skyMesh.position.x = camera.position.x;
    skyMesh.position.y = camera.position.y;
    skyMesh.position.z = camera.position.z;
  }
  if (window.__moonMesh && window.__moonMesh.visible) {
    window.__moonMesh.position.x = camera.position.x - 200;
    window.__moonMesh.position.z = camera.position.z - 150;
  }

  composer.render(dt);
  const drawCalls = renderer.info.render.calls;
  const triangles = renderer.info.render.triangles;

  // Minimap every 3rd frame
  if (frameCount % 3 === 0) minimap.draw(camera);

  // Expose perf metrics for Playwright / console
  const fps = Math.round(1 / (dt || 0.016));
  window.__perf = {
    fps,
    dt: dt * 1000,
    visible: visibleCount,
    total: spatialObjects.length,
    drawCalls,
    triangles,
    lods: lodObjects.length,
    waters: waterMeshes.length,
    frame: frameCount,
    x: camera.position.x,
    z: camera.position.z,
  };

  // Location indicator (always visible, helps navigation)
  if (frameCount % 10 === 0) {
    const px = camera.position.x, pz = camera.position.z;
    let area = 'Straße';
    if (pz > -78 && pz < 160) {
      if (px < -2.5) area = 'Dream Fun World';
      else area = 'Dream Water World';
      if (pz > 80) area += ' – Strand';
      else if (pz > -42) area += ' – Poolbereich';
      else area += ' – Hotel';
    }
    if (pz < -82) area = 'Nördlich (Hügel)';
    const locEl = document.getElementById('location');
    if (locEl) locEl.textContent = area;
  }

  if (showDebug) {
    debugEl.textContent =
      `FPS: ${fps}\n` +
      `Spatial: ${visibleCount} / ${spatialObjects.length}\n` +
      `Draw: ${renderer.info.render.calls} | Tri: ${renderer.info.render.triangles}\n` +
      `Mats: ${Object.keys(matCache).length} | LODs: ${lodObjects.length}\n` +
      `Pos: ${camera.position.x.toFixed(0)}, ${camera.position.z.toFixed(0)}`;
  }
}

init();
