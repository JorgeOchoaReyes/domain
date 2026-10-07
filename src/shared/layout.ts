/**
 * The office's floor plan, shared by the server (where desks are) and the
 * client (what it draws and where you can walk). Units are meters, +y is up,
 * and a facing of 0 looks down +z.
 *
 * The plan follows a classic open office: two clusters of back-to-back desk
 * pods on the west side, wall boards along the north wall with the elevator,
 * a lounge round the TV on the east wall (where workers present at office
 * hours), and a glass meeting room with a loft over it in the south-east
 * corner, reached by stairs along the south wall.
 */

export const FLOOR = { minX: -18, maxX: 18, minZ: -13, maxZ: 13 } as const;
export const WALL_HEIGHT = 6.4;
export const WALL_T = 0.3;

export interface DeskDef {
  id: string;
  label: string;
  x: number;
  z: number;
  /** Rotation around Y. At 0 the worker sits on the desk's +z side, facing -z. */
  rotY: number;
}

export const DESK_SIZE = { width: 2.2, depth: 1.1, height: 0.78 } as const;

/** The desk clusters' centers along x; each is two pods of back-to-back rows. */
export const CLUSTER_X = [-10.5, -1.5] as const;
const PODS = [
  { back: -4.55, front: -3.45 },
  { back: 3.45, front: 4.55 },
];

function buildDesks(): DeskDef[] {
  const desks: DeskDef[] = [];
  let n = 1;
  for (const pod of PODS) {
    for (const cx of CLUSTER_X) {
      for (const [z, rotY] of [
        [pod.back, Math.PI],
        [pod.front, 0],
      ] as const) {
        for (const dx of [-DESK_SIZE.width / 2, DESK_SIZE.width / 2]) {
          desks.push({ id: `desk-${n}`, label: `Desk ${n}`, x: cx + dx, z, rotY });
          n++;
        }
      }
    }
  }
  return desks;
}

/**
 * The intern bay: eight more desks along the north of the work floor (two
 * pairs of back-to-back rows), for interns your workers bring in — and for a
 * bigger team. Its walkway runs east just south of it.
 */
export const BAY = { x: [-11.5, -2.5], back: -10.3, front: -9.2, lane: -7.4 } as const;
export const FIRST_BAY_DESK = 17;

function buildBay(): DeskDef[] {
  const desks: DeskDef[] = [];
  let n = FIRST_BAY_DESK;
  for (const cx of BAY.x) {
    for (const [z, rotY] of [
      [BAY.back, Math.PI],
      [BAY.front, 0],
    ] as const) {
      for (const dx of [-DESK_SIZE.width / 2, DESK_SIZE.width / 2]) {
        desks.push({ id: `desk-${n}`, label: `Bay ${n - FIRST_BAY_DESK + 1}`, x: cx + dx, z, rotY });
        n++;
      }
    }
  }
  return desks;
}

/**
 * Floor 3, the team floor: four pods of four desks (back-to-back pairs),
 * room for a bigger team — or a pod each when people share the office. It's
 * built further east, like floor 2, up the elevator.
 */
export const TEAM_FLOOR = { minX: 102, maxX: 138, minZ: -14, maxZ: 14 } as const;
/** Its elevator doors in the north wall, and where it lets you out. */
export const TEAM_ELEVATOR = { x: 120, width: 2.6 } as const;
export const TEAM_ARRIVE = { x: 120, z: TEAM_FLOOR.minZ + 2.6, facing: 0 } as const;
/** The aisle across the floor between the pods (and the corridor down from the elevator). */
export const TEAM_AISLE_Z = 1.5;
/** The pods: their centers and names. */
export const TEAM_PODS = [
  { name: "A", x: 109, z: -5 },
  { name: "B", x: 131, z: -5 },
  { name: "C", x: 109, z: 8 },
  { name: "D", x: 131, z: 8 },
] as const;
export const FIRST_TEAM_DESK = 25;

function buildTeamDesks(): DeskDef[] {
  const desks: DeskDef[] = [];
  let n = FIRST_TEAM_DESK;
  for (const pod of TEAM_PODS) {
    let i = 1;
    for (const [z, rotY] of [
      [pod.z - DESK_SIZE.depth / 2, Math.PI],
      [pod.z + DESK_SIZE.depth / 2, 0],
    ] as const) {
      for (const dx of [-DESK_SIZE.width / 2, DESK_SIZE.width / 2]) {
        desks.push({ id: `desk-${n}`, label: `Pod ${pod.name}${i}`, x: pod.x + dx, z, rotY });
        n++;
        i++;
      }
    }
  }
  return desks;
}

export const DESKS: DeskDef[] = [...buildDesks(), ...buildBay(), ...buildTeamDesks()];
/** The bay's desks (where interns sit). */
export const BAY_DESK_IDS: readonly string[] = DESKS.filter((d) => Number(d.id.slice(5)) >= FIRST_BAY_DESK && Number(d.id.slice(5)) < FIRST_TEAM_DESK).map((d) => d.id);
/** The team floor's desks. */
export const TEAM_DESK_IDS: readonly string[] = DESKS.filter((d) => Number(d.id.slice(5)) >= FIRST_TEAM_DESK).map((d) => d.id);
export const DESK_BY_ID = new Map(DESKS.map((d) => [d.id, d]));

/** Where a desk's worker (and a player using the desk) stands or sits. */
export function deskSeat(desk: { x: number; z: number; rotY: number }, offset = 0.9): { x: number; z: number } {
  return {
    x: desk.x + Math.sin(desk.rotY) * offset,
    z: desk.z + Math.cos(desk.rotY) * offset,
  };
}

/** Where you arrive: out on the open floor by the elevator, facing the desks. */
export const SPAWN = { x: 5.6, z: -2.6, facing: -Math.PI / 2 } as const;

/** The elevator shaft against the north wall, its doors facing into the room. */
export const ELEVATOR = { x: 8.5, width: 2.6, depth: 2.4 } as const;

