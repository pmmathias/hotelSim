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
const floors = [];   // { min:{x,z}, max:{x,z}, y } – walkable surfaces at different heights

function addCollider(x, z, w, d, maxY = Infinity) {
  colliders.push({ min: { x: x - w / 2, z: z - d / 2 }, max: { x: x + w / 2, z: z + d / 2 }, maxY });
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
  const key = _colGridKey(px, pz);
  const cell = _colGrid.get(key);
  if (!cell) return false;
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i];
    if (px + PLAYER_RADIUS > c.min.x && px - PLAYER_RADIUS < c.max.x &&
        pz + PLAYER_RADIUS > c.min.z && pz - PLAYER_RADIUS < c.max.z) {
      if (c.maxY < Infinity && feetY > c.maxY) continue;
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
  // Scale UVs proportional to world size (1 repeat per 2m)
  // This prevents textures from being stretched on large surfaces
  const uvAttr = geo.attributes.uv;
  if (uvAttr) {
    const tileScale = 0.5; // 1 repeat per 2 meters
    for (let i = 0; i < uvAttr.count; i++) {
      // BoxGeometry faces: determine which axis this face uses
      // by checking the normal (position in the buffer)
      const faceIdx = Math.floor(i / 4); // 6 faces, 4 verts each
      let su, sv;
      if (faceIdx < 2) { su = w; sv = h; }      // +/- Z faces
      else if (faceIdx < 4) { su = w; sv = d; }  // +/- Y faces
      else { su = d; sv = h; }                     // +/- X faces
      uvAttr.setXY(i,
        uvAttr.getX(i) * su * tileScale,
        uvAttr.getY(i) * sv * tileScale
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
  return getCachedMat('glass', () => new THREE.MeshPhysicalMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.15,
    transmission: 0.9, thickness: 0.5, ior: 1.5,
    roughness: 0.02, metalness: 0.0,
    envMap, envMapIntensity: 0.8,
  }));
}

function getMarbleMat() {
  return getCachedMat('marble', () => new THREE.MeshPhysicalMaterial({
    map: textures.marble, roughness: 0.15, metalness: 0.0,
    clearcoat: 0.6, clearcoatRoughness: 0.15,
    envMap, envMapIntensity: 0.5,
  }));
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
  // South wall: two segments + entrance gap (to pool area)
  walls.push(makeBox(segW, totalH, wallT, wallMat, -(entranceW / 2 + segW / 2), totalH / 2, depth / 2));
  walls.push(makeBox(segW, totalH, wallT, wallMat, (entranceW / 2 + segW / 2), totalH / 2, depth / 2));
  walls.push(makeBox(entranceW, totalH - floorH, wallT, wallMat, 0, floorH + (totalH - floorH) / 2, depth / 2));
  walls.forEach(w => { w.castShadow = true; w.receiveShadow = true; hiGroup.add(w); });

  // Glass entrance doors (north + south)
  const doorGlassMat = getCachedMat('door_glass', () => new THREE.MeshStandardMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.25, roughness: 0.02, metalness: 0.1,
    envMap, envMapIntensity: 0.8, side: THREE.DoubleSide,
  }));
  const doorFrameMat2 = getCachedMat('door_frame', () => new THREE.MeshStandardMaterial({
    color: 0x555555, metalness: 0.5, roughness: 0.2,
  }));
  const doorH = floorH - 0.3; // slightly less than floor height
  for (const faceSign of [-1, 1]) { // -1=north, +1=south
    const dz = faceSign * (depth / 2);
    // Two glass door panels (left + right of center, with gap for walking through)
    const panelW = (entranceW - 1.5) / 2; // leave 1.5m walkway in center
    for (const side of [-1, 1]) {
      const dx = side * (panelW / 2 + 0.75);
      hiGroup.add(makeBox(panelW, doorH, 0.06, doorGlassMat, dx, doorH / 2, dz));
    }
    // Metal frame: top crossbar
    hiGroup.add(makeBox(entranceW, 0.12, 0.1, doorFrameMat2, 0, doorH, dz));
    // Frame: side pillars
    hiGroup.add(makeBox(0.1, doorH, 0.1, doorFrameMat2, -entranceW / 2, doorH / 2, dz));
    hiGroup.add(makeBox(0.1, doorH, 0.1, doorFrameMat2, entranceW / 2, doorH / 2, dz));
    // Frame: center divider
    hiGroup.add(makeBox(0.08, doorH, 0.1, doorFrameMat2, 0, doorH / 2, dz));
  }

  // Floor slabs (no shadow cast – internal)
  const slabMat = makePBR('slab', { color: 0xdddddd, roughness: 0.8 });
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
  const balconyW = 4, balconyD = 1.2;
  const cols = Math.floor(width / (balconyW + 0.5));
  const startX = -(cols * (balconyW + 0.5)) / 2 + balconyW / 2;
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
      const bx = startX + c * (balconyW + 0.5);
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

        hiGroup.add(makeBox(balconyW, 0.15, balconyD, balconyMat, bx, by, fz_bal));
        hiGroup.add(makeBox(balconyW, 1, 0.05, glassMat, bx, by + 0.5, fz_rail));
        if (faceSign > 0) { // windows only on south
          hiGroup.add(makeBox(balconyW - 0.6, floorH * 0.6, 0.08, glassMat, bx, by, fz_win));
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
  // East + West walls
  addCollider(x + width / 2, z, wallT, depth);
  addCollider(x - width / 2, z, wallT, depth);
  // South wall segments (with entrance gap)
  addCollider(x - (entranceW / 2 + segW / 2), z + depth / 2, segW, wallT);
  addCollider(x + (entranceW / 2 + segW / 2), z + depth / 2, segW, wallT);
  // North wall: two segments with entrance gap
  addCollider(x - (entranceW / 2 + segW / 2), z - depth / 2, segW, wallT);
  addCollider(x + (entranceW / 2 + segW / 2), z - depth / 2, segW, wallT);

  return lod;
}

// ---------------------------------------------------------------------------
// Lobby interior – detailed with stairs, furniture, textures
// ---------------------------------------------------------------------------
// =============================================================================
// AUTO-DOOR SYSTEM – doors slide open when player approaches
// =============================================================================
function addAutoDoor(group, x, y, z, w, h, slideAxis, slideAmount, buildingX, buildingZ) {
  const doorMat = getCachedMat('auto_door', () => new THREE.MeshStandardMaterial({
    map: textures.woodWalnut, roughness: 0.4, color: 0x6a5040,
  }));
  const door = makeBox(
    slideAxis === 'x' ? 0.08 : w,
    h,
    slideAxis === 'z' ? 0.08 : w,
    doorMat, x, y + h / 2, z
  );
  group.add(door);

  autoDoors.push({
    mesh: door,
    // World position (building offset added later in animate loop)
    localX: x, localZ: z,
    buildingX, buildingZ,
    slideAxis,
    slideAmount,
    isOpen: false,
    t: 0, // animation progress 0=closed, 1=open
    closedX: x, closedZ: z,
  });
}

