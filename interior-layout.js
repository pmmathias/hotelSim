// =============================================================================
// HOTEL INTERIOR LAYOUT DEFINITIONS
// =============================================================================
// All measurements in meters, relative to building center (0,0)
// Building: 115m wide (x), 35m deep (z), 6m per floor
// North wall = -depth/2 = -17.5 (street entrance)
// South wall = +depth/2 = +17.5 (pool exit)
// West wall = -width/2 = -57.5
// East wall = +width/2 = +57.5
// =============================================================================

export const BUILDING = {
  width: 115,
  depth: 35,
  floorH: 6,
  floors: 3,       // EG + 1.OG + 2.OG (interior), rest = exterior only
  wallT: 0.5,      // wall thickness
  entranceW: 10,   // entrance opening width
};

const W = BUILDING.width;
const D = BUILDING.depth;
const H = BUILDING.floorH;
const T = BUILDING.wallT;

// =============================================================================
// ERDGESCHOSS (y=0..6)
// =============================================================================
// Layout (looking from above, North = top):
//
//  NORTH WALL (street entrance in center)
//  +-----+-------------------+----------+--------+
//  |LIFT | L O B B Y        |REZEPTION |TREPPE  |
//  | 4x4 | Kronleuchter     | 10x8     | 4x12   |
//  |     | Sofas, Teppich   | Tresen   |        |
//  +-----+                  +----------+        |
//  |     |                  |          |        |
//  | WC  |  (open space)    |BAR/LOUNGE|        |
//  | 6x6 |                  | 10x8     |        |
//  +-----+------------------+----------+--------+
//  |                                             |
//  |  R E S T A U R A N T                       |
//  |  Buffet-Theke, Tische, Stühle              |
//  |  (full width, 12m deep)                    |
//  |                                             |
//  SOUTH WALL (pool exit in center)

export const GROUND_FLOOR = {
  // Lift shaft (northwest corner)
  lift: {
    x: -W/2 + 2 + 2,     // 4m from west wall, centered
    z: -D/2 + 2 + 2,     // 4m from north wall, centered
    w: 4, d: 4,
  },

  // Lobby (center-north area)
  lobby: {
    x: -10,               // slightly left of center
    z: -D/2 + 10,         // 10m from north wall
    w: 40, d: 16,
    furniture: {
      chandelier: { x: -10, z: -D/2 + 10, y: H - 1.5 },
      sofaLeft:   { x: -25, z: -D/2 + 12 },
      sofaRight:  { x: 5,   z: -D/2 + 12 },
      coffeeTable:{ x: -10, z: -D/2 + 12 },
      rug:        { x: -10, z: -D/2 + 10, w: 8, d: 12 },
      plants: [
        { x: -30, z: -D/2 + 4 },
        { x: 10,  z: -D/2 + 4 },
      ],
    },
  },

  // Reception (northeast area)
  reception: {
    x: W/2 - 15,           // east side
    z: -D/2 + 6,           // near north entrance
    w: 10, d: 8,
    desk: { x: W/2 - 15, z: -D/2 + 6, w: 8, d: 1.5, h: 1.1 },
    monitors: 3,
  },

  // Staircase (east side, full height)
  stairs: {
    x: W/2 - 4,            // against east wall
    z: -D/2 + 8,           // starts 8m from north wall
    w: 4, d: 12,
    stepCount: 20,
  },

  // Toilets (west side, south of lift)
  toilets: {
    x: -W/2 + 5,           // near west wall
    z: 0,                   // center z
    w: 6, d: 6,
    stalls: 3,              // 3 toilet stalls
    sinks: 2,
  },

  // Bar / Lounge (east side, south of reception)
  bar: {
    x: W/2 - 15,
    z: 2,                   // center-south area
    w: 10, d: 8,
    stools: 4,
  },

  // Restaurant (full width, south section)
  restaurant: {
    x: 0,
    z: D/2 - 6,            // south section
    w: W - 10,             // almost full width (minus walls)
    d: 12,
    tables: 8,              // 8 dining tables
    buffet: { x: 0, z: D/2 - 10, w: 15, d: 1.5 },
  },

  // Interior walls (partitions between rooms)
  walls: [
    // Lift room east wall
    { x: -W/2 + 6, z: -D/2 + 4, w: T, d: 8 },
    // Reception west wall
    { x: W/2 - 20, z: -D/2 + 6, w: T, d: 12 },
    // Toilet south wall
    { x: -W/2 + 5, z: 3, w: 6, d: T },
    // Toilet east wall
    { x: -W/2 + 8, z: 0, w: T, d: 6 },
    // Bar west wall
    { x: W/2 - 20, z: 2, w: T, d: 8 },
    // Restaurant north wall (partial, with openings)
    { x: -20, z: D/2 - 12, w: 30, d: T },
    { x: 30, z: D/2 - 12, w: 20, d: T },
  ],
};