/** The gong beside the elevator. */
export const GONG = { x: 11.8, z: FLOOR.minZ + 0.75 } as const;

/** Boards along the north wall; each faces into the room (+z). */
export const BOARDS = {
  workers: { x: -11.7, y: 2.3, width: 6, height: 3, label: "🤖 Workers" },
  line: { x: -3.9, y: 2.3, width: 6, height: 3, label: "🎤 Up next" },
  goals: { x: 3.9, y: 2.3, width: 5.2, height: 3, label: "🎯 Goals" },
} as const;

/** The big TV on the east wall of the lounge. */
export const TV = { x: FLOOR.maxX - 0.1, y: 2.4, z: -1, width: 6.4, height: 3.6 } as const;

/**
 * Where a worker with nothing to do takes a break: round the lounge — the
 * poufs, in front of the TV, by the couch. (It's only them walking about: no
 * agent's doing anything, so it costs nothing.)
 */
export const BREAK_SPOTS: readonly { x: number; z: number; facing: number }[] = [
  { x: 13.2, z: -3.4, facing: Math.PI / 2 },
  { x: 15.4, z: -3.6, facing: Math.PI / 2 },
  { x: 13.6, z: 1.8, facing: Math.PI / 2 },
  { x: 15.2, z: 2.6, facing: Math.PI / 2 },
  { x: 11.6, z: -2.6, facing: Math.PI / 2 },
  { x: 11.6, z: 0.8, facing: Math.PI / 2 },
];

/** The lounge in front of the TV. */
export const LOUNGE = {
  couch: { x: 10.5, z: -1, rotY: Math.PI / 2 },
  table: { x: 12.8, z: -1 },
  rug: { x: 13, z: -1, rx: 5.2, rz: 3.6 },
  poufs: [
    { x: 13.2, z: -4.2, color: "#ffd166" },
    { x: 15.4, z: -4.4, color: "#06d6a0" },
  ],
} as const;

/**
 * Your office: a big walled room in the south-east corner where workers
 * come to present. The door is in its north wall; the presentation screen is
 * on the south wall, the review whiteboard on the east wall, and your desk
 * faces the screen.
 */
export const MY_OFFICE = { minX: 8, maxX: FLOOR.maxX, minZ: 6, maxZ: FLOOR.maxZ, height: 3.2 } as const;
export const OFFICE_DOOR = { x0: 9.3, x1: 10.9 } as const;
export const DOOR_X = (OFFICE_DOOR.x0 + OFFICE_DOOR.x1) / 2;
/** The presentation screen on the office's south wall. */
export const SCREEN = { x: 13.6, y: 1.9, z: FLOOR.maxZ - 0.08, width: 5.2, height: 2.9 } as const;
/**
 * The monitor wall: one big screen on the inside of the office's west wall
 * (facing +x) with every worker's terminal on it, live. `spot` is where you
 * stand to open the Agent monitor (E); `key` is where its E key floats.
 */
export const MONITOR_WALL = { x: MY_OFFICE.minX + 0.12, y: 1.75, z: 9.4, width: 5, height: 2.6, spot: { x: MY_OFFICE.minX + 1.6, z: 9.4 }, r: 2 } as const;
/** The armchairs in your office (facing the presentation screen): sit in them with E. */
export const OFFICE_ARMCHAIRS = [
  { x: 11.0, z: 11.4, facing: 0.5, color: "#ef476f" },
  { x: 16.0, z: 10.4, facing: -0.5, color: "#06d6a0" },
] as const;
/** The chair facing the monitor wall: sit in it to work the CCTV (facing -x, at the wall). */
export const MONITOR_CHAIR = { x: MY_OFFICE.minX + 3.6, z: 9.4, facing: -Math.PI / 2, pitch: 0.14 } as const;
/** How thick the office's walls are. */
export const MY_OFFICE_WALL_T = 0.16;

/** Your office's walls (solid, not glass: nobody sees in): the north wall either side of the door, and the west wall. */
export function myOfficeWalls(): Rect[] {
  const { minX, maxX, minZ, maxZ } = MY_OFFICE;
  const t = MY_OFFICE_WALL_T / 2;
  return [
    { minX, maxX: OFFICE_DOOR.x0, minZ: minZ - t, maxZ: minZ + t },
    { minX: OFFICE_DOOR.x1, maxX, minZ: minZ - t, maxZ: minZ + t },
    { minX: minX - t, maxX: minX + t, minZ, maxZ },
  ];
}
/** Your review desk, facing the screen, and where you stand to hold a review. */
export const REVIEW_DESK = { x: 13.6, z: 8.6 } as const;
export const REVIEW_SPOT = { x: 13.6, z: 7.7 } as const;
/** The review whiteboard on the office's east wall, facing west. */
export const REVIEW_BOARD = { x: FLOOR.maxX - 0.08, y: 1.8, z: 9.6, width: 3.6, height: 2.1 } as const;

/** Where the presenter stands: beside the screen, facing your desk. */
export const PODIUM = { x: 16.9, z: 11.6, facing: Math.PI } as const;
/** The line waits outside the office door, along its wall. */
const LINE_X = [11.9, 13.1, 14.3, 15.5, 16.7];
const LINE_Z = [5.0, 3.9];

/** Where the presenter (order 0) or the nth in line stands, and which way they face. */
export function lineSpot(order: number): { x: number; z: number; facing: number } {
  if (order <= 0) return { ...PODIUM };
  const i = order - 1;
  const row = Math.min(LINE_Z.length - 1, Math.floor(i / LINE_X.length));
  return { x: LINE_X[i % LINE_X.length], z: LINE_Z[row], facing: -Math.PI / 2 };
}

/** A whiteboard on wheels out on the open floor. */
export const WHITEBOARD = { x: 4.8, z: -6.2, width: 3.6, height: 2 } as const;