function updateLifts(cam, dt) {
  for (const lift of lifts) {
    const wx = lift.buildingX + lift.localX;
    const wz = lift.buildingZ + lift.localZ;
    const px = cam.position.x, pz = cam.position.z, py = cam.position.y;

    // Check if player is inside lift shaft
    const inLift = Math.abs(px - wx) < lift.w / 2 &&
                   Math.abs(pz - wz) < lift.d / 2 &&
                   py > lift.currentFloor * lift.H &&
                   py < (lift.currentFloor + 1) * lift.H + 2;

    switch (lift.state) {
      case 'idle':
        // Doors open, waiting for player to enter
        lift.doorL.position.z = lift.doorClosedZL - 1; // open position
        lift.doorR.position.z = lift.doorClosedZR + 1;
        if (inLift) {
          lift.state = 'closing';
          lift.timer = 0;
          // Pick next floor (cycle: 0→1→2→0)
          lift.targetFloor = (lift.currentFloor + 1) % 3;
        }
        break;

      case 'closing':
        lift.timer += dt;
        // Doors closing animation (1 second)
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
        // Move camera between floors (2 seconds)
        const moveT = Math.min(1, lift.timer / 2.0);
        const smoothT = moveT * moveT * (3 - 2 * moveT); // smoothstep
        const fromY = lift.currentFloor * lift.H + PLAYER_HEIGHT;
        const toY = lift.targetFloor * lift.H + PLAYER_HEIGHT;
        if (inLift || Math.abs(px - wx) < lift.w) {
          cam.position.y = fromY + (toY - fromY) * smoothT;
        }
        if (moveT >= 1) {
          lift.currentFloor = lift.targetFloor;
          lift.state = 'opening';
          lift.timer = 0;
        }
        break;

      case 'opening':
        lift.timer += dt;
        // Doors opening (1 second)
        const openT = Math.min(1, lift.timer / 1.0);
        lift.doorL.position.z = lift.doorClosedZL - openT * 1;
        lift.doorR.position.z = lift.doorClosedZR + openT * 1;
        if (openT >= 1) {
          lift.state = 'idle';
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

    const shouldOpen = dist < 3;
    const shouldClose = dist > 4.5;

    if (shouldOpen && !d.isOpen) d.isOpen = true;
    if (shouldClose && d.isOpen) d.isOpen = false;

    // Smooth animation
    const target = d.isOpen ? 1 : 0;
    d.t += (target - d.t) * Math.min(1, dt * 5); // lerp speed

    if (d.slideAxis === 'x') {
      d.mesh.position.x = d.closedX + d.t * d.slideAmount;
    } else {
      d.mesh.position.z = d.closedZ + d.t * d.slideAmount;
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
  const woodMat = getCachedMat('desk_wood', () => new THREE.MeshPhysicalMaterial({
    map: textures.woodWalnut, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.3,
  }));
  const accentMat = getCachedMat('accent_' + accentColor, () => new THREE.MeshStandardMaterial({
    color: accentColor, emissive: accentColor, emissiveIntensity: 0.6, roughness: 0.2,
  }));
  const ceilPanelMat = getCachedMat('ceil_panel', () => new THREE.MeshStandardMaterial({
    color: 0xfff8f0, emissive: 0xfff5e8, emissiveIntensity: 1.5, roughness: 0.2, side: THREE.DoubleSide,
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
  const stairX = W / 2 - 4;   // against east wall
  const stairW = 3.5;
  const stairD = 10;
  const stairStartZ = -D / 2 + 4;

  const stairMat = getCachedMat('stair_marble', () => new THREE.MeshStandardMaterial({
    map: textures.lobbyFloor, roughness: 0.3, envMap, envMapIntensity: 0.2,
  }));
  const railMat = getCachedMat('railing', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.6, roughness: 0.2,
  }));

  // Stairwell walls (enclosing the staircase, all 3 floors)
  const swH = H * 3;
  group.add(makeBox(0.15, swH, stairD + 2, damaskMat, stairX - stairW / 2 - 0.1, swH / 2, stairStartZ + stairD / 2));
  group.add(makeBox(stairW + 0.5, swH, 0.15, damaskMat, stairX, swH / 2, stairStartZ + stairD + 1));
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
  const y = 0;

  // === FLOOR (marble) ===
  const floorBox = makeBox(W - 1, 0.3, D - 1, marbleMat, 0, 0.15, 0);
  floorBox.receiveShadow = true;
  group.add(floorBox);

  // === CEILING ===
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W - 1, D - 1), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, H - 0.05, 0);
  group.add(ceil);

  // === INTERIOR WALLS (Damask on all 4 sides) ===
  const panelH = H - 0.8;
  const panelY = panelH / 2 + 0.4;
  // South wall
  group.add(makeBox(W - 2, panelH, 0.06, damaskMat, 0, panelY, D / 2 - 0.4));
  // North wall (left + right of entrance, 12m gap)
  const northPanelW = (W - 14) / 2;
  group.add(makeBox(northPanelW, panelH, 0.06, damaskMat, -(northPanelW / 2 + 7), panelY, -(D / 2 - 0.4)));
  group.add(makeBox(northPanelW, panelH, 0.06, damaskMat, (northPanelW / 2 + 7), panelY, -(D / 2 - 0.4)));
  // East wall
  group.add(makeBox(0.06, panelH, D - 2, damaskMat, W / 2 - 0.4, panelY, 0));
  // West wall
  group.add(makeBox(0.06, panelH, D - 2, damaskMat, -(W / 2 - 0.4), panelY, 0));

  // === ACCENT STRIP (bottom of south wall) ===
  group.add(makeBox(W - 2, 0.6, 0.07, accentMat, 0, 0.3, D / 2 - 0.45));

  // === PARTITION WALLS ===
  // Lift room east wall
  const liftX = -W / 2 + 4;
  group.add(makeBox(T, H, 8, damaskMat, liftX + 2, H / 2, -D / 2 + 4));
  // Reception west wall
  const recpX = W / 2 - 20;
  group.add(makeBox(T, H, 14, damaskMat, recpX, H / 2, -D / 2 + 7));
  // Toilet room walls (west side)
  group.add(makeBox(8, H, T, damaskMat, -W / 2 + 5, H / 2, 3));   // south wall
  group.add(makeBox(T, H, 6, damaskMat, -W / 2 + 9, H / 2, 0));   // east wall
  // Bar west wall
  group.add(makeBox(T, H, 10, damaskMat, recpX, H / 2, 5));
  // Restaurant north wall (with 2 openings)
  const restZ = D / 2 - 12;
  group.add(makeBox(25, H, T, damaskMat, -18, H / 2, restZ));
  group.add(makeBox(18, H, T, damaskMat, 28, H / 2, restZ));

  // === LOBBY FURNITURE ===
  // Chandelier (center of lobby)
  const chandelierMat = getCachedMat('chandelier', () => new THREE.MeshStandardMaterial({
    color: 0xddcc88, metalness: 0.6, roughness: 0.2,
  }));
  const chandelierGlow = new THREE.MeshStandardMaterial({
    color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 1.5,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.08, 8, 20), chandelierMat);
  ring.position.set(-5, H - 0.6, -D / 2 + 10);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 4), chandelierMat);
  rod.position.set(-5, H - 0.3, -D / 2 + 10);
  group.add(rod);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 6), chandelierGlow);
    bulb.position.set(-5 + Math.cos(a) * 2, H - 0.6, -D / 2 + 10 + Math.sin(a) * 2);
    group.add(bulb);
  }

  // Sofas (left + right of lobby center)
  const sofaMat = getCachedMat('sofa_lobby', () => new THREE.MeshStandardMaterial({
    color: isWater ? 0x2a4a6a : 0x6a2a3a, roughness: 0.85,
  }));
  for (const side of [-1, 1]) {
    const sx = -5 + side * 15;
    const sz = -D / 2 + 12;
    group.add(makeBox(4, 0.4, 1.2, sofaMat, sx, 0.55, sz));
    group.add(makeBox(4, 0.5, 0.2, sofaMat, sx, 0.9, sz - 0.5));
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx - 1.9, 0.8, sz));
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx + 1.9, 0.8, sz));
  }
  // Coffee table
  group.add(makeBox(2.5, 0.05, 1, woodMat, -5, 0.55, -D / 2 + 12));
  // Lobby rug
  const rugMat = getCachedMat('rug_' + (isWater ? 'w' : 'f'), () => new THREE.MeshStandardMaterial({
    color: isWater ? 0x1a3a5a : 0x5a1a2a, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
  }));
  group.add(makePlane(10, 14, rugMat, -5, 0.35, -D / 2 + 10));
  // Plants
  const potMat = getCachedMat('pot', () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
  const plantMat = getCachedMat('plant', () => new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.8 }));
  for (const [px, pz] of [[-25, -D / 2 + 4], [10, -D / 2 + 4], [-25, 0], [10, 0]]) {
    group.add(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.6, 6), potMat));
    group.children[group.children.length - 1].position.set(px, 0.45, pz);
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), plantMat));
    group.children[group.children.length - 1].position.set(px, 1.1, pz);
  }

  // === RECEPTION ===
  const deskTopMat = getCachedMat('desk_top', () => new THREE.MeshStandardMaterial({
    color: 0x2a1a08, roughness: 0.15, envMap, envMapIntensity: 0.3,
  }));
  const rX = W / 2 - 15, rZ = -D / 2 + 6;
  group.add(makeBox(8, 1.0, 1.5, woodMat, rX, 0.65, rZ));
  group.add(makeBox(8.2, 0.06, 1.7, deskTopMat, rX, 1.17, rZ));
  group.add(makeBox(8, 0.1, 0.05, accentMat, rX, 0.9, rZ + 0.8));
  // Monitors
  const monMat = getCachedMat('monitor', () => new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.3 }));
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, emissive: 0x88ccff, emissiveIntensity: 0.4 });
  for (const mx of [-2.5, 0, 2.5]) {
    group.add(makeBox(0.6, 0.4, 0.04, monMat, rX + mx, 1.45, rZ - 0.2));
    group.add(makeBox(0.5, 0.3, 0.02, screenMat, rX + mx, 1.45, rZ - 0.22));
  }

  // === LIFT SHAFT (northwest corner, all 3 floors) ===
  // liftX already defined above at line ~568
  const liftZ = -D / 2 + 4;
  const liftW = 3.5, liftD = 3.5;
  const liftTotalH = H * 3; // spans all 3 floors
  const liftMetalMat = getCachedMat('lift_metal', () => new THREE.MeshStandardMaterial({
    color: 0x888888, metalness: 0.6, roughness: 0.2,
  }));
  const liftWallMat = getCachedMat('lift_wall', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, roughness: 0.4, metalness: 0.2,
  }));

  // Shaft walls (full height, 3 floors)
  // Back wall (west)
  group.add(makeBox(0.15, liftTotalH, liftD, liftWallMat, liftX - liftW / 2, liftTotalH / 2, liftZ));
  // Left wall (north)
  group.add(makeBox(liftW, liftTotalH, 0.15, liftWallMat, liftX, liftTotalH / 2, liftZ - liftD / 2));
  // Right wall (south)
  group.add(makeBox(liftW, liftTotalH, 0.15, liftWallMat, liftX, liftTotalH / 2, liftZ + liftD / 2));
  // Front (east) – metal frame with opening for door
  group.add(makeBox(0.15, liftTotalH, (liftD - 2) / 2, liftMetalMat,
    liftX + liftW / 2, liftTotalH / 2, liftZ - liftD / 2 + (liftD - 2) / 4));
  group.add(makeBox(0.15, liftTotalH, (liftD - 2) / 2, liftMetalMat,
    liftX + liftW / 2, liftTotalH / 2, liftZ + liftD / 2 - (liftD - 2) / 4));
  // Lintel above door openings (per floor)
  for (let fl = 0; fl < 3; fl++) {
    group.add(makeBox(0.15, 0.5, 2, liftMetalMat,
      liftX + liftW / 2, (fl + 1) * H - 0.25, liftZ));
  }

  // Lift door (at ground floor, will be animated by Ticket 111)
  const liftDoorMat = getCachedMat('lift_door', () => new THREE.MeshStandardMaterial({
    color: 0x999999, metalness: 0.7, roughness: 0.15,
  }));
  const liftDoorL = makeBox(0.06, H - 0.8, 1, liftDoorMat,
    liftX + liftW / 2 + 0.05, H / 2 - 0.1, liftZ - 0.5);
  const liftDoorR = makeBox(0.06, H - 0.8, 1, liftDoorMat,
    liftX + liftW / 2 + 0.05, H / 2 - 0.1, liftZ + 0.5);
  group.add(liftDoorL);
  group.add(liftDoorR);

  // Register lift for physics
  lifts.push({
    buildingX: _currentBuildingX, buildingZ: _currentBuildingZ,
    localX: liftX, localZ: liftZ,
    w: liftW, d: liftD, H,
    currentFloor: 0,
    state: 'idle', // idle, closing, moving, opening
    timer: 0,
    targetFloor: 0,
    doorL: liftDoorL, doorR: liftDoorR,
    doorClosedZL: liftZ - 0.5, doorClosedZR: liftZ + 0.5,
  });

  // Cabin interior: mirror on back wall, buttons, light
  const mirrorMat2 = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({
    color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0,
  }));
  group.add(makeBox(liftW - 0.5, H - 1.5, 0.04, mirrorMat2,
    liftX - liftW / 2 + 0.2, H / 2, liftZ)); // mirror on back wall
  // Button panel
  const btnPanelMat = getCachedMat('btn_panel', () => new THREE.MeshStandardMaterial({
    color: 0x333333, roughness: 0.5, metalness: 0.3,
  }));
  group.add(makeBox(0.3, 0.6, 0.04, btnPanelMat,
    liftX, 1.3, liftZ + liftD / 2 - 0.1));
  // 3 floor buttons (small emissive dots)
  const btnGlow = new THREE.MeshStandardMaterial({
    color: 0x44ff44, emissive: 0x44ff44, emissiveIntensity: 0.8,
  });
  for (let bi = 0; bi < 3; bi++) {
    group.add(makeBox(0.08, 0.08, 0.02, btnGlow,
      liftX, 1.1 + bi * 0.15, liftZ + liftD / 2 - 0.08));
  }
  // Cabin ceiling light
  group.add(makeBox(1.5, 0.04, 1.5, ceilPanelMat, liftX, H - 0.1, liftZ));
  const liftLight = new THREE.PointLight(0xffffff, 4, 8);
  liftLight.position.set(liftX, H - 0.5, liftZ);
  liftLight._dayIntensity = 4;
  group.add(liftLight);
  lobbyLights.push(liftLight);

  // === TOILETS (west side, south of lift) ===
  const wcX = -W / 2 + 5;
  const wcZ = 0;
  // Toilet door (slides open)
  addAutoDoor(group, -W / 2 + 9, 0, -1, 1.2, 2.2, 'z', -1.5,
    _currentBuildingX, _currentBuildingZ);
  // Tile floor
  const tileMat = getCachedMat('wc_tiles', () => new THREE.MeshStandardMaterial({
    color: 0xd8d0c8, roughness: 0.25,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  group.add(makePlane(7, 5, tileMat, wcX, 0.35, wcZ));

  // 3 toilet stalls along west wall
  const toiletMat = getCachedMat('toilet_white', () => new THREE.MeshStandardMaterial({
    color: 0xf0f0f0, roughness: 0.3,
  }));
  const stallWallMat = getCachedMat('stall_wall', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, roughness: 0.6,
  }));
  for (let si = 0; si < 3; si++) {
    const sz = wcZ - 2 + si * 2;
    // Stall partition wall
    if (si > 0) {
      group.add(makeBox(1.8, 1.8, 0.08, stallWallMat, wcX - 1, 1.1, sz - 1));
    }
    // Toilet bowl (procedural: base box + seat + tank)
    const tx = wcX - 1.5;
    group.add(makeBox(0.45, 0.38, 0.55, toiletMat, tx, 0.34, sz));     // bowl
    group.add(makeBox(0.4, 0.5, 0.2, toiletMat, tx, 0.4, sz - 0.35));  // tank
    group.add(makeBox(0.42, 0.04, 0.4, toiletMat, tx, 0.55, sz + 0.05)); // seat
    // Flush handle
    group.add(makeBox(0.08, 0.12, 0.04, getCachedMat('chrome', () => new THREE.MeshStandardMaterial({
      color: 0xcccccc, metalness: 0.8, roughness: 0.1,
    })), tx + 0.22, 0.55, sz - 0.3));
  }

  // 2 sinks along east wall of WC
  for (let si = 0; si < 2; si++) {
    const sz = wcZ - 1 + si * 2;
    const sx = wcX + 2;
    // Sink basin
    group.add(makeBox(0.6, 0.1, 0.45, toiletMat, sx, 0.85, sz));
    // Pedestal
    group.add(makeBox(0.15, 0.85, 0.15, toiletMat, sx, 0.43, sz));
    // Faucet
    group.add(makeBox(0.06, 0.2, 0.06, getCachedMat('chrome', () => new THREE.MeshStandardMaterial({
      color: 0xcccccc, metalness: 0.8, roughness: 0.1,
    })), sx, 1.0, sz - 0.15));
    // Mirror
    group.add(makeBox(0.5, 0.7, 0.04, getCachedMat('mirror', () => new THREE.MeshStandardMaterial({
      color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0,
    })), sx, 1.5, sz - 0.35));
  }

  // WC light
  const wcLight = new THREE.PointLight(0xffffff, 6, 12);
  wcLight.position.set(wcX, H - 1.5, wcZ);
  wcLight._dayIntensity = 6;
  group.add(wcLight);
  lobbyLights.push(wcLight);

  // === BAR / LOUNGE (east side, south of reception) ===
  const barX = W / 2 - 15;
  const barZ = 2;
  // Bar counter (L-shape: long + short arm)
  const barCounterMat = getCachedMat('bar_counter', () => new THREE.MeshStandardMaterial({
    color: 0x1a1a2a, roughness: 0.15, metalness: 0.1, envMap, envMapIntensity: 0.4,
  }));
  const barTopMat2 = getCachedMat('bar_top', () => new THREE.MeshStandardMaterial({
    color: 0x0a0a1a, roughness: 0.08, metalness: 0.15, envMap, envMapIntensity: 0.5,
  }));
  // Long arm
  group.add(makeBox(7, 1.1, 0.8, barCounterMat, barX, 0.7, barZ));
  group.add(makeBox(7.2, 0.06, 1.0, barTopMat2, barX, 1.27, barZ));
  // Short arm (perpendicular)
  group.add(makeBox(0.8, 1.1, 3, barCounterMat, barX + 3.9, 0.7, barZ - 2));
  group.add(makeBox(1.0, 0.06, 3.2, barTopMat2, barX + 3.9, 1.27, barZ - 2));

  // 4 Bar stools
  const stoolMat = getCachedMat('stool', () => new THREE.MeshStandardMaterial({
    color: 0x444444, metalness: 0.4, roughness: 0.3,
  }));
  const stoolSeatMat = getCachedMat('stool_seat', () => new THREE.MeshStandardMaterial({
    color: 0x3a2a1a, roughness: 0.7,
  }));
  for (let si = 0; si < 4; si++) {
    const sx = barX - 2.5 + si * 1.8;
    // Pole
    group.add(makeBox(0.06, 0.75, 0.06, stoolMat, sx, 0.5, barZ + 0.8));
    // Seat (cylinder)
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.08, 6), stoolSeatMat);
    seat.position.set(sx, 0.88, barZ + 0.8);
    group.add(seat);
    // Footrest ring
    group.add(makeBox(0.25, 0.03, 0.25, stoolMat, sx, 0.3, barZ + 0.8));
  }

  // Bottle shelf (behind bar, against east wall)
  const shelfMat = getCachedMat('bar_shelf', () => new THREE.MeshStandardMaterial({
    color: 0x2a1a0a, roughness: 0.5,
  }));
  // Shelf back panel
  group.add(makeBox(7, 2.5, 0.15, shelfMat, barX, 1.8, barZ - 0.7));
  // 3 shelf boards
  for (let sh = 0; sh < 3; sh++) {
    group.add(makeBox(6.5, 0.08, 0.35, shelfMat, barX, 1.0 + sh * 0.7, barZ - 0.5));
  }
  // Bottles (colored boxes on shelves)
  const bottleColors = [0x1a5a1a, 0x8a4a1a, 0xaa8822, 0x2a2a6a, 0x6a1a1a, 0xccaa00];
  for (let sh = 0; sh < 3; sh++) {
    for (let bi = 0; bi < 5; bi++) {
      const bx = barX - 2.5 + bi * 1.3;
      const by = 1.1 + sh * 0.7;
      const col = bottleColors[(sh * 5 + bi) % bottleColors.length];
      group.add(makeBox(0.15, 0.4, 0.15, new THREE.MeshStandardMaterial({
        color: col, roughness: 0.3, metalness: 0.1,
      }), bx, by, barZ - 0.45));
    }
  }

  // Bar warm light
  const barLight = new THREE.PointLight(0xffddaa, 8, 15);
  barLight.position.set(barX, H - 1.5, barZ);
  barLight._dayIntensity = 8;
  group.add(barLight);
  lobbyLights.push(barLight);

  // === RESTAURANT (south section) ===
  const restaurantZ = D / 2 - 6;
  const restW = W - 12;
  // Restaurant floor (warm tile, different from lobby marble)
  const restFloorMat = getCachedMat('rest_floor', () => new THREE.MeshStandardMaterial({
    map: textures.concrete, color: 0xc8b8a0, roughness: 0.6,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  group.add(makePlane(restW, 11, restFloorMat, 0, 0.35, restZ));

  // Buffet counter (center island)
  const buffetMat = getCachedMat('buffet', () => new THREE.MeshStandardMaterial({
    color: 0x888888, metalness: 0.3, roughness: 0.4,
  }));
  group.add(makeBox(18, 0.9, 1.2, buffetMat, 0, 0.6, restaurantZ - 2));
  group.add(makeBox(18.2, 0.05, 1.4, getCachedMat('buffet_top', () => new THREE.MeshStandardMaterial({
    color: 0xdddddd, roughness: 0.2, metalness: 0.1 })), 0, 1.07, restaurantZ - 2));
  // Food display domes
  const domeMat = getCachedMat('food_dome', () => new THREE.MeshStandardMaterial({
    color: 0xaaddff, transparent: true, opacity: 0.2, roughness: 0.05 }));
  const foodColors = [0xcc8844, 0x88cc44, 0xcc4444, 0xddaa22, 0x44aa88];
  for (let fi = 0; fi < 5; fi++) {
    const fx = -7 + fi * 3.5;
    group.add(makeBox(1.5, 0.6, 0.8, domeMat, fx, 1.4, restaurantZ - 2));
    group.add(makeBox(1.2, 0.2, 0.5, new THREE.MeshStandardMaterial({ color: foodColors[fi], roughness: 0.8 }),
      fx, 1.2, restaurantZ - 2));
  }

  // Dining tables (2 rows x 4 columns)
  const tableMat2 = getCachedMat('dining_table', () => new THREE.MeshStandardMaterial({
    map: textures.woodOak, roughness: 0.35 }));
  const chairMat2 = getCachedMat('dining_chair', () => new THREE.MeshStandardMaterial({
    color: 0x5a4a3a, roughness: 0.7 }));
  const tlegMat = getCachedMat('table_legs', () => new THREE.MeshStandardMaterial({
    color: 0x444444, metalness: 0.4, roughness: 0.3 }));
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const tx = -restW / 2 + 12 + col * (restW - 20) / 3;
      const tz = restaurantZ + 1 + row * 4;
      group.add(makeBox(2.0, 0.06, 1.2, tableMat2, tx, 0.78, tz));
      group.add(makeBox(0.1, 0.75, 0.1, tlegMat, tx, 0.4, tz));
      // 2 chairs per table (simplified for performance)
      for (const side of [-1.2, 1.2]) {
        group.add(makeBox(0.45, 0.04, 0.45, chairMat2, tx + side, 0.48, tz));
        group.add(makeBox(0.45, 0.4, 0.05, chairMat2, tx + side, 0.7, tz + (side < 0 ? -0.2 : 0.2)));
        group.add(makeBox(0.04, 0.46, 0.04, tlegMat, tx + side, 0.24, tz));
      }
    }
  }

  // === HOTEL LOGO (south back wall) ===
  group.add(makeBox(8, 2.5, 0.12, accentMat, 0, 2.5, D / 2 - 0.35));
  group.add(makeBox(7, 1.5, 0.05, new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3,
  }), 0, 2.5, D / 2 - 0.42));

  // === LIGHTING (pendant lights, always bright) ===
  const lightPositions = [
    { x: -5, z: -D / 2 + 8, int: 3 },   // lobby front
    { x: -5, z: 0, int: 2.5 },            // lobby center
    { x: W / 2 - 15, z: -D / 2 + 6, int: 2 }, // reception
    { x: W / 2 - 15, z: 5, int: 1.8 },    // bar area
    { x: 0, z: D / 2 - 6, int: 2.5 },     // restaurant
  ];
  for (const lp of lightPositions) {
    const pl = new THREE.PointLight(0xfff0dd, lp.int * 10, 45);
    pl.position.set(lp.x, H - 1.5, lp.z);
    pl._dayIntensity = lp.int * 10;
    group.add(pl);
    lobbyLights.push(pl);
    // Ceiling panel above
    group.add(makeBox(3.5, 0.06, 1.2, ceilPanelMat, lp.x, H - 0.08, lp.z));
    // Pendant rod
    group.add(makeBox(0.03, 1.4, 0.03, getCachedMat('pendant_rod', () =>
      new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5 })),
      lp.x, H - 0.75, lp.z));
  }
}