// =============================================================================
// OBERE STOCKWERKE (1.OG: y=6..12, 2.OG: y=12..18)
// =============================================================================
// Layout:
//  +-----+--------+--------+--------+--------+--------+
//  |LIFT | FLUR   | FLUR   | FLUR   | FLUR   |TREPPE  |
//  |     |--------|--------|--------|--------|        |
//  |     | ZI. 1  | ZI. 2  | ZI. 3  | ZI. 4  |        |
//  |     | 12x10  | 12x10  | 12x10  | 12x10  |        |
//  |     |+Bad    |+Bad    |+Bad    |+Bad    |        |
//  +-----+--------+--------+--------+--------+--------+

export const UPPER_FLOOR = {
  // Same lift and staircase positions as EG
  lift: GROUND_FLOOR.lift,
  stairs: GROUND_FLOOR.stairs,

  // Hallway (runs east-west, north side)
  hallway: {
    x: 0,
    z: -D/2 + 5,          // 5m from north wall
    w: W - 12,            // full width minus lift+stairs
    d: 3,                  // 3m wide corridor
  },

  // 4 rooms along the south side
  rooms: (() => {
    const roomW = (W - 16) / 4;  // ~24.75m each (minus lift+stairs space)
    const roomD = D - 10;         // ~25m deep (from hallway to south wall)
    const roomStartX = -W/2 + 8;  // after lift shaft
    return [0, 1, 2, 3].map(i => ({
      index: i,
      x: roomStartX + i * roomW + roomW / 2,
      z: -D/2 + 5 + 3/2 + roomD / 2,  // south of hallway
      w: roomW - 1,        // 1m gap between rooms (wall)
      d: roomD,
      doorZ: -D/2 + 5 + 1.5, // door on hallway side
      bed: { dx: 0, dz: roomD/2 - 3 },
      nightstand: { dx: roomW/2 - 3, dz: roomD/2 - 3 },
      bathroom: {
        dx: -roomW/2 + 3.5,
        dz: -roomD/2 + 3,
        w: 4, d: 4,
        toilet: { dx: -1, dz: -1 },
        sink: { dx: 1, dz: -1.5 },
        mirror: { dx: 1, dz: -1.8 },
      },
      balconyZ: D/2, // south wall = balcony
    }));
  })(),
};

// =============================================================================
// DOOR DEFINITIONS (auto-open when player approaches)
// =============================================================================
export const DOORS = {
  // EG
  northEntrance: { x: 0, z: -D/2, w: BUILDING.entranceW, type: 'glass' },
  southEntrance: { x: 0, z: D/2, w: BUILDING.entranceW, type: 'glass' },
  toiletDoor:    { x: -W/2 + 8, z: -2, w: 1.2, type: 'wood' },
  restaurantL:   { x: -5, z: D/2 - 12, w: 3, type: 'open' },
  restaurantR:   { x: 20, z: D/2 - 12, w: 3, type: 'open' },
  // Per floor (repeated for 1.OG and 2.OG)
  roomDoors: [0, 1, 2, 3].map(i => ({ roomIndex: i, w: 1.2, type: 'wood' })),
  liftDoor: { w: 2, type: 'metal' },
};