/** Potted plants: x, z, scale. */
export const PLANTS: readonly (readonly [number, number, number])[] = [
  [-17.2, -12.2, 1.4],
  [17.2, -12.2, 1.3],
  [-17.2, 12.2, 1.3],
  [-17.2, 8.5, 1.1],
  [14.4, -12.2, 1.1],
  [0.4, 12.2, 1.2],
  [-6, -12.2, 1],
];

/** Windows on the outside walls: which wall, the center along it, and the width. */
export const WINDOWS: readonly { wall: "south" | "west"; u: number; width: number }[] = [
  { wall: "west", u: -9, width: 3 },
  { wall: "west", u: -3, width: 3 },
  { wall: "west", u: 3, width: 3 },
];

type Pt = { x: number; z: number };
/** A point on a walk; `lift` means take the elevator there (a jump to another floor). */
export type WalkPt = Pt & { lift?: boolean };

/** The open floor east of the desks every route passes through. */
const HUB: Pt = { x: 7.6, z: 0.6 };
const DOOR_OUT: Pt = { x: DOOR_X, z: MY_OFFICE.minZ - 1.0 };
const DOOR_IN: Pt = { x: DOOR_X, z: MY_OFFICE.minZ + 0.9 };

function atDesks(p: Pt): boolean {
  return p.x < 3.2 && Math.abs(p.z) > 1.6 && Math.abs(p.z) < 7;
}
function atBay(p: Pt): boolean {
  return p.x < 3.2 && p.z < BAY.lane - 0.3;
}
/** From a bay seat out to its walkway and east to the open floor. */
function outOfBay(seat: Pt): Pt[] {
  const pts: Pt[] = [];
  if (seat.z < BAY.back) {
    // The back row goes round the end of its pair first.
    const cx = BAY.x.reduce((a, b) => (Math.abs(b - seat.x) < Math.abs(a - seat.x) ? b : a));
    const end = cx + DESK_SIZE.width + 0.6;
    pts.push({ x: end, z: seat.z }, { x: end, z: BAY.lane });
  } else pts.push({ x: seat.x, z: BAY.lane });
  pts.push({ x: 2.4, z: BAY.lane }, { x: 2.4, z: 0.6 });
  return pts;
}
export function inMyOffice(p: Pt): boolean {
  return p.x > MY_OFFICE.minX + 0.1 && p.x < MY_OFFICE.maxX && p.z > MY_OFFICE.minZ + 0.1 && p.z < MY_OFFICE.maxZ;
}
function inLine(p: Pt): boolean {
  return p.x > 8.2 && p.z > 3 && p.z < MY_OFFICE.minZ;
}

/** From a desk seat out to the aisle between the pods (in walking order). */
function outOfPod(seat: Pt): Pt[] {
  if (Math.abs(seat.z) > 4) {
    // The outer row steps back clear of the chairs, then goes east past the
    // end of its cluster.
    const edge = seat.x < (CLUSTER_X[0] + CLUSTER_X[1]) / 2 ? -6 : 2.4;
    const back = Math.sign(seat.z) * 6.4;
    return [{ x: seat.x, z: back }, { x: edge, z: back }, { x: edge, z: 0.6 }];
  }
  return [{ x: seat.x, z: 0.6 }];
}

/**
 * The way a worker walks between two places — its desk, the line outside your
 * office, or the podium inside — round the desks and through the office door.
 * Returns the points to walk through after `from`, ending at `to`.
 */
export function route(from: Pt, to: Pt): WalkPt[] {
  const a = floorOf(from.x);
  const b = floorOf(to.x);
  if (a === b) return a === 1 ? routeGround(from, to) : routeUpstairs(a, from, to);
  // Another floor: to the elevator, ride it, and on from its doors there.
  const out = a === 1 ? routeGround(from, GROUND_LIFT) : routeUpstairs(a, from, liftOf(a));
  const arrive = liftOf(b);
  return [...out, { ...arrive, lift: true }, ...(b === 1 ? routeGround(arrive, to) : routeUpstairs(b, arrive, to))];
}

/** Where the elevator lets you out on each floor. */
const GROUND_LIFT: Pt = { x: ELEVATOR.x, z: FLOOR.minZ + ELEVATOR.depth + 0.9 };
function liftOf(floor: number): Pt {
  return floor === 3 ? { x: TEAM_ARRIVE.x, z: TEAM_ARRIVE.z } : floor === 2 ? { x: UP_ARRIVE.x, z: UP_ARRIVE.z } : GROUND_LIFT;
}

/** Walking about floor 2 or 3: round the pods (3) or through the gap in the bookcases (2). */
function routeUpstairs(floor: number, from: Pt, to: Pt): Pt[] {
  if (floor === 3) {
    const pts: Pt[] = [];
    const corridor = { x: TEAM_ELEVATOR.x, z: TEAM_AISLE_Z };
    if (atTeamDesk(from)) pts.push(...outOfTeamPod(from), corridor);
    else if (from.z < TEAM_AISLE_Z - 1) pts.push(corridor);
    if (atTeamDesk(to)) pts.push(corridor, ...outOfTeamPod(to).reverse());
    else if (to.z < TEAM_AISLE_Z - 1) pts.push(corridor);
    pts.push(to);
    return pts;
  }
  // Floor 2: the bookcases split it, with a gap in the middle.
  const side = (x: number) => (x < UP_SPLITS_X[0] ? 0 : x < UP_SPLITS_X[1] ? 1 : 2);
  if (side(from.x) === side(to.x)) return [to];
  return [{ x: from.x, z: 0 }, { x: to.x, z: 0 }, to];
}