// =============================================================================
// UPPER FLOOR (1.OG or 2.OG) – Hallway + 4 Rooms with Bathrooms
// =============================================================================
function createUpperFloor(group, W, D, H, floorNum, damaskMat, ceilMat, woodMat, ceilPanelMat, accentColor) {
  const y = floorNum * H; // base Y of this floor
  const stairX = W / 2 - 4; // staircase position (east)
  const liftX2 = -W / 2 + 4; // lift position (west)

  // Materials
  const laminateMat = getCachedMat('laminate', () => new THREE.MeshStandardMaterial({
    color: 0xc8a882, roughness: 0.45,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  const tileMat2 = getCachedMat('wc_tiles', () => new THREE.MeshStandardMaterial({
    color: 0xd8d0c8, roughness: 0.25,
    polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
  }));
  const bedMat = getCachedMat('bedsheet', () => new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.9 }));
  const bedFrameMat = getCachedMat('bedframe', () => new THREE.MeshStandardMaterial({ map: textures.woodOak, roughness: 0.4 }));
  const nightMat = getCachedMat('nightstand', () => new THREE.MeshStandardMaterial({ map: textures.woodWalnut, roughness: 0.35 }));
  const doorFrameMat = getCachedMat('doorframe', () => new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.4 }));
  const toiletMat2 = getCachedMat('toilet_white', () => new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.3 }));
  const chromeMat = getCachedMat('chrome', () => new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.1 }));
  const mirrorMat3 = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({ color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0 }));
  const glassMat2 = getGlassMat();

  // === FLOOR SLAB (with stairwell opening) ===
  // Main slab (left of stairwell)
  const slabLeftW = W - 10; // everything except stair+lift area
  group.add(makeBox(slabLeftW, 0.3, D - 2, laminateMat, -2, y, 0));

  // === CEILING ===
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W - 4, D - 2), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(0, y + H - 0.05, 0);
  group.add(ceil);

  // === HALLWAY (north side, 3m wide) ===
  const hallD = 3;
  const hallZ = -D / 2 + 3 + hallD / 2; // 3m from north wall
  // Carpet runner
  const carpetMat = getCachedMat('carpet_hall', () => new THREE.MeshStandardMaterial({
    color: accentColor, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -14,
  }));
  group.add(makePlane(W - 16, hallD - 0.5, carpetMat, 0, y + 0.2, hallZ));

  // Hallway ceiling lights
  for (let hx = -W / 4; hx <= W / 4; hx += W / 4) {
    group.add(makeBox(2, 0.04, 1, ceilPanelMat, hx, y + H - 0.1, hallZ));
    const hl = new THREE.PointLight(0xfff5e0, 5, 15);
    hl.position.set(hx, y + H - 1.5, hallZ);
    hl._dayIntensity = 5;
    group.add(hl);
    lobbyLights.push(hl);
  }

  // === 4 ROOMS (south side) ===
  const roomCount = 4;
  const usableW = W - 16; // minus lift (8m) + stairs (8m)
  const roomW = usableW / roomCount;
  const roomD = D - hallD - 5; // depth from hallway to south wall
  const roomStartX = -W / 2 + 8; // after lift shaft

  for (let r = 0; r < roomCount; r++) {
    const rx = roomStartX + r * roomW + roomW / 2;
    const rz = hallZ + hallD / 2 + roomD / 2 + 0.5;
    const doorW2 = 1.2;
    const doorH2 = 2.2;
    const wallH2 = H - 0.5;

    // Room partition walls
    if (r > 0) {
      group.add(makeBox(0.15, wallH2, roomD + 1, damaskMat, rx - roomW / 2, y + wallH2 / 2, rz));
    }

    // North wall (hallway side) with door opening
    const nwSegW = (roomW - doorW2) / 2 - 0.2;
    group.add(makeBox(nwSegW, wallH2, 0.15, damaskMat, rx - roomW / 2 + nwSegW / 2 + 0.1, y + wallH2 / 2, hallZ + hallD / 2));
    group.add(makeBox(nwSegW, wallH2, 0.15, damaskMat, rx + roomW / 2 - nwSegW / 2 - 0.1, y + wallH2 / 2, hallZ + hallD / 2));
    group.add(makeBox(doorW2 + 0.2, wallH2 - doorH2, 0.15, damaskMat, rx, y + doorH2 + (wallH2 - doorH2) / 2, hallZ + hallD / 2));
    // Door frame
    group.add(makeBox(0.08, doorH2, 0.2, doorFrameMat, rx - doorW2 / 2, y + doorH2 / 2, hallZ + hallD / 2));
    group.add(makeBox(0.08, doorH2, 0.2, doorFrameMat, rx + doorW2 / 2, y + doorH2 / 2, hallZ + hallD / 2));
    // Auto-door (slides to the right when player approaches)
    addAutoDoor(group, rx, y, hallZ + hallD / 2, doorW2, doorH2, 'x', doorW2 + 0.3,
      _currentBuildingX, _currentBuildingZ);

    // Room laminate floor
    group.add(makePlane(roomW - 1, roomD - 1, laminateMat, rx, y + 0.2, rz));

    // === BED ===
    group.add(makeBox(2.2, 0.35, 2.0, bedFrameMat, rx, y + 0.32, rz + roomD / 2 - 2));
    group.add(makeBox(2.0, 0.2, 1.8, bedMat, rx, y + 0.55, rz + roomD / 2 - 2));
    group.add(makeBox(1.2, 0.12, 0.35, bedMat, rx, y + 0.72, rz + roomD / 2 - 2.8));
    group.add(makeBox(2.2, 0.8, 0.1, bedFrameMat, rx, y + 0.85, rz + roomD / 2 - 2.9));

    // Nightstand
    group.add(makeBox(0.5, 0.5, 0.4, nightMat, rx + 1.4, y + 0.4, rz + roomD / 2 - 2.5));
    // Lamp on nightstand
    group.add(makeBox(0.15, 0.3, 0.15, getCachedMat('roomlamp', () => new THREE.MeshStandardMaterial({
      color: 0xffeecc, emissive: 0xffddaa, emissiveIntensity: 0.6 })),
      rx + 1.4, y + 0.8, rz + roomD / 2 - 2.5));

    // Window (south wall, glass)
    group.add(makeBox(1.8, 1.4, 0.08, glassMat2, rx, y + 1.8, rz + roomD / 2 - 0.1));

    // Room ceiling light
    group.add(makeBox(1.2, 0.04, 1.2, ceilPanelMat, rx, y + H - 0.12, rz));

    // === BATHROOM (northwest corner of each room) ===
    const bathW2 = 3.5, bathD2 = 3.5;
    const bathX = rx - roomW / 2 + bathW2 / 2 + 0.5;
    const bathZ2 = rz - roomD / 2 + bathD2 / 2 + 0.5;

    // Bathroom partition wall
    group.add(makeBox(0.12, wallH2, bathD2, damaskMat, bathX + bathW2 / 2, y + wallH2 / 2, bathZ2));
    group.add(makeBox(bathW2, wallH2, 0.12, damaskMat, bathX, y + wallH2 / 2, bathZ2 + bathD2 / 2));

    // Bathroom tile floor
    group.add(makePlane(bathW2 - 0.3, bathD2 - 0.3, tileMat2, bathX, y + 0.22, bathZ2));

    // Toilet
    group.add(makeBox(0.45, 0.38, 0.55, toiletMat2, bathX - 0.8, y + 0.34, bathZ2 - 0.5));
    group.add(makeBox(0.4, 0.5, 0.2, toiletMat2, bathX - 0.8, y + 0.4, bathZ2 - 0.85));
    group.add(makeBox(0.42, 0.04, 0.4, toiletMat2, bathX - 0.8, y + 0.55, bathZ2 - 0.45));

    // Sink + mirror
    group.add(makeBox(0.6, 0.1, 0.45, toiletMat2, bathX + 0.5, y + 0.85, bathZ2 - 0.8));
    group.add(makeBox(0.15, 0.85, 0.15, toiletMat2, bathX + 0.5, y + 0.43, bathZ2 - 0.8));
    group.add(makeBox(0.06, 0.2, 0.06, chromeMat, bathX + 0.5, y + 1.0, bathZ2 - 0.95));
    group.add(makeBox(0.5, 0.65, 0.04, mirrorMat3, bathX + 0.5, y + 1.5, bathZ2 - 0.97));
  }
}