function atTeamDesk(p: Pt): boolean {
  return TEAM_PODS.some((pod) => Math.abs(p.x - pod.x) < DESK_SIZE.width + 0.4 && Math.abs(p.z - pod.z) < 2);
}
/** From a team-floor seat to the aisle: the far row goes round the pod's end (the one nearer the elevator). */
function outOfTeamPod(seat: Pt): Pt[] {
  const pod = TEAM_PODS.reduce((a, b) => (Math.hypot(b.x - seat.x, b.z - seat.z) < Math.hypot(a.x - seat.x, a.z - seat.z) ? b : a));
  const farSide = Math.abs(seat.z - TEAM_AISLE_Z) > Math.abs(pod.z - TEAM_AISLE_Z);
  if (!farSide) return [{ x: seat.x, z: TEAM_AISLE_Z }];
  const end = pod.x + (pod.x < TEAM_ELEVATOR.x ? 1 : -1) * (DESK_SIZE.width + 0.8);
  return [{ x: end, z: seat.z }, { x: end, z: TEAM_AISLE_Z }];
}

/** Which floor a point's on: 1 (the building and campus), 2, or 3 (the team floor). */
export function floorOf(x: number): 1 | 2 | 3 {
  return x >= TEAM_FLOOR.minX - 2 ? 3 : x >= UPSTAIRS.minX - 2 ? 2 : 1;
}

/** On the ground floor (the building and the campus round it). */
function routeGround(from: Pt, to: Pt): Pt[] {
  const pts: Pt[] = [];
  // Out of the stand-up room first (through its door, the hallway and the office's door).
  if (inStandupRoom(from) && !inStandupRoom(to)) pts.push(...TO_STANDUP.slice().reverse());
  if (atBay(from)) pts.push(...outOfBay(from), HUB);
  else if (atDesks(from)) pts.push(...outOfPod(from), HUB);
  else if (inMyOffice(from)) pts.push(DOOR_IN, DOOR_OUT);

  if (atBay(to)) {
    if (!atBay(from)) pts.push(HUB);
    pts.push(...outOfBay(to).reverse());
  } else if (atDesks(to)) {
    if (!atDesks(from)) pts.push(HUB);
    pts.push(...outOfPod(to).reverse());
  } else if (inMyOffice(to)) {
    if (!inMyOffice(from)) {
      if (!inLine(from)) pts.push({ x: 8.6, z: 5.0 });
      pts.push(DOOR_OUT, DOOR_IN);
    }
  } else if (inLine(to) && !inLine(from)) {
    pts.push({ x: 8.6, z: to.z });
  } else if (inStandupRoom(to) && !inStandupRoom(from)) {
    pts.push(...TO_STANDUP);
  }
  pts.push(to);
  return pts;
}

/** From the open office to the stand-up room: its east door, along the hallway, in at the room's door. */
const TO_STANDUP: readonly Pt[] = [
  { x: 3, z: 11.6 },
  { x: 3, z: 14.7 },
  { x: -4.5, z: 14.7 },
  { x: -4.5, z: 17.6 },
];

/** In the stand-up room (south of the hallway, between its partitions). */
function inStandupRoom(p: Pt): boolean {
  return p.z > 16.6 && p.z < 29 && p.x > -9 && p.x < 0;
}

// ---------------------------------------------------------------------------
// The south wing and the grounds
// ---------------------------------------------------------------------------
//
// South of the open office, through two doors in its south wall, a hallway
// runs the width of the building. Off it are the kitchen, the stand-up room,
// the lobby (with the front doors out to the grounds) and the game room. The
// building sits in a campus you can walk all the way round: a plaza and a
// fountain out front, a five-a-side pitch, picnic tables and a street.

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The whole building, outer walls excluded. */
export const BUILDING = { minX: FLOOR.minX, maxX: FLOOR.maxX, minZ: FLOOR.minZ, maxZ: 29 } as const;
/** The hallway between the open office and the wing's rooms. */
export const HALL = { minX: FLOOR.minX, maxX: FLOOR.maxX, minZ: FLOOR.maxZ + WALL_T, maxZ: 16.3 } as const;
/** Where the wing's rooms start (south face of the hallway wall). */
export const WING_ROOMS_Z = HALL.maxZ + WALL_T;
/** How far you can walk outside. */
export const WORLD_BOUNDS = { minX: -44, maxX: 44, minZ: -36, maxZ: 62 } as const;

/** A gap in a wall running along x (at a given z): x0..x1. */
export interface Gap {
  x0: number;
  x1: number;
}

/** The doors from the open office into the hallway (in the old south wall). */
export const OFFICE_HALL_DOORS: readonly Gap[] = [
  { x0: -12.4, x1: -10.6 },
  { x0: 2.1, x1: 3.9 },
];
/** The rooms' doors off the hallway (in its south wall). The lobby's is a wide opening. */
export const ROOM_DOORS = {
  kitchen: { x0: -14.4, x1: -12.6 },
  standup: { x0: -5.4, x1: -3.6 },
  lobby: { x0: 0.6, x1: 5.4 },
  game: { x0: 10.8, x1: 13.2 },
} as const;
/** The walls between the wing's rooms, by their center x. */
export const PARTITIONS_X = [-9, 0, 6] as const;
/** The lobby's sliding front doors, in the building's south wall. */
export const FRONT_DOOR = { x0: 2, x1: 4, z: BUILDING.maxZ + WALL_T / 2 } as const;

function wallAlongX(z0: number, z1: number, x0: number, x1: number, gaps: readonly Gap[]): Rect[] {
  const out: Rect[] = [];
  let x = x0;
  for (const g of [...gaps].sort((a, b) => a.x0 - b.x0)) {
    if (g.x0 > x) out.push({ minX: x, maxX: g.x0, minZ: z0, maxZ: z1 });
    x = Math.max(x, g.x1);
  }
  if (x < x1) out.push({ minX: x, maxX: x1, minZ: z0, maxZ: z1 });
  return out;
}

/**
 * Every full-height wall of the building as a solid box on the floor: the
 * outer walls, the open office's south wall with its two doors, the
 * hallway's south wall with the rooms' doors, the partitions between the
 * rooms, and the front wall with the front doors. Drawn and collided with
 * alike. (Your office's walls are separate and lower: see myOfficeWalls.)
 */
export function wallRects(): Rect[] {
  const T = WALL_T;
  const { minX, maxX, minZ, maxZ } = BUILDING;
  const rects: Rect[] = [
    // North, west and east outer walls.
    { minX: minX - T, maxX: maxX + T, minZ: minZ - T, maxZ: minZ },
    { minX: minX - T, maxX: minX, minZ, maxZ },
    { minX: maxX, maxX: maxX + T, minZ, maxZ },
  ];
  rects.push(...wallAlongX(FLOOR.maxZ, FLOOR.maxZ + T, minX, maxX, OFFICE_HALL_DOORS));
  rects.push(...wallAlongX(HALL.maxZ, HALL.maxZ + T, minX, maxX, Object.values(ROOM_DOORS)));
  for (const x of PARTITIONS_X) rects.push({ minX: x - T / 2, maxX: x + T / 2, minZ: WING_ROOMS_Z, maxZ });
  rects.push(...wallAlongX(maxZ, maxZ + T, minX - T, maxX + T, [FRONT_DOOR]));
  return rects;
}

export type RoomId = "office" | "floor" | "hall" | "kitchen" | "standup" | "lobby" | "game" | "outside" | "library" | "lounge2" | "gym" | "team";

export interface RoomDef extends Rect {
  id: RoomId;
  name: string;
  icon: string;
  /** Its color on the minimap. */
  color: string;
}

/** The rooms, most specific first (your office sits inside the open office). */
export const ROOMS: readonly RoomDef[] = [
  { id: "office", name: "Your office", icon: "⭐", color: "#e0c3fc", minX: MY_OFFICE.minX, maxX: MY_OFFICE.maxX, minZ: MY_OFFICE.minZ, maxZ: MY_OFFICE.maxZ },
  { id: "floor", name: "Work floor", icon: "🖥", color: "#f2d7b0", ...FLOOR },
  { id: "hall", name: "Hallway", icon: "🚪", color: "#d8d2c8", minX: HALL.minX, maxX: HALL.maxX, minZ: FLOOR.maxZ, maxZ: WING_ROOMS_Z },
  { id: "kitchen", name: "Kitchen", icon: "☕", color: "#bde0c4", minX: BUILDING.minX, maxX: PARTITIONS_X[0], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ },
  { id: "standup", name: "Stand-up room", icon: "☀️", color: "#ffe29a", minX: PARTITIONS_X[0], maxX: PARTITIONS_X[1], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ },
  { id: "lobby", name: "Lobby", icon: "🛎", color: "#cde7ff", minX: PARTITIONS_X[1], maxX: PARTITIONS_X[2], minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ },
  { id: "game", name: "Game room", icon: "🕹", color: "#c3b5ff", minX: PARTITIONS_X[2], maxX: BUILDING.maxX, minZ: WING_ROOMS_Z, maxZ: BUILDING.maxZ },
  { id: "library", name: "Floor 2 · Library", icon: "📚", color: "#d9c5a0", minX: 62, maxX: 74, minZ: -14, maxZ: 14 },
  { id: "lounge2", name: "Floor 2 · Lounge", icon: "🎹", color: "#f7c6d9", minX: 74, maxX: 86, minZ: -14, maxZ: 14 },
  { id: "gym", name: "Floor 2 · Gym", icon: "🏋️", color: "#bfe6ff", minX: 86, maxX: 98, minZ: -14, maxZ: 14 },
  { id: "team", name: "Floor 3 · Team floor", icon: "🧑‍💻", color: "#d6f5e3", minX: 102, maxX: 138, minZ: -14, maxZ: 14 },
];
export const OUTSIDE: RoomDef = { id: "outside", name: "Outside", icon: "🌳", color: "#a7d98b", ...WORLD_BOUNDS };

export function roomAt(x: number, z: number): RoomDef {
  for (const r of ROOMS) if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r;
  return OUTSIDE;
}
export function isIndoors(x: number, z: number): boolean {
  if (x >= 62 && x <= 98 && z >= -14 && z <= 14) return true;
  if (x >= TEAM_FLOOR.minX && x <= TEAM_FLOOR.maxX && z >= TEAM_FLOOR.minZ && z <= TEAM_FLOOR.maxZ) return true;
  return x >= BUILDING.minX && x <= BUILDING.maxX && z >= BUILDING.minZ && z <= BUILDING.maxZ;
}

/** The stand-up room: a big screen on its south wall and a circle on the floor to stand in. */
export const STANDUP = {
  screen: { x: -4.5, y: 2.5, z: BUILDING.maxZ - 0.08, width: 5.6, height: 3.1 },
  circle: { x: -4.5, z: 23.4, r: 2.3 },
  /** Where you stand to run the stand-up, facing the screen. */
  spot: { x: -4.5, z: 23.2, facing: 0 },
} as const;

/** The kitchen: a counter along its west wall with the coffee machine, and two tables. */
export const KITCHEN = {
  counter: { minX: BUILDING.minX, maxX: BUILDING.minX + 0.9, minZ: 17.4, maxZ: 28.4 },
  coffee: { x: BUILDING.minX + 0.45, z: 22 },
  /** Where you stand to pour a coffee, facing the machine. */
  coffeeSpot: { x: BUILDING.minX + 1.7, z: 22, facing: -Math.PI / 2 },
  fridge: { x: BUILDING.minX + 0.5, z: 27.9 },
  tables: [
    { x: -12.8, z: 21.2 },
    { x: -12.8, z: 25.6 },
  ],
} as const;

/** The lobby: reception desk, a couch to wait on, the company sign. */
export const LOBBY = {
  desk: { x: 1.25, z: 23.6, length: 2.6 },
  couch: { x: 5.3, z: 24.2 },
} as const;