// === OLD createLobbyInterior (kept for reference, no longer called) ===
function _old_createLobbyInterior(group, width, depth, floorH, name) {
  const groupX = group.position ? 0 : 0; // local coords within group
  const marbleMat = getMarbleMat();
  const isWater = name.includes('Water');
  const isFun = name.includes('Fun');

  // Accent color per hotel
  const accentColor = isWater ? 0x1155aa : isFun ? 0xff4488 : 0x44aa88;
  const accentMat = getCachedMat('accent_' + accentColor, () => new THREE.MeshStandardMaterial({
    color: accentColor, emissive: accentColor, emissiveIntensity: 0.6, roughness: 0.2,
  }));

  // === FLOOR (fix z-fighting: y=0.05 + polygonOffset) ===
  // Lobby floor: Carrara marble with clearcoat
  const floorBox = makeBox(width - 1, 0.3, depth - 1, getMarbleMat(), 0, 0.15, 0);
  floorBox.receiveShadow = true;
  group.add(floorBox);

  // === CEILING (face downward) ===
  const ceilingMat = getCachedMat('ceiling', () => new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.9, side: THREE.DoubleSide }));
  const ceilingGeo = new THREE.PlaneGeometry(width - 1, depth - 1);
  const ceiling = new THREE.Mesh(ceilingGeo, ceilingMat);
  ceiling.rotation.x = Math.PI / 2; // face down
  ceiling.position.set(0, floorH - 0.05, 0);
  ceiling.receiveShadow = true;
  group.add(ceiling);

  // === INTERIOR WALLS (textured) – back wall is now SOUTH (+depth/2) ===
  const wallIntMat = getCachedMat('wall_int', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xf8f2e8, roughness: 0.75,
  }));
  // === DAMASK WALL PANELS on all 4 interior walls ===
  const panelH = floorH - 0.5;
  const panelY = panelH / 2 + 0.3;
  // South wall (back, closed)
  group.add(makeBox(width - 2, panelH, 0.06, wallIntMat, 0, panelY, depth / 2 - 0.4));
  // North wall (entrance side – left and right of door)
  const doorHalf = (width - 12) / 2; // leave 12m gap for entrance
  group.add(makeBox(doorHalf, panelH, 0.06, wallIntMat, -(doorHalf / 2 + 6), panelY, -(depth / 2 - 0.4)));
  group.add(makeBox(doorHalf, panelH, 0.06, wallIntMat, (doorHalf / 2 + 6), panelY, -(depth / 2 - 0.4)));
  // East wall
  group.add(makeBox(0.06, panelH, depth - 2, wallIntMat, width / 2 - 0.4, panelY, 0));
  // West wall
  group.add(makeBox(0.06, panelH, depth - 2, wallIntMat, -(width / 2 - 0.4), panelY, 0));
  // Accent strip at bottom of south wall
  group.add(makeBox(width - 2, 0.8, 0.07, accentMat, 0, 0.4, depth / 2 - 0.5));

  // === RECEPTION DESK (detailed) ===
  const deskWoodMat = getCachedMat('desk_wood', () => new THREE.MeshPhysicalMaterial({
    map: textures.woodWalnut, roughness: 0.3, metalness: 0.02,
    clearcoat: 0.4, clearcoatRoughness: 0.3,
  }));
  const deskTopMat = getCachedMat('desk_top', () => new THREE.MeshStandardMaterial({
    color: 0x2a1a08, roughness: 0.15, metalness: 0.05, envMap, envMapIntensity: 0.3,
  }));
  // Desk body – near north entrance, player walks in and sees it
  group.add(makeBox(10, 1.0, 1.8, deskWoodMat, 0, 0.5, -depth / 2 + 8));
  // Desk top (polished)
  group.add(makeBox(10.2, 0.08, 2.0, deskTopMat, 0, 1.04, -depth / 2 + 8));
  // Desk front accent strip (facing the entering guest)
  group.add(makeBox(10, 0.1, 0.05, accentMat, 0, 0.8, -depth / 2 + 7.1));
  // Computer monitors on desk
  const monitorMat = getCachedMat('monitor', () => new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.1, metalness: 0.3,
  }));
  for (const mx of [-3, 0, 3]) {
    group.add(makeBox(0.6, 0.4, 0.04, monitorMat, mx, 1.3, -depth / 2 + 8.2));
    group.add(makeBox(0.5, 0.3, 0.02, new THREE.MeshStandardMaterial({
      color: 0x88ccff, emissive: 0x88ccff, emissiveIntensity: 0.4,
    }), mx, 1.3, -depth / 2 + 8.23));
  }

  // === PILLARS (with base and capital) ===
  const pillarMat = getCachedMat('pillar_marble', () => new THREE.MeshStandardMaterial({
    color: 0xe8e0d0, roughness: 0.2, envMap, envMapIntensity: 0.35,
  }));
  const spacing = width / 5;
  for (let i = -1.5; i <= 1.5; i++) {
    const px = i * spacing;
    // Base
    group.add(makeBox(1.2, 0.3, 1.2, pillarMat, px, 0.15, 0));
    // Shaft
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, floorH - 0.6, 8), pillarMat);
    shaft.position.set(px, floorH / 2, 0);
    group.add(shaft);
    // Capital
    group.add(makeBox(1.2, 0.3, 1.2, pillarMat, px, floorH - 0.15, 0));
  }

  // === HOTEL LOGO (south back wall) ===
  group.add(makeBox(8, 2.5, 0.12, accentMat, 0, 2.0, depth / 2 - 0.35));
  // Logo text backing (lighter)
  group.add(makeBox(7, 1.5, 0.05, new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3,
  }), 0, 2.0, depth / 2 - 0.42));

  // === SEATING AREA (lobby sofas) ===
  const sofaColor = isWater ? 0x2a4a6a : 0x6a2a3a;
  const sofaMat = getCachedMat('sofa_' + (isWater ? 'w' : 'f'), () => new THREE.MeshStandardMaterial({
    color: sofaColor, roughness: 0.85,
  }));
  const sofaLegMat = getCachedMat('sofa_leg', () => new THREE.MeshStandardMaterial({
    color: 0x3a3a3a, metalness: 0.4, roughness: 0.3,
  }));

  // Two sofa groups, left and right of lobby center
  for (const side of [-1, 1]) {
    const sx = side * (width / 4);
    const sz = 2; // center of lobby
    // Sofa seat
    group.add(makeBox(4, 0.4, 1.2, sofaMat, sx, 0.4, sz));
    // Sofa back
    group.add(makeBox(4, 0.5, 0.2, sofaMat, sx, 0.85, sz - 0.5));
    // Armrests
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx - 1.9, 0.75, sz));
    group.add(makeBox(0.2, 0.3, 1.2, sofaMat, sx + 1.9, 0.75, sz));
    // Legs
    for (const [lx, lz] of [[-1.8, -0.5], [1.8, -0.5], [-1.8, 0.5], [1.8, 0.5]]) {
      group.add(makeBox(0.06, 0.2, 0.06, sofaLegMat, sx + lx, 0.1, sz + lz));
    }
    // Coffee table in front
    const tableMat = getCachedMat('ctable', () => new THREE.MeshStandardMaterial({
      color: 0x3a2a18, roughness: 0.25, envMap, envMapIntensity: 0.3,
    }));
    group.add(makeBox(2, 0.05, 1, tableMat, sx, 0.45, sz + 1.2));
    group.add(makeBox(0.06, 0.4, 0.06, sofaLegMat, sx - 0.9, 0.2, sz + 0.8));
    group.add(makeBox(0.06, 0.4, 0.06, sofaLegMat, sx + 0.9, 0.2, sz + 0.8));
    group.add(makeBox(0.06, 0.4, 0.06, sofaLegMat, sx - 0.9, 0.2, sz + 1.6));
    group.add(makeBox(0.06, 0.4, 0.06, sofaLegMat, sx + 0.9, 0.2, sz + 1.6));
  }

  // === LOBBY RUG / CARPET (accent color) ===
  const rugMat = getCachedMat('rug_' + accentColor, () => new THREE.MeshStandardMaterial({
    color: accentColor, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
  }));
  group.add(makePlane(6, 12, rugMat, 0, 0.45, 3));

  // === POTTED PLANTS ===
  const potMat = getCachedMat('pot', () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7 }));
  const plantMat = getCachedMat('plant', () => new THREE.MeshStandardMaterial({ color: 0x2a7a2a, roughness: 0.8 }));
  for (const [px, pz] of [[-width / 3, -depth / 2 + 4], [width / 3, -depth / 2 + 4],
                           [-width / 4 - 3, depth / 2 - 3], [width / 4 + 3, depth / 2 - 3]]) {
    // Pot
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.25, 0.6, 6), potMat);
    pot.position.set(px, 0.3, pz);
    group.add(pot);
    // Plant sphere
    const plant = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 6), plantMat);
    plant.position.set(px, 1.0, pz);
    group.add(plant);
  }

  // === STAIRCASE (right side of lobby, goes to floor 2) ===
  const stairW = 3;
  const stairDepth = depth * 0.6;
  const stairX = width / 2 - stairW - 1; // against east wall
  const stairStartZ = -depth / 2 + 4;
  const stepCount = 16;
  const stepH = floorH / stepCount;
  const stepD = stairDepth / stepCount;

  const stairMat = getCachedMat('stair_marble', () => new THREE.MeshStandardMaterial({
    map: textures.lobbyFloor, roughness: 0.3, envMap, envMapIntensity: 0.2,
  }));
  const railMat = getCachedMat('railing', () => new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.6, roughness: 0.2,
  }));

  // Stairwell walls (enclose the staircase so it doesn't clip through rooms)
  const stairwellMat = getCachedMat('stairwell', () => new THREE.MeshStandardMaterial({
    map: textures.wall, color: 0xf0ebe0, roughness: 0.85,
  }));
  const swWallH = floorH * 2; // full double-height
  // West wall of stairwell (separates stairs from lobby)
  group.add(makeBox(0.15, swWallH, stairDepth + 2, stairwellMat,
    stairX - stairW / 2 - 0.1, swWallH / 2, stairStartZ + stairDepth / 2));
  // South wall of stairwell (closes off the top)
  group.add(makeBox(stairW + 0.5, swWallH, 0.15, stairwellMat,
    stairX, swWallH / 2, stairStartZ + stairDepth + 1));
  // North wall of stairwell (bottom, with opening for entry)
  const stairEntryH = 2.5;
  group.add(makeBox(stairW + 0.5, swWallH - stairEntryH, 0.15, stairwellMat,
    stairX, stairEntryH + (swWallH - stairEntryH) / 2, stairStartZ - 0.5));

  // Steps
  for (let s = 0; s < stepCount; s++) {
    const stepY = (s + 0.5) * stepH;
    const stepZ = stairStartZ + s * stepD;
    const step = makeBox(stairW, stepH, stepD, stairMat, stairX, stepY, stepZ);
    step.receiveShadow = true;
    group.add(step);
  }

  // Stair railing (inner/west side)
  const railLen = Math.sqrt(stairDepth * stairDepth + floorH * floorH);
  const railOuter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, railLen, 4), railMat
  );
  railOuter.position.set(stairX - stairW / 2 + 0.3, floorH / 2, stairStartZ + stairDepth / 2);
  railOuter.rotation.x = Math.atan2(floorH, stairDepth);
  group.add(railOuter);

  // Railing posts
  for (let s = 0; s <= stepCount; s += 4) {
    const postY = s * stepH;
    const postZ = stairStartZ + s * stepD;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 4), railMat);
    post.position.set(stairX - stairW / 2 + 0.3, postY + 0.5, postZ);
    group.add(post);
  }

  // === SECOND FLOOR with rooms ===
  createSecondFloor(group, width, depth, floorH, name);

  // === CHANDELIER (center of lobby) ===
  const chandelierMat = getCachedMat('chandelier', () => new THREE.MeshStandardMaterial({
    color: 0xddcc88, metalness: 0.6, roughness: 0.2,
  }));
  const chandelierGlow = new THREE.MeshStandardMaterial({
    color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 1.5,
  });
  // Main ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.06, 8, 16), chandelierMat);
  ring.position.set(0, floorH - 0.5, 0);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);
  // Support rod
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 4), chandelierMat);
  rod.position.set(0, floorH - 0.25, 0);
  group.add(rod);
  // Light bulbs around ring
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), chandelierGlow);
    bulb.position.set(Math.cos(angle) * 1.5, floorH - 0.5, Math.sin(angle) * 1.5);
    group.add(bulb);
  }

  // === HOTEL-SPECIFIC LOBBY FEATURES ===
  if (isFun) {
    // DFW: Split-level indicator – raised platform on west side (Upper Lobby)
    const upperMat = getCachedMat('upper_lobby', () => new THREE.MeshStandardMaterial({
      map: textures.lobbyFloor, roughness: 0.25, color: 0xd8d0c0,
    }));
    const upperW = width / 3;
    const upperH = 0.5; // 50cm raised
    group.add(makeBox(upperW, upperH, depth / 2 - 2, upperMat, -width / 2 + upperW / 2 + 1, upperH / 2 + 0.3, depth / 4));
    // Step up
    group.add(makeBox(upperW, 0.08, 0.6, getCachedMat('step_edge', () =>
      new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.3 })),
      -width / 2 + upperW / 2 + 1, 0.6, 0));

    // Library corner (bookshelf on upper level)
    const shelfMat = getCachedMat('bookshelf', () => new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.5 }));
    const bookMat = getCachedMat('books', () => new THREE.MeshStandardMaterial({ color: 0x8a4422, roughness: 0.8 }));
    const shelfX = -width / 2 + 2;
    group.add(makeBox(0.3, floorH - 1, 2.5, shelfMat, shelfX, floorH / 2, depth / 4 + 3));
    // Book rows
    for (let row = 0; row < 4; row++) {
      group.add(makeBox(0.25, 0.25, 2.3, bookMat, shelfX + 0.05, 1.2 + row * 0.9, depth / 4 + 3));
    }

    // Reading chair
    const chairMat = getCachedMat('readchair', () => new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 }));
    group.add(makeBox(0.8, 0.4, 0.8, chairMat, shelfX + 1.5, 0.8 + 0.2, depth / 4 + 3));
    group.add(makeBox(0.8, 0.5, 0.15, chairMat, shelfX + 1.5, 1.0 + 0.2, depth / 4 + 2.65));

    // LED strip along upper lobby edge (motion-sensor style)
    const ledFloor = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xeeeeff, emissiveIntensity: 0.4,
    });
    group.add(makeBox(upperW, 0.05, 0.1, ledFloor, -width / 2 + upperW / 2 + 1, 0.82, 0.1));

  } else if (isWater) {
    // DWW: Wave Bar area – curved bar counter near back wall
    const barMat = getCachedMat('bar_counter', () => new THREE.MeshStandardMaterial({
      color: 0x2a2a3a, roughness: 0.2, metalness: 0.1, envMap, envMapIntensity: 0.4,
    }));
    const barX = -width / 3;
    const barZ = depth / 2 - 4;
    // Bar counter (L-shape)
    group.add(makeBox(6, 1.1, 0.8, barMat, barX, 0.7, barZ));
    group.add(makeBox(0.8, 1.1, 3, barMat, barX + 3.4, 0.7, barZ - 1.5));
    // Bar top (polished)
    const barTopMat = getCachedMat('bartop', () => new THREE.MeshStandardMaterial({
      color: 0x1a1a2a, roughness: 0.08, metalness: 0.15, envMap, envMapIntensity: 0.5,
    }));
    group.add(makeBox(6.2, 0.06, 1.0, barTopMat, barX, 1.27, barZ));
    group.add(makeBox(1.0, 0.06, 3.2, barTopMat, barX + 3.4, 1.27, barZ - 1.5));

    // Bar stools (3)
    const stoolMat = getCachedMat('stool', () => new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.4 }));
    for (let i = 0; i < 3; i++) {
      const sx = barX - 2 + i * 2;
      // Pole
      group.add(makeBox(0.06, 0.7, 0.06, stoolMat, sx, 0.5, barZ + 0.8));
      // Seat
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.08, 6), stoolMat);
      seat.position.set(sx, 0.88, barZ + 0.8);
      group.add(seat);
    }

    // "Wave" decorative wall panel (wavy emissive blue strip on back wall)
    const waveMat = new THREE.MeshStandardMaterial({
      color: 0x1155aa, emissive: 0x1155aa, emissiveIntensity: 0.4,
    });
    for (let i = 0; i < 8; i++) {
      const wx = -width / 3 + i * (width / 12);
      const wy = 2.5 + Math.sin(i * 0.8) * 0.4;
      group.add(makeBox(width / 14, 0.15, 0.05, waveMat, wx, wy, depth / 2 - 0.35));
    }
  }

  // === INTERIOR LIGHTING: Multiple PointLights + Emissive Panels ===
  // Simple, fast, looks good: 4 PointLights spread across lobby + emissive deco

  // Ceiling light panels (emissive visual)
  const ceilPanelMat = getCachedMat('ceil_panel', () => new THREE.MeshStandardMaterial({
    color: 0xfff8f0, emissive: 0xfff5e8, emissiveIntensity: 1.5, roughness: 0.2,
    side: THREE.DoubleSide,
  }));

  // 3 PointLights spread across lobby + emissive panel above each
  const lightGrid = [
    { x: 0, z: -depth / 4, int: 2.5 },      // front (near entrance)
    { x: -width / 4, z: 0, int: 2.0 },       // center-left
    { x:  width / 4, z: depth / 4, int: 1.8 }, // back-right
  ];
  for (const lg of lightGrid) {
    // PointLight as pendant lamp (1.5m below ceiling for proper light distribution)
    const pl = new THREE.PointLight(0xfff0dd, lg.int * 5, 45);
    pl.position.set(lg.x, floorH - 1.5, lg.z);
    pl._dayIntensity = lg.int * 5;
    group.add(pl);
    lobbyLights.push(pl);
    // Emissive ceiling panel (stays at ceiling)
    group.add(makeBox(3.5, 0.06, 1.2, ceilPanelMat, lg.x, floorH - 0.08, lg.z));
    // Pendant rod connecting panel to light
    group.add(makeBox(0.03, 1.4, 0.03, getCachedMat('pendant_rod', () =>
      new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.5 })),
      lg.x, floorH - 0.75, lg.z));
  }

  // Extra emissive panels between lights (visual only, no PointLight)
  for (let r = 0; r < 2; r++) {
    const pz = -depth / 4 + r * depth / 2;
    group.add(makeBox(3.5, 0.06, 1.2, ceilPanelMat, 0, floorH - 0.08, pz));
  }

  // Wall sconces (emissive visual)
  const sconceMat = getCachedMat('sconce', () => new THREE.MeshStandardMaterial({
    color: 0xffe8c8, emissive: 0xffd8a0, emissiveIntensity: 1.5, roughness: 0.3,
  }));
  const sconceBackMat = getCachedMat('sconce_back', () =>
    new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.3, roughness: 0.4 }));
  for (const side of [-1, 1]) {
    for (const zOff of [-depth / 4, depth / 4]) {
      const wx = side * (width / 2 - 0.55);
      group.add(makeBox(0.06, 0.5, 1.0, sconceMat, wx, 2.8, zOff));
      group.add(makeBox(0.04, 0.7, 1.2, sconceBackMat, wx, 2.8, zOff));
    }
  }
}

// ---------------------------------------------------------------------------
// Second floor – hallway with hotel rooms, beds, bathroom
// ---------------------------------------------------------------------------
function createSecondFloor(group, width, depth, floorH, name) {
  const y = floorH; // floor level of 2nd story
  const isWater = name.includes('Water');

  // === FLOOR SLAB (southern half, with stairwell opening) ===
  const floorMat = getCachedMat('floor2', () => new THREE.MeshStandardMaterial({
    map: textures.lobbyFloor, roughness: 0.3,
  }));
  const floor2Z = depth / 4;
  const floor2Depth = depth / 2 - 2;

  // Stairwell opening dimensions (must match staircase in lobby)
  const stairW2 = 3;
  const stairX2 = width / 2 - stairW2 - 1;
  const stairOpenZ = -depth / 2 + 4; // where stairs start
  const stairOpenDepth = depth * 0.6 + 2; // stair depth + margin

  // Floor slab LEFT of stairwell (main area)
  const leftW = stairX2 - stairW2 / 2 - 1 + width / 2;
  if (leftW > 1) {
    const leftX = -width / 2 + 1 + leftW / 2;
    const fb1 = makeBox(leftW, 0.3, floor2Depth, floorMat, leftX, y, floor2Z);
    fb1.receiveShadow = true;
    group.add(fb1);
  }

  // Floor slab behind stairwell (south of stair opening)
  const behindZ = stairOpenZ + stairOpenDepth;
  const behindDepth = floor2Z + floor2Depth / 2 - behindZ;
  if (behindDepth > 1) {
    const fb2 = makeBox(width - 2, 0.3, behindDepth, floorMat, 0, y, behindZ + behindDepth / 2);
    fb2.receiveShadow = true;
    group.add(fb2);
  }

  // Small strip to the right of stairwell (between stair and east wall)
  const rightStripW = width / 2 - 1 - (stairX2 + stairW2 / 2 + 0.5);
  if (rightStripW > 0.5) {
    const rightX = stairX2 + stairW2 / 2 + 0.5 + rightStripW / 2;
    const fb3 = makeBox(rightStripW, 0.3, floor2Depth, floorMat, rightX, y, floor2Z);
    fb3.receiveShadow = true;
    group.add(fb3);
  }

  // Ceiling of 2nd floor
  const ceilMat = getCachedMat('ceiling', () => new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.9, side: THREE.DoubleSide }));
  const ceil2 = new THREE.Mesh(new THREE.PlaneGeometry(width - 2, floor2Depth), ceilMat);
  ceil2.rotation.x = Math.PI / 2;
  ceil2.position.set(0, y + floorH - 0.1, floor2Z);
  group.add(ceil2);

  // === HALLWAY (runs east-west along the center) ===
  const hallW = width - 4;
  const hallD = 3; // 3m wide corridor
  const hallZ = floor2Z - floor2Depth / 2 + hallD / 2 + 1; // near north edge of 2nd floor

  // Carpet runner in hallway
  const carpetMat = getCachedMat('carpet2', () => new THREE.MeshStandardMaterial({
    color: isWater ? 0x1a3a5a : 0x5a1a2a, roughness: 0.95,
    polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
  }));
  group.add(makePlane(hallW - 2, hallD - 0.5, carpetMat, 0, y + 0.25, hallZ));

  // Hallway ceiling light panels (emissive, no PointLight needed)
  const hallPanelMat = getCachedMat('ceil_panel', () => new THREE.MeshStandardMaterial({
    color: 0xfff8f0, emissive: 0xfff5e8, emissiveIntensity: 1.8, roughness: 0.3,
    side: THREE.DoubleSide,
  }));
  for (let hx = -hallW / 3; hx <= hallW / 3; hx += hallW / 3) {
    group.add(makeBox(3, 0.05, 1.2, hallPanelMat, hx, y + floorH - 0.12, hallZ));
  }
  // Single PointLight for depth
  const hl = new THREE.PointLight(0xfff5e0, 5.0, 25);
  hl.position.set(0, y + floorH - 1.5, hallZ);
  hl._dayIntensity = 5.0;
  lobbyLights.push(hl);
  group.add(hl);

  // === ROOMS (4 rooms along the south side, doors opening to hallway) ===
  const roomCount = 3; // reduced from 4 for performance
  const roomW = (hallW - 2) / roomCount;
  const roomD = floor2Depth - hallD - 2;
  const roomZ = hallZ + hallD / 2 + roomD / 2 + 0.5; // south of hallway

  const wallRoomMat = getCachedMat('wall_room', () => new THREE.MeshStandardMaterial({
    map: textures.damask, color: 0xf5f0e5, roughness: 0.8,
  }));
  const doorFrameMat = getCachedMat('doorframe', () => new THREE.MeshStandardMaterial({
    color: 0x4a3a2a, roughness: 0.4,
  }));

  for (let r = 0; r < roomCount; r++) {
    const rx = -hallW / 2 + 1 + r * roomW + roomW / 2;
    const doorW = 1.2;
    const doorH = 2.2;
    const wallH = floorH - 0.5;

    // North wall of room (facing hallway) with door opening
    const nwSegW = (roomW - doorW) / 2 - 0.1;
    // Left of door
    group.add(makeBox(nwSegW, wallH, 0.15, wallRoomMat, rx - roomW / 2 + nwSegW / 2 + 0.05, y + wallH / 2, hallZ + hallD / 2));
    // Right of door
    group.add(makeBox(nwSegW, wallH, 0.15, wallRoomMat, rx + roomW / 2 - nwSegW / 2 - 0.05, y + wallH / 2, hallZ + hallD / 2));
    // Above door
    group.add(makeBox(doorW + 0.2, wallH - doorH, 0.15, wallRoomMat, rx, y + doorH + (wallH - doorH) / 2, hallZ + hallD / 2));
    // Door frame
    group.add(makeBox(0.08, doorH, 0.2, doorFrameMat, rx - doorW / 2, y + doorH / 2, hallZ + hallD / 2));
    group.add(makeBox(0.08, doorH, 0.2, doorFrameMat, rx + doorW / 2, y + doorH / 2, hallZ + hallD / 2));

    // Side walls between rooms (except at room edges which use building walls)
    if (r < roomCount - 1) {
      group.add(makeBox(0.15, wallH, roomD, wallRoomMat, rx + roomW / 2, y + wallH / 2, roomZ));
    }

    // === ROOM FURNITURE ===

    // Room floor (laminate, warmer than hallway tile)
    const laminateMat = getCachedMat('laminate', () => new THREE.MeshStandardMaterial({
      color: 0xc8a882, roughness: 0.45, // warm wood-tone laminate
      polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
    }));
    group.add(makePlane(roomW - 0.5, roomD - 0.3, laminateMat, rx, y + 0.22, roomZ));

    // Bed (double bed)
    const bedMat = getCachedMat('bedsheet', () => new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.9 }));
    const bedFrameMat = getCachedMat('bedframe', () => new THREE.MeshStandardMaterial({ map: textures.woodOak, roughness: 0.4 }));
    // Frame
    group.add(makeBox(2.2, 0.35, 2.0, bedFrameMat, rx, y + 0.32, roomZ + roomD / 2 - 1.5));
    // Mattress
    group.add(makeBox(2.0, 0.2, 1.8, bedMat, rx, y + 0.55, roomZ + roomD / 2 - 1.5));
    // Pillow (single wide)
    group.add(makeBox(1.2, 0.12, 0.35, bedMat, rx, y + 0.72, roomZ + roomD / 2 - 2.2));
    // Headboard
    group.add(makeBox(2.2, 0.8, 0.1, bedFrameMat, rx, y + 0.85, roomZ + roomD / 2 - 2.35));

    // Nightstand (one side)
    const nightMat = getCachedMat('nightstand', () => new THREE.MeshStandardMaterial({ map: textures.woodWalnut, roughness: 0.35 }));
    group.add(makeBox(0.5, 0.5, 0.4, nightMat, rx + 1.4, y + 0.4, roomZ + roomD / 2 - 2.0));
    // Lamp on nightstand
    const lampGlow = getCachedMat('roomlamp', () => new THREE.MeshStandardMaterial({
      color: 0xffeecc, emissive: 0xffddaa, emissiveIntensity: 0.6,
    }));
    group.add(makeBox(0.15, 0.3, 0.15, lampGlow, rx + 1.4, y + 0.8, roomZ + roomD / 2 - 2.0));

    // Window (south wall – opening to outside, glass pane)
    const glassMat = getGlassMat();
    group.add(makeBox(1.5, 1.2, 0.08, glassMat, rx, y + 1.5, roomZ + roomD / 2 - 0.1));

    // Room ceiling light panel (larger emissive area for better illumination)
    const ceilLampMat = getCachedMat('ceillamp', () => new THREE.MeshStandardMaterial({
      color: 0xfff8f0, emissive: 0xfff0dd, emissiveIntensity: 1.5,
      side: THREE.DoubleSide,
    }));
    group.add(makeBox(1.5, 0.04, 1.5, ceilLampMat, rx, y + floorH - 0.15, roomZ));
    // Bounce glow on floor
    const roomBounceMat = getCachedMat('bounce_floor', () => new THREE.MeshStandardMaterial({
      color: 0xfff0dd, emissive: 0xeee0c8, emissiveIntensity: 0.3, roughness: 0.9,
      transparent: true, opacity: 0.3,
      polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -14,
    }));
    group.add(makePlane(2.5, 2.5, roomBounceMat, rx, y + 0.28, roomZ));

    // === BATHROOM (only in room 0 and room 2) ===
    if (r === 0) { // only 1 bathroom (performance)
      const bathX = rx - roomW / 2 + 1.5;
      const bathZ = roomZ - roomD / 2 + 1.5;
      const bathW = 2.5;
      const bathD = 2.5;

      // Bathroom partition wall
      group.add(makeBox(0.12, wallH, bathD, wallRoomMat, bathX + bathW / 2, y + wallH / 2, bathZ));
      // Bathroom door opening (just leave gap, no wall on hall side)

      // Toilet
      const toiletMat = getCachedMat('toilet', () => new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.3 }));
      // Bowl
      group.add(makeBox(0.45, 0.4, 0.55, toiletMat, bathX - 0.5, y + 0.2, bathZ - 0.5));
      // Tank
      group.add(makeBox(0.4, 0.5, 0.2, toiletMat, bathX - 0.5, y + 0.35, bathZ - 0.85));
      // Seat
      group.add(makeBox(0.42, 0.04, 0.4, toiletMat, bathX - 0.5, y + 0.42, bathZ - 0.45));

      // Sink
      group.add(makeBox(0.6, 0.1, 0.45, toiletMat, bathX + 0.5, y + 0.8, bathZ - 0.8));
      // Sink pedestal
      group.add(makeBox(0.15, 0.8, 0.15, toiletMat, bathX + 0.5, y + 0.4, bathZ - 0.8));
      // Mirror above sink
      const mirrorMat = getCachedMat('mirror', () => new THREE.MeshStandardMaterial({
        color: 0xaabbcc, roughness: 0.02, metalness: 0.8, envMap, envMapIntensity: 1.0,
      }));
      group.add(makeBox(0.6, 0.8, 0.04, mirrorMat, bathX + 0.5, y + 1.6, bathZ - 0.97));

      // Bathroom floor tile (different from main floor)
      const bathFloorMat = getCachedMat('bathfloor', () => new THREE.MeshStandardMaterial({
        color: 0xd8d0c8, roughness: 0.25,
        polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12,
      }));
      group.add(makePlane(bathW, bathD, bathFloorMat, bathX, y + 0.24, bathZ));
    }
  }

  // Hallway back wall (south end, above the rooms)
  group.add(makeBox(hallW, floorH - 0.5, 0.15, wallRoomMat, 0, y + floorH / 2 - 0.1, floor2Z + floor2Depth / 2 - 0.1));
}