/** The arcade cabinets against the game room's south wall, screens facing north. */
export type ArcadeId = "snake" | "bugsmash" | "breakout" | "merge" | "dash";
/**
 * The arcade cabinets: three in the game room (screens facing north), and
 * more upstairs — in floor 2's lounge, against its bookcase, and in the team
 * floor's break corner. `rotY` turns the cabinet (π: its screen faces -z).
 */
export const ARCADES: readonly { id: ArcadeId; name: string; x: number; z: number; color: string; rotY: number }[] = [
  { id: "snake", name: "Snake", x: 8.6, z: BUILDING.maxZ - 0.55, color: "#06d6a0", rotY: Math.PI },
  { id: "bugsmash", name: "Bug Smash", x: 10.4, z: BUILDING.maxZ - 0.55, color: "#ef476f", rotY: Math.PI },
  { id: "breakout", name: "Brick Breaker", x: 12.2, z: BUILDING.maxZ - 0.55, color: "#5bc0eb", rotY: Math.PI },
  { id: "merge", name: "Merge", x: 85.4, z: -8.2, color: "#c77dff", rotY: -Math.PI / 2 },
  { id: "dash", name: "Deploy Dash", x: 85.4, z: -10.0, color: "#ffd166", rotY: -Math.PI / 2 },
];
/** More of the same games, as cabinets of their own on the team floor (they share their best scores). */
export const TEAM_ARCADES: readonly { id: ArcadeId; name: string; x: number; z: number; color: string; rotY: number }[] = [
  { id: "merge", name: "Merge", x: 124.4, z: 12.9, color: "#c77dff", rotY: Math.PI },
  { id: "dash", name: "Deploy Dash", x: 125.7, z: 12.9, color: "#ffd166", rotY: Math.PI },
  { id: "snake", name: "Snake", x: 115.6, z: 12.9, color: "#06d6a0", rotY: Math.PI },
];
/** Every cabinet in the building, wherever it stands. */
export const ALL_ARCADES = [...ARCADES, ...TEAM_ARCADES];
/** Where you stand to play a cabinet: in front of its screen, facing it. */
export function arcadeSpot(a: { x: number; z: number; rotY?: number }): { x: number; z: number; facing: number } {
  const r = a.rotY ?? Math.PI;
  return { x: a.x + Math.sin(r) * 1.15, z: a.z + Math.cos(r) * 1.15, facing: r };
}
/** The basketball hoop on the game room's east wall, and the free-throw spot. */
export const HOOP = {
  rim: { x: BUILDING.maxX - 0.65, y: 2.75, z: 22.4 },
  spot: { x: 13.9, z: 22.4, facing: Math.PI / 2 },
} as const;
/** Screens on the game room's west wall (facing +x) so you can keep an eye on work. */
export const GAME_MONITORS = {
  workers: { x: PARTITIONS_X[2] + WALL_T / 2 + 0.06, y: 2.5, z: 20.2, width: 3.6, height: 2.1 },
  goals: { x: PARTITIONS_X[2] + WALL_T / 2 + 0.06, y: 2.5, z: 24.8, width: 3.6, height: 2.1 },
} as const;
export const PING_PONG = { x: 10.4, z: 22.6 } as const;
/** The glowing pad inside the game room's door: step on it to go straight back to work. */
export const WORK_PAD = { x: 15.8, z: 17.7, r: 0.75 } as const;

/** The grounds. */
export const PLAZA = { minX: -4, maxX: 10, minZ: BUILDING.maxZ + WALL_T, maxZ: 40 } as const;
export const FOUNTAIN = { x: 3, z: 44.5, r: 2.4 } as const;
export const SIDEWALK = { minZ: 50.5, maxZ: 53 } as const;
export const STREET = { minZ: 53, maxZ: 61 } as const;
/** A five-a-side pitch west of the plaza, goals at its west and east ends. */
export const PITCH = { minX: -37, maxX: -13, minZ: 33, maxZ: 49, goalWidth: 3.6 } as const;
export const PICNIC = [
  { x: 22, z: 37 },
  { x: 27, z: 41 },
  { x: 22, z: 45 },
] as const;

/** Fast-travel destinations, in menu order. */
export const PLACES: readonly { id: RoomId | "desks"; label: string; icon: string; x: number; z: number; facing: number }[] = [
  { id: "desks", label: "Work floor", icon: "🖥", ...SPAWN },
  { id: "office", label: "Your office", icon: "⭐", x: REVIEW_SPOT.x, z: REVIEW_SPOT.z, facing: 0 },
  { id: "standup", label: "Stand-up room", icon: "☀️", ...STANDUP.spot },
  { id: "kitchen", label: "Kitchen", icon: "☕", x: -14.9, z: 20.2, facing: 0 },
  { id: "game", label: "Game room", icon: "🕹", x: 13.2, z: 20.2, facing: 0 },
  { id: "lobby", label: "Lobby", icon: "🛎", x: 3.4, z: 20.4, facing: 0 },
  { id: "outside", label: "Outside", icon: "🌳", x: 3, z: 32.5, facing: 0 },
];

/** The awning over the front doors, outside: a slab the camera mustn't end up in. */
export const FRONT_AWNING = { minX: 0.9, maxX: 5.1, minZ: BUILDING.maxZ + WALL_T, maxZ: BUILDING.maxZ + WALL_T + 1.6, y: 3.1, thick: 0.14 } as const;

/** How tall the doorways are; the wall continues above them. */
export const DOOR_HEIGHT = 2.5;
export const LOBBY_OPENING_HEIGHT = 2.9;
export const FRONT_DOOR_HEIGHT = 2.6;

export interface Box3D extends Rect {
  minY: number;
  maxY: number;
}

/**
 * Everything solid the third-person camera must stay out of: every wall at
 * full height, the wall above each doorway, and the roof.
 */