// Register stair floors after building is placed in scene
function registerStairFloors(x, z, width, depth, floorH) {
  // New staircase: east side, 20 steps per flight, 2 flights (EG→1OG, 1OG→2OG)
  const stairW = 3.5;
  const stairD = 10;
  const stairX = x + width / 2 - 4;
  const stairStartZ = z - depth / 2 + 4;

  for (let flight = 0; flight < 2; flight++) {
    const baseY = flight * floorH;
    const stepsPerFlight = 20;
    const stepH = floorH / stepsPerFlight;
    const stepD = stairD / stepsPerFlight;

    // Register every 2nd step (performance)
    for (let s = 0; s < stepsPerFlight; s += 2) {
      addFloor(stairX, stairStartZ + s * stepD, stairW + 0.5, stepD * 2 + 0.3, baseY + (s + 2) * stepH);
    }

    // Landing at top of flight
    addFloor(stairX, stairStartZ + stairD + 0.5, stairW + 2, 3, (flight + 1) * floorH);
  }

  // Floor slabs for 1.OG and 2.OG (full width except stairwell)
  for (let fl = 1; fl <= 2; fl++) {
    addFloor(x, z, width - 8, depth - 4, fl * floorH);
  }
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

      // South front (pool-facing) – sine wave
      const m1 = makeWaveTube(mat, sy, depth / 2 + 0.35, wavePhase);
      meshArr.push(m1);
      group.add(m1);
      // North front (street-facing) – mirrored sine wave
      const m2 = makeWaveTube(mat, sy, -(depth / 2 + 0.35), wavePhase + Math.PI);
      meshArr.push(m2);
      group.add(m2);
    }

    // Roofline in blue (wave-shaped too)
    for (const fz of [depth / 2 + 0.35, -(depth / 2 + 0.35)]) {
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
let poolNormalsTex = null;
function getPoolNormals() {
  if (poolNormalsTex) return poolNormalsTex;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  // Multi-octave fine ripple normals for pool water
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size, v = y / size;

      // 4 overlapping octaves – small, fine ripples like a real pool
      let nx = 0, ny = 0;
      // Octave 1: gentle large swell
      nx += Math.sin(u * 6.28 * 2 + v * 3.0) * 0.12;
      ny += Math.cos(v * 6.28 * 2 + u * 2.5) * 0.12;
      // Octave 2: medium ripples
      nx += Math.sin(u * 6.28 * 5 + v * 6.28 * 3) * 0.08;
      ny += Math.cos(v * 6.28 * 5 - u * 6.28 * 2) * 0.08;
      // Octave 3: fine ripples
      nx += Math.sin(u * 6.28 * 11 + v * 6.28 * 7) * 0.05;
      ny += Math.cos(v * 6.28 * 9 + u * 6.28 * 13) * 0.05;
      // Octave 4: micro detail
      nx += Math.sin(u * 6.28 * 23 - v * 6.28 * 17) * 0.025;
      ny += Math.cos(v * 6.28 * 19 + u * 6.28 * 21) * 0.025;

      d[i]     = Math.floor(Math.min(255, Math.max(0, nx * 512 + 128)));
      d[i + 1] = Math.floor(Math.min(255, Math.max(0, ny * 512 + 128)));
      d[i + 2] = 220; // z slightly less than 255 to catch more light angles
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  poolNormalsTex = new THREE.CanvasTexture(canvas);
  poolNormalsTex.wrapS = THREE.RepeatWrapping;
  poolNormalsTex.wrapT = THREE.RepeatWrapping;
  return poolNormalsTex;
}

let poolWaterCount = 0;
const MAX_REFLECTIVE_POOLS = 0; // All pools use env-map reflection (no planar reflection)

function createPool(scene, x, z, w, d) {
  const isLarge = (w * d > 800) && poolWaterCount < MAX_REFLECTIVE_POOLS;

  if (isLarge) {
    poolWaterCount++;
    const waterSurface = new Water(new THREE.PlaneGeometry(w, d), {
      textureWidth: 256, textureHeight: 256,
      waterNormals: getPoolNormals(),
      sunDirection: new THREE.Vector3(100, 120, 80).normalize(),
      sunColor: 0xffffff,
      waterColor: 0x006994,
      distortionScale: 1.2,  // more wave distortion for realistic reflections
      fog: false, alpha: 0.92,
    });
    waterSurface.material.uniforms['size'].value = 0.15; // finer micro-waves
    waterSurface.rotation.x = -Math.PI / 2;
    waterSurface.position.set(x, 0.35, z);
    scene.add(waterSurface);
    waterMeshes.push(waterSurface);
    registerSpatial(waterSurface);
  } else {
    // All other pools: nice-looking env-mapped material (no planar reflection)
    const poolMat = getCachedMat('pool_envmap', () => new THREE.MeshStandardMaterial({
      color: 0x1a99b5, roughness: 0.05, metalness: 0.15,
      transparent: true, opacity: 0.88,
      envMap, envMapIntensity: 1.0,
    }));
    const waterMesh = makePlane(w, d, poolMat, x, 0.35, z);
    scene.add(waterMesh);
    registerSpatial(waterMesh);
  }

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

  // No full-block collider – player can walk in and climb stairs!
  // Only platform railing colliders at the top edges
  // Platform railing colliders – only block at platform height, not at ground
  addCollider(x + 4, z, 0.3, 8, height + 1.2);
  addCollider(x - 4, z, 0.3, 8, height + 1.2);
  addCollider(x, z + 4, 8, 0.3, height + 1.2);
  addCollider(x, z - 4, 8, 0.3, height + 1.2);

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
  group.add(makeBox(0.7, 0.05, 1.8, mat, 0, 0.4, 0));
  const back = makeBox(0.7, 0.05, 0.6, mat, 0, 0.6, -0.7);
  back.rotation.x = -0.5;
  group.add(back);
  // 2 legs instead of 4
  group.add(makeBox(0.04, 0.4, 0.04, frameMat, -0.3, 0.2, 0));
  group.add(makeBox(0.04, 0.4, 0.04, frameMat, 0.3, 0.2, 0));
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
  group.position.set(x, 0, z);
  group.rotation.y = rotation;

  // === MEGA STAGE DIMENSIONS ===
  const stageW = isLarge ? 32 : 18;
  const stageD = isLarge ? 14 : 10;
  const stageH = isLarge ? 1.8 : 1.4;
  const canopyH = isLarge ? 10 : 7;
  const tiers = isLarge ? 9 : 5;

  // === STAGE PLATFORM (glossy black) ===
  const stageMat = getCachedMat('stage_black', () => new THREE.MeshPhysicalMaterial({
    color: 0x1a1a1a, roughness: 0.15, metalness: 0.1,
    clearcoat: 0.8, clearcoatRoughness: 0.1,
    envMap, envMapIntensity: 0.6,
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

  // LED screen on backdrop (huge emissive panel – like a video screen)
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x2244aa, emissive: 0x2244aa, emissiveIntensity: 1.2, roughness: 0.05,
  });
  const screenW = stageW - 3;
  const screenH = backdropH - 1.5;
  group.add(makeBox(screenW, screenH, 0.1, screenMat, 0, stageH + backdropH / 2 + 0.3, -stageD / 2 + 0.45));
  ledStrips.push({ meshes: [group.children[group.children.length - 1]], mat: screenMat,
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

  // === SEATING TIERS (more rows, wider) ===
  const seatMat = makePBR('seats', { color: 0x6a5a4a, roughness: 0.8 });
  const tierSpacing = isLarge ? 2.2 : 2.5;
  const firstR = isLarge ? 16 : 11;
  for (let tier = 0; tier < tiers; tier++) {
    const innerR = firstR + tier * tierSpacing;
    const outerR = innerR + (isLarge ? 1.8 : 2.0);
    const tierMesh = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, 24, 1, 0, Math.PI), seatMat);
    tierMesh.rotation.x = -Math.PI / 2;
    tierMesh.position.set(0, 0.3 + tier * 0.5, stageD / 2 + 2 + tier * tierSpacing);
    tierMesh.receiveShadow = true;
    group.add(tierMesh);

    // Chairs on this tier (InstancedMesh)
    const chairsPerTier = Math.floor((outerR - innerR) > 1.5 ? (innerR * Math.PI) / 1.2 : 4);
    const chairGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const chairInstMat = getCachedMat('stage_chair', () => new THREE.MeshStandardMaterial({
      color: 0x4a3a2a, roughness: 0.7,
    }));
    const chairs = new THREE.InstancedMesh(chairGeo, chairInstMat, chairsPerTier);
    const dummy = new THREE.Object3D();
    for (let ci = 0; ci < chairsPerTier; ci++) {
      const angle = (ci / chairsPerTier) * Math.PI; // semicircle
      const r = (innerR + outerR) / 2;
      dummy.position.set(
        Math.cos(angle) * r,
        0.3 + tier * 0.5 + 0.3,
        stageD / 2 + 2 + tier * tierSpacing + Math.sin(angle) * r * 0.05
      );
      dummy.rotation.y = angle + Math.PI / 2;
      dummy.updateMatrix();
      chairs.setMatrixAt(ci, dummy.matrix);
    }
    chairs.instanceMatrix.needsUpdate = true;
    group.add(chairs);
  }

  scene.add(group);
  registerSpatial(group);
  // Stage: jumpable collider + walkable floor on top
  addCollider(x, z, stageW, stageD, stageH);
  addFloor(x, z, stageW + 2, stageD + 2, stageH);
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

  // Hills ONLY on the north side of the road (z < -90)
  // South side (hotels, pools, beach) is completely flat
  if (z > -90) return 0;

  // Smooth transition from flat (z=-90) to hilly (z=-120)
  const hillFade = smoothClamp((-90 - z) / 30);

  // Rolling hills using FBM noise
  const hillHeight = terrainFbm(x * 0.003, z * 0.003, 4) * 45
                   + terrainFbm(x * 0.01, z * 0.01, 3) * 15
                   + terrainFbm(x * 0.025, z * 0.025, 2) * 5;

  // Mountains rise further north
  const northBoost = z < -150 ? smoothClamp((-150 - z) / 100) * 50 : 0;

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
  // DWW Boutique: to the RIGHT side of DWW Main (not blocking entrance)
  createHotelBuilding(scene, dwwX + 50, dwwZ - 30, 25, 16, 2, 'DWW Boutique Water', '#f5ede0', 0.8);
  registerStairFloors(dwwX + 50, dwwZ - 30, 25, 16, 6.0);

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
  // DFW Boutique: to the LEFT side of DFW Main (not blocking entrance)
  createHotelBuilding(scene, dfwX - 50, dfwZ - 30, 25, 16, 2, 'DFW Boutique Fun', '#f0e8d8', 2.0);
  registerStairFloors(dfwX - 50, dfwZ - 30, 25, 16, 6.0);

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

    const speed = MOVE_SPEED * (this.keys.run ? RUN_MULTIPLIER : 1) * dt;
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

    const nx = this.camera.position.x + move.x, nz = this.camera.position.z + move.z;
    const py = this.camera.position.y;
    if (!checkCollision(nx, this.camera.position.z, py)) this.camera.position.x = nx;
    if (!checkCollision(this.camera.position.x, nz, py)) this.camera.position.z = nz;

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
    for (const ll of lobbyLights) ll.intensity = ll._dayIntensity * 10;
    document.getElementById('btnDay').classList.add('active');
    document.getElementById('btnNight').classList.remove('active');
    // Regenerate envmap with day sky (delayed so shader updates first)
    setTimeout(refreshEnvMap, 100);
  }
  function setNightMode() {
    isNightMode = true;
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
    for (const ll of lobbyLights) ll.intensity = ll._dayIntensity * 10;
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

  // Water animation – update time for all, but stagger reflection updates
  for (let i = 0; i < waterMeshes.length; i++) {
    const w = waterMeshes[i];
    const isSea = (i === waterMeshes.length - 1);
    w.material.uniforms['time'].value += dt * (isSea ? 0.6 : 0.15);
  }

  // Auto-doors (check every 3rd frame for performance)
  if (frameCount % 3 === 0) {
    updateAutoDoors(camera.position.x, camera.position.z, dt * 3);
  }

  // Lift physics (every frame for smooth movement)
  updateLifts(camera, dt);

  // Floor culling: only render the floor the player is on (+ adjacent for stairs)
  if (frameCount % 5 === 0) {
    const py = camera.position.y;
    const px = camera.position.x;
    const pz = camera.position.z;
    for (const fg of floorGroups) {
      // Check if player is in this building
      const inBuilding = Math.abs(px - fg.buildingX) < 60 && Math.abs(pz - fg.buildingZ) < 20;
      if (!inBuilding) {
        fg.group.visible = false;
        continue;
      }
      // Show current floor + adjacent (for stairs/lift transition)
      const playerFloor = Math.max(0, Math.floor((py - PLAYER_HEIGHT + 1) / 6));
      const floorDist = Math.abs(fg.floorNum - playerFloor);
      fg.group.visible = floorDist <= 1; // current + 1 above/below
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
        // Rainbow hue cycle – saturated colors, never white
        const hue = (elapsedTime * 0.12 + strip.phase) % 1.0;
        _tmpColor.setHSL(hue, 1.0, 0.45); // lightness 0.45 = vivid colors, never white
        const intensity = 63.0 + Math.sin(elapsedTime * 3.0 + strip.phase * 4) * 26.0;
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
  if (skyMesh) {
    skyMesh.position.x = camera.position.x;
    skyMesh.position.y = 0;
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