export function cameraOccluders(): Box3D[] {
  const T = WALL_T;
  const boxes: Box3D[] = wallRects().map((r) => ({ ...r, minY: 0, maxY: WALL_HEIGHT }));
  // Your office's walls are solid: the camera keeps on your side of them.
  for (const r of myOfficeWalls()) boxes.push({ ...r, minY: 0, maxY: MY_OFFICE.height });
  const header = (g: Gap, z0: number, z1: number, h: number) => boxes.push({ minX: g.x0, maxX: g.x1, minZ: z0, maxZ: z1, minY: h, maxY: WALL_HEIGHT });
  for (const g of OFFICE_HALL_DOORS) header(g, FLOOR.maxZ, FLOOR.maxZ + T, DOOR_HEIGHT);
  for (const [id, g] of Object.entries(ROOM_DOORS)) header(g, HALL.maxZ, HALL.maxZ + T, id === "lobby" ? LOBBY_OPENING_HEIGHT : DOOR_HEIGHT);
  header(FRONT_DOOR, BUILDING.maxZ, BUILDING.maxZ + T, FRONT_DOOR_HEIGHT);
  boxes.push({ minX: BUILDING.minX - T, maxX: BUILDING.maxX + T, minZ: BUILDING.minZ - T, maxZ: BUILDING.maxZ + T, minY: WALL_HEIGHT, maxY: WALL_HEIGHT + 0.6 });
  const a = FRONT_AWNING;
  boxes.push({ minX: a.minX, maxX: a.maxX, minZ: a.minZ, maxZ: a.maxZ, minY: a.y - a.thick / 2, maxY: a.y + a.thick / 2 });
  return boxes;
}

/**
 * The idea boards: the whiteboard on wheels on the work floor and the one on
 * the stand-up room's east wall. `spot` is where you stand to use one (E
 * opens it within `r` of there); `key` is where its E key floats, beside
 * the board so it doesn't cover the notes or the label.
 */
export const IDEA_BOARDS = [
  { id: "floor", label: "Idea board", key: { x: WHITEBOARD.x - WHITEBOARD.width / 2 - 0.45, y: 1.7, z: WHITEBOARD.z }, spot: { x: WHITEBOARD.x, z: WHITEBOARD.z }, r: 2.4 },
  { id: "standup", label: "Stand-up idea board", key: { x: PARTITIONS_X[1] - 0.35, y: 1.85, z: STANDUP.circle.z + 1.75 }, spot: { x: PARTITIONS_X[1] - 1.3, z: STANDUP.circle.z }, r: 1.5 },
] as const;
export type IdeaBoardId = (typeof IDEA_BOARDS)[number]["id"];

/**
 * The jukeboxes: one against the game room's west wall, one by the lounge on
 * the work floor. E at one picks the music; `spot` is where you stand, `key`
 * where its E key floats.
 */
export const JUKEBOXES = [
  { id: "gameroom", spot: { x: PARTITIONS_X[2] + 1.7, z: 27.0 }, key: { x: PARTITIONS_X[2] + 0.75, y: 2.35, z: 27.0 } },
  { id: "lounge", spot: { x: FLOOR.maxX - 1.65, z: -7.2 }, key: { x: FLOOR.maxX - 0.6, y: 2.35, z: -7.2 } },
] as const;

// ---------------------------------------------------------------------------
// Floor 2: up the elevator. It's built off to the east of the campus, walled
// in, with the city outside its windows — a library, a lounge and a gym.
// ---------------------------------------------------------------------------

export const UPSTAIRS = { minX: 62, maxX: 98, minZ: -14, maxZ: 14 } as const;
export const UP_HEIGHT = 4.4;
/** The elevator doors in floor 2's north wall, and where it lets you out. */
export const UP_ELEVATOR = { x: 80, width: 2.6 } as const;
export const UP_ARRIVE = { x: 80, z: UPSTAIRS.minZ + 2.6, facing: 0 } as const;
/** Low bookcases split the floor into its three areas (with a gap to walk through). */
export const UP_SPLITS_X = [74, 86] as const;
export const UP_SPLIT_GAP = { z0: -4, z1: 4 } as const;
export const UP = {
  armchairs: [
    { x: 66.2, z: -6.5, rotY: Math.PI / 2 },
    { x: 66.2, z: 6.5, rotY: Math.PI / 2 },
  ],
  readingTables: [
    { x: 67.9, z: -6.5 },
    { x: 67.9, z: 6.5 },
  ],
  /** The bookshelf you browse (E): a tip off the shelf. */
  shelfSpot: { x: 63.6, z: 0, facing: -Math.PI / 2 },
  sofa: { x: 80, z: 7.6, rotY: Math.PI },
  coffeeTable: { x: 80, z: 5.7 },
  piano: { x: 76.4, z: 12.6 },
  pianoSpot: { x: 76.4, z: 11.2, facing: 0 },
  vending: { x: 84.4, z: UPSTAIRS.minZ + 0.55 },
  vendingSpot: { x: 84.4, z: UPSTAIRS.minZ + 1.7, facing: Math.PI },
  darts: { x: 75.6, y: 1.75, z: UPSTAIRS.minZ + 0.18 },
  dartsSpot: { x: 75.6, z: UPSTAIRS.minZ + 3.4, facing: Math.PI },
  treadmills: [
    { x: 89.5, z: -10.6 },
    { x: 93.5, z: -10.6 },
  ],
  mats: [
    { x: 90, z: 6.5 },
    { x: 93.5, z: 6.5 },
  ],
  telescope: { x: 95.6, z: 12.2 },
  telescopeSpot: { x: 95.6, z: 11.1, facing: 0 },
} as const;

// ---------------------------------------------------------------------------
// Out back (north of the building): a running track, a campfire, a garden,
// and east of the building a pond with a fishing dock.
// ---------------------------------------------------------------------------

export const TRACK = { x: 12, z: -25.5, rx: 9, rz: 5.4, width: 1.6 } as const;
/** The lap's checkpoints, in order round the oval (start/finish is the first). */
export const TRACK_CHECKPOINTS: readonly { x: number; z: number }[] = [
  { x: TRACK.x, z: TRACK.z + TRACK.rz },
  { x: TRACK.x + TRACK.rx, z: TRACK.z },
  { x: TRACK.x, z: TRACK.z - TRACK.rz },
  { x: TRACK.x - TRACK.rx, z: TRACK.z },
];
export const CAMPFIRE = { x: -12, z: -25, logR: 2.3 } as const;
export const GARDEN = { minX: -34, maxX: -25, minZ: -21, maxZ: -15, spot: { x: -29.5, z: -13.9, facing: Math.PI } } as const;
export const POND = { x: 31.5, z: -2, rx: 6, rz: 4.4 } as const;
export const DOCK = { x0: 24.2, x1: 27.6, z: -2, width: 1.3 } as const;
export const DOCK_SPOT = { x: 27.2, z: -2, facing: Math.PI / 2 } as const;

/** Fast-travel destinations beyond the main floor (the travel menu lists them after PLACES). */
export const MORE_PLACES: readonly { id: string; label: string; icon: string; x: number; z: number; facing: number }[] = [
  { id: "upstairs", label: "Floor 2 — library, lounge, gym", icon: "🛗", ...UP_ARRIVE },
  { id: "teamfloor", label: "Floor 3 — the team floor (16 more desks)", icon: "🧑‍💻", ...TEAM_ARRIVE },
  { id: "track", label: "Running track", icon: "🏃", x: TRACK.x, z: TRACK.z + TRACK.rz + 1.6, facing: Math.PI },
  { id: "campfire", label: "Campfire", icon: "🔥", x: CAMPFIRE.x, z: CAMPFIRE.z + 3.6, facing: Math.PI },
  { id: "garden", label: "Garden", icon: "🌻", ...GARDEN.spot },
  { id: "pond", label: "Fishing pond", icon: "🎣", x: DOCK.x0 - 1.2, z: DOCK.z, facing: Math.PI / 2 },
];

export function inUpstairs(x: number, z?: number): boolean {
  return floorOf(x) === 2 && (z === undefined || (z >= UPSTAIRS.minZ - 2 && z <= UPSTAIRS.maxZ + 2));
}

/** On floor 3, the team floor. */
export function inTeamFloor(x: number, z?: number): boolean {
  return floorOf(x) === 3 && (z === undefined || (z >= TEAM_FLOOR.minZ - 2 && z <= TEAM_FLOOR.maxZ + 2));
}

/**
 * Places to sit down and work on your laptop: where you sit (and which way
 * you face) and where the laptop goes — a table in front of you, or your lap.
 */
export interface WorkSpot {
  id: string;
  label: string;
  sit: { x: number; z: number; facing: number };
  laptop: { x: number; y: number; z: number; rotY: number };
}
export const WORK_SPOTS: readonly WorkSpot[] = [
  { id: "lounge", label: "the lounge couch", sit: { x: 10.8, z: -1, facing: Math.PI / 2 }, laptop: { x: 12.45, y: 0.49, z: -1, rotY: -Math.PI / 2 } },
  ...KITCHEN.tables.map((t, i) => ({
    id: `kitchen-${i}`,
    label: "a kitchen table",
    sit: { x: t.x, z: t.z + 1.0, facing: Math.PI },
    laptop: { x: t.x, y: 0.78, z: t.z + 0.38, rotY: 0 },
  })),
  ...PICNIC.map((p, i) => ({
    id: `picnic-${i}`,
    label: "a picnic table",
    sit: { x: p.x, z: p.z + 0.7, facing: Math.PI },
    laptop: { x: p.x, y: 0.8, z: p.z + 0.18, rotY: 0 },
  })),
  { id: "lobby", label: "the lobby couch", sit: { x: LOBBY.couch.x - 0.05, z: LOBBY.couch.z, facing: -Math.PI / 2 }, laptop: { x: LOBBY.couch.x - 0.5, y: 0.66, z: LOBBY.couch.z, rotY: Math.PI / 2 } },
  ...UP.armchairs.map((c, i) => ({
    id: `library-${i}`,
    label: "a library armchair",
    sit: { x: c.x, z: c.z, facing: Math.PI / 2 },
    laptop: { x: UP.readingTables[i].x, y: 0.62, z: UP.readingTables[i].z, rotY: -Math.PI / 2 },
  })),
  { id: "sofa2", label: "the floor 2 sofa", sit: { x: UP.sofa.x, z: UP.sofa.z - 0.15, facing: Math.PI }, laptop: { x: UP.coffeeTable.x, y: 0.46, z: UP.coffeeTable.z, rotY: 0 } },
  { id: "campfire", label: "a log by the campfire", sit: { x: CAMPFIRE.x, z: CAMPFIRE.z + CAMPFIRE.logR, facing: Math.PI }, laptop: { x: CAMPFIRE.x, y: 0.55, z: CAMPFIRE.z + CAMPFIRE.logR - 0.42, rotY: 0 } },
];

/**
 * The i-th place to wait at the stand-up: a ring round the circle, away from
 * the screen (so they don't block it), facing the middle. More than fit go
 * round again a step further out.
 */
export function waitSpot(i: number): { x: number; z: number; facing: number } {
  const PER_RING = 8;
  // At most three rings: any more and they would be out through the walls (beyond that they share).
  const ring = Math.min(2, Math.floor(i / PER_RING));
  const k = i % PER_RING;
  // 0 is towards the screen (+z); spread from 60 to 300 degrees.
  const theta = ((60 + (k * 240) / (PER_RING - 1) + ring * 15) * Math.PI) / 180;
  const r = STANDUP.circle.r + ring * 0.75;
  return { x: STANDUP.circle.x + Math.sin(theta) * r, z: STANDUP.circle.z + Math.cos(theta) * r, facing: theta + Math.PI };
}
