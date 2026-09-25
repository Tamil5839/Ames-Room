import * as THREE from 'three';
import { EYE, HALF_W, ROOM, type RoomStyleName } from './config';
import { Kind, createRoomMaterial, createRoomUniforms, type RoomUniforms } from './roomShader';
import { AmesWarp, vec3, type Box3Like, type Vec3 } from './warp';

/**
 * The room is modelled once, in APPARENT space (an ordinary 6 x 3 x 5 m box with
 * trim, windows, a door, a painting and a clock). Every mesh keeps its apparent
 * vertex positions; `applyWarp` pushes each vertex through the Ames warp to get
 * the real, trapezoidal room. Large surfaces are heavily subdivided and every
 * pattern element (floor tile, window bar, moulding) is real geometry, so the room
 * survives the warp even without the shader's exact apparent-space texturing.
 */

type V3 = [number, number, number];
type V4 = [number, number, number, number];

interface VertexOpts {
  tint?: V3;
  extra?: V4;
  grain?: number;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotV = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normV = (a: V3): V3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Uniform parameter steps in [0,1] merged with extra breakpoints (used to cut holes on grid lines). */
export function breakpoints(segments: number, extra: number[] = []): number[] {
  const set = new Set<number>();
  for (let i = 0; i <= segments; i++) set.add(Math.round((i / segments) * 1e6) / 1e6);
  for (const e of extra) if (e > 0 && e < 1) set.add(Math.round(e * 1e6) / 1e6);
  return [...set].sort((a, b) => a - b);
}

export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly tint: number[] = [];
  readonly extra: number[] = [];
  readonly grain: number[] = [];
  readonly index: number[] = [];
  private count = 0;

  vertex(p: V3, n: V3, o: VertexOpts): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    const t = o.tint ?? [1, 1, 1];
    this.tint.push(t[0], t[1], t[2]);
    const e = o.extra ?? [0, 0, 0, 0];
    this.extra.push(e[0], e[1], e[2], e[3]);
    this.grain.push(o.grain ?? 0);
    return this.count++;
  }

  /**
   * A subdivided parallelogram o + a·u + b·v, (a, b) ∈ [0,1]², facing `n`.
   * `us` / `vs` are the parameter breakpoints; `skip(a, b)` drops cells (holes).
   */
  grid(o: V3, u: V3, v: V3, us: number[], vs: number[], n: V3, opts: VertexOpts = {}, skip?: (a: number, b: number) => boolean): void {
    const flip = dotV(crossV(u, v), n) < 0;
    const ids: number[][] = [];
    for (let j = 0; j < vs.length; j++) {
      const row: number[] = [];
      for (let i = 0; i < us.length; i++) {
        row.push(this.vertex(add(o, add(scale(u, us[i]), scale(v, vs[j]))), n, opts));
      }
      ids.push(row);
    }
    for (let j = 0; j < vs.length - 1; j++) {
      for (let i = 0; i < us.length - 1; i++) {
        if (skip && skip((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2)) continue;
        const a = ids[j][i], b = ids[j][i + 1], c = ids[j + 1][i + 1], d = ids[j + 1][i];
        if (flip) this.index.push(a, c, b, a, d, c);
        else this.index.push(a, b, c, a, c, d);
      }
    }
  }

  /** Axis-aligned box in apparent space, long axes subdivided every `step` metres. */
  box(min: V3, max: V3, opts: VertexOpts = {}, faces = 'pxnxpynypznz', step = 0.3): void {
    const size: V3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const seg = (len: number) => Math.max(1, Math.ceil(len / step));
    const grain = opts.grain ?? (size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2);
    const o = { ...opts, grain };
    const bx = breakpoints(seg(size[0]));
    const by = breakpoints(seg(size[1]));
    const bz = breakpoints(seg(size[2]));
    const X: V3 = [size[0], 0, 0], Y: V3 = [0, size[1], 0], Z: V3 = [0, 0, size[2]];
    if (faces.includes('px')) this.grid([max[0], min[1], min[2]], Y, Z, by, bz, [1, 0, 0], o);
    if (faces.includes('nx')) this.grid([min[0], min[1], min[2]], Y, Z, by, bz, [-1, 0, 0], o);
    if (faces.includes('py')) this.grid([min[0], max[1], min[2]], X, Z, bx, bz, [0, 1, 0], o);
    if (faces.includes('ny')) this.grid([min[0], min[1], min[2]], X, Z, bx, bz, [0, -1, 0], o);
    if (faces.includes('pz')) this.grid([min[0], min[1], max[2]], X, Y, bx, by, [0, 0, 1], o);
    if (faces.includes('nz')) this.grid([min[0], min[1], min[2]], X, Y, bx, by, [0, 0, -1], o);
  }

  /** A thin square-section rod from a to b (picture cords). */
  rod(a: V3, b: V3, width: number, opts: VertexOpts = {}): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const side = normV(crossV(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const up = normV(crossV(side, d));
    const h = width / 2;
    const corners = [
      add(scale(side, h), scale(up, h)),
      add(scale(side, -h), scale(up, h)),
      add(scale(side, -h), scale(up, -h)),
      add(scale(side, h), scale(up, -h)),
    ];
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k], c1 = corners[(k + 1) % 4];
      const n = normV(add(c0, c1));
      this.grid(add(a, c0), d, [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]], [0, 1], [0, 1], n, opts);
    }
  }

  /** A disc facing n (as a fan of thin quads so it subdivides nicely). */
  disc(center: V3, n: V3, radius: number, segments: number, opts: VertexOpts = {}): void {
    const t = normV(crossV([0, 1, 0], n));
    const b = crossV(n, t);
    const c = this.vertex(center, n, opts);
    const ring: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      ring.push(this.vertex(add(center, add(scale(t, Math.cos(a) * radius), scale(b, Math.sin(a) * radius))), n, opts));
    }
    for (let i = 0; i < segments; i++) this.index.push(c, ring[i], ring[i + 1]);
  }

  /** Open cylinder side between two discs (the clock's rim). */
  tube(center: V3, n: V3, radius: number, depth: number, segments: number, opts: VertexOpts = {}): void {
    const t = normV(crossV([0, 1, 0], n));
    const b = crossV(n, t);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2;
      const r0 = add(scale(t, Math.cos(a0)), scale(b, Math.sin(a0)));
      const r1 = add(scale(t, Math.cos(a1)), scale(b, Math.sin(a1)));
      const nn = normV(add(r0, r1));
      const p0 = add(center, scale(r0, radius));
      const p1 = add(center, scale(r1, radius));
      this.grid(p0, [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], scale(n, -depth), [0, 1], [0, 1], nn, opts);
    }
  }

  sphere(center: V3, radius: number, opts: VertexOpts = {}, wSeg = 16, hSeg = 10): void {
    const rows: number[][] = [];
    for (let j = 0; j <= hSeg; j++) {
      const th = (j / hSeg) * Math.PI;
      const row: number[] = [];
      for (let i = 0; i <= wSeg; i++) {
        const ph = (i / wSeg) * Math.PI * 2;
        const n: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        row.push(this.vertex(add(center, scale(n, radius)), n, opts));
      }
      rows.push(row);
    }
    for (let j = 0; j < hSeg; j++) {
      for (let i = 0; i < wSeg; i++) {
        const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i + 1], d = rows[j + 1][i];
        this.index.push(a, b, c, a, c, d);
      }
    }
  }

  get empty(): boolean {
    return this.count === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    const apparent = new Float32Array(this.pos);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.tint), 3));
    g.setAttribute('aExtra', new THREE.BufferAttribute(new Float32Array(this.extra), 4));
    g.setAttribute('aGrain', new THREE.BufferAttribute(new Float32Array(this.grain), 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.index, 1) : new THREE.Uint16BufferAttribute(this.index, 1));
    g.userData.apparent = apparent;
    return g;
  }
}

// ------------------------------------------------------------------ layout (apparent space)

const W = HALF_W;
const H = ROOM.height;
const D = ROOM.depth;
const BACK = -D;
const WALL_T = 0.2; // wall thickness seen in the window reveals

export const LAYOUT = {
  windows: [
    { x0: -2.05, x1: -0.95 },
    { x0: 0.95, x1: 2.05 },
  ],
  windowY0: 1.0,
  windowY1: 2.4,
  door: { z0: -4.3, z1: -3.35, y1: 2.1 },
  painting: { zc: -3.45, yc: 1.72, w: 1.0, h: 0.72, frame: 0.08 },
  clock: { x: 0, y: 2.0, r: 0.17 },
  skirting: 0.15,
  dado: [0.88, 0.93] as [number, number],
  pictureRail: [2.56, 2.6] as [number, number],
};

export interface RoomStyle {
  wallUpper: string;
  wallLower: string;
  stripe: number;
  wood: string;
  floorWhite: string;
  floorBlack: string;
  ceiling: string;
  plaster: string;
  glassTop: string;
  glassBottom: string;
  brass: string;
  ambSky: string;
  ambGround: string;
  key: string;
  keyIntensity: number;
  window: string;
  windowIntensity: number;
}

export const ROOM_STYLES: Record<RoomStyleName, RoomStyle> = {
  'Vintage museum': {
    wallUpper: '#efe0bf',
    wallLower: '#c9ae84',
    stripe: 0.055,
    wood: '#5a3520',
    floorWhite: '#eee6d6',
    floorBlack: '#1c1a17',
    ceiling: '#f2e8d4',
    plaster: '#f3e9d6',
    glassTop: '#fbf5e8',
    glassBottom: '#fff0cc',
    brass: '#b98d3e',
    ambSky: '#74685a',
    ambGround: '#6a5d4b',
    key: '#fff0d8',
    keyIntensity: 0.62,
    window: '#ffe6b8',
    windowIntensity: 0.22,
  },
  'Mint parlour': {
    wallUpper: '#d3e6d5',
    wallLower: '#9fbfa6',
    stripe: 0.06,
    wood: '#5b3a26',
    floorWhite: '#f1ede4',
    floorBlack: '#1d1f1c',
    ceiling: '#f3f0e6',
    plaster: '#f4f1e7',
    glassTop: '#f4f8fb',
    glassBottom: '#fdf5de',
    brass: '#b99045',
    ambSky: '#6a716a',
    ambGround: '#5f655c',
    key: '#fff4e2',
    keyIntensity: 0.6,
    window: '#fff0cf',
    windowIntensity: 0.2,
  },
  'Blush salon': {
    wallUpper: '#f1d5cc',
    wallLower: '#c89a8e',
    stripe: 0.06,
    wood: '#4d2b22',
    floorWhite: '#f2ebe3',
    floorBlack: '#201a19',
    ceiling: '#f5ece6',
    plaster: '#f6eee8',
    glassTop: '#fbf4f0',
    glassBottom: '#ffe9d2',
    brass: '#bd9147',
    ambSky: '#776760',
    ambGround: '#6a5953',
    key: '#fff0e4',
    keyIntensity: 0.6,
    window: '#ffe5c8',
    windowIntensity: 0.2,
  },
  'Midnight gallery': {
    wallUpper: '#39435c',
    wallLower: '#262c3d',
    stripe: 0.08,
    wood: '#2c1c14',
    floorWhite: '#d9d6cf',
    floorBlack: '#121212',
    ceiling: '#2d3345',
    plaster: '#3c4660',
    glassTop: '#9fb8ec',
    glassBottom: '#d9e4ff',
    brass: '#c49a4a',
    ambSky: '#4a5066',
    ambGround: '#3a3d4a',
    key: '#ffe7c7',
    keyIntensity: 0.95,
    window: '#a8c3ff',
    windowIntensity: 0.3,
  },
};

type SurfaceGroup = 'floor' | 'ceiling' | 'left' | 'right' | 'back' | 'counter';

interface WarpedMesh {
  mesh: THREE.Mesh;
  apparent: Float32Array;
}

interface GroupInfo {
  group: THREE.Group;
  /** A point on the wall and its inward normal, in apparent space. */
  plane?: { point: Vec3; normal: Vec3 };
  /** Real-space plane (recomputed on warp). */
  realPlane: THREE.Plane;
}

export class AmesRoom {
  readonly object = new THREE.Group();
  readonly uniforms: RoomUniforms = createRoomUniforms();
  readonly apparentBounds: Box3Like = {
    min: vec3(-W - 0.05, -0.05, BACK - WALL_T - 0.05),
    max: vec3(W + 0.05, H + 0.05, 0.05),
  };
  /** Apparent-space overlay for the debug view: the room the viewer thinks they see. */
  readonly wireframe: THREE.LineSegments;
  /** Real-room outline, eye marker and sight lines, shown when the camera leaves the eye point. */
  readonly diagram = new THREE.Group();
  floor!: THREE.Mesh;

  private readonly warped: WarpedMesh[] = [];
  private readonly groups = new Map<SurfaceGroup, GroupInfo>();
  private readonly materials = new Map<Kind, THREE.ShaderMaterial>();
  private readonly raycaster = new THREE.Raycaster();
  private counterKey = '';
  private readonly realOutline: THREE.LineSegments;
  private readonly apparentOutline: THREE.LineSegments;
  private readonly sightLines: THREE.LineSegments;
  private readonly eyeMarker: THREE.Group;
  private readonly diagramMaterials: (THREE.LineBasicMaterial | THREE.LineDashedMaterial | THREE.MeshBasicMaterial)[] = [];
  private warp: AmesWarp | null = null;

  constructor(style: RoomStyleName) {
    this.object.name = 'ames-room';
    this.uniforms.uEye.value.set(EYE.x, EYE.y, EYE.z);
    this.uniforms.uRoomHalfW.value = W;
    this.uniforms.uRoomH.value = H;
    this.uniforms.uRoomD.value = D;
    this.uniforms.uWinPos.value[0].set(-1.5, 1.7, BACK + 0.25);
    this.uniforms.uWinPos.value[1].set(1.5, 1.7, BACK + 0.25);
    this.setStyle(style);
    this.buildFloor();
    this.buildCeiling();
    this.buildBackWall();
    this.buildLeftWall();
    this.buildRightWall();
    this.wireframe = this.buildWireframe();
    this.realOutline = new THREE.LineSegments(new THREE.BufferGeometry(), this.diagramMat(new THREE.LineBasicMaterial({ color: 0xfff3dd })));
    this.sightLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      this.diagramMat(new THREE.LineDashedMaterial({ color: 0xffd27a, dashSize: 0.25, gapSize: 0.15 })),
    );
    this.apparentOutline = this.buildApparentOutline();
    this.eyeMarker = this.buildEyeMarker();
    this.diagram.add(this.apparentOutline, this.realOutline, this.sightLines, this.eyeMarker);
    this.diagram.renderOrder = 10;
    this.setDiagramOpacity(0);
  }

  private material(kind: Kind): THREE.ShaderMaterial {
    let m = this.materials.get(kind);
    if (!m) {
      m = createRoomMaterial(kind, this.uniforms);
      this.materials.set(kind, m);
    }
    return m;
  }

  private group(name: SurfaceGroup, plane?: { point: Vec3; normal: Vec3 }): GroupInfo {
    let info = this.groups.get(name);
    if (!info) {
      const group = new THREE.Group();
      group.name = name;
      this.object.add(group);
      info = { group, plane, realPlane: new THREE.Plane() };
      this.groups.set(name, info);
    }
    return info;
  }

  private addMesh(group: SurfaceGroup, kind: Kind, b: GeoBuilder, name: string): THREE.Mesh | null {
    if (b.empty) return null;
    const geometry = b.build();
    const mesh = new THREE.Mesh(geometry, this.material(kind));
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    this.group(group).group.add(mesh);
    this.warped.push({ mesh, apparent: geometry.userData.apparent as Float32Array });
    if (this.warp) this.warpMesh(this.warped[this.warped.length - 1], this.warp);
    return mesh;
  }

  // ---------------------------------------------------------------- surfaces

  private buildFloor(): void {
    this.group('floor', { point: vec3(0, 0, 0), normal: vec3(0, 1, 0) });
    const b = new GeoBuilder();
    const tile = 0.5;
    const nx = Math.round(ROOM.width / tile); // 12
    const nz = Math.round(ROOM.depth / tile); // 10
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const x0 = -W + i * tile;
        const z0 = -j * tile;
        const black = (i + j) % 2 === 1 ? 1 : 0;
        b.grid([x0, 0, z0], [tile, 0, 0], [0, 0, -tile], breakpoints(2), breakpoints(2), [0, 1, 0], { tint: [black, rand(), 0] });
      }
    }
    this.floor = this.addMesh('floor', Kind.Floor, b, 'floor-tiles')!;
  }

  private buildCeiling(): void {
    this.group('ceiling', { point: vec3(0, H, 0), normal: vec3(0, -1, 0) });
    const b = new GeoBuilder();
    b.grid([-W, H, 0], [ROOM.width, 0, 0], [0, 0, -D], breakpoints(30), breakpoints(25), [0, -1, 0]);
    this.addMesh('ceiling', Kind.Ceiling, b, 'ceiling');
  }

  /** Mouldings that run along a wall. `along` maps a (start, end) range to box extents. */
  private mouldings(
    wood: GeoBuilder,
    plaster: GeoBuilder,
    runs: [number, number][],
    box: (a: number, b: number, y0: number, y1: number, depth: number) => [V3, V3],
  ): void {
    for (const [a, b] of runs) {
      // Skirting board with a small cap.
      wood.box(...box(a, b, 0, LAYOUT.skirting, 0.022), { tint: [0.8, 0.8, 0.8] });
      wood.box(...box(a, b, LAYOUT.skirting, LAYOUT.skirting + 0.022, 0.03), { tint: [0.85, 0.85, 0.85] });
      // Dado (chair) rail.
      wood.box(...box(a, b, LAYOUT.dado[0], LAYOUT.dado[1], 0.028));
      wood.box(...box(a, b, LAYOUT.dado[0] - 0.018, LAYOUT.dado[0], 0.016), { tint: [0.9, 0.9, 0.9] });
    }
    const [a0, b0] = [runs[0][0], runs[runs.length - 1][1]];
    // Picture rail and a stepped plaster cornice run the full length.
    wood.box(...box(a0, b0, LAYOUT.pictureRail[0], LAYOUT.pictureRail[1], 0.022));
    plaster.box(...box(a0, b0, H - 0.2, H - 0.14, 0.03), { tint: [0.97, 0.97, 0.97] });
    plaster.box(...box(a0, b0, H - 0.14, H - 0.06, 0.07));
    plaster.box(...box(a0, b0, H - 0.06, H, 0.12), { tint: [1.02, 1.02, 1.02] });
  }

  private buildBackWall(): void {
    this.group('back', { point: vec3(0, 0, BACK), normal: vec3(0, 0, 1) });
    const wall = new GeoBuilder();
    const wood = new GeoBuilder();
    const plaster = new GeoBuilder();
    const glass = new GeoBuilder();
    const clockFace = new GeoBuilder();
    const { windows, windowY0: y0, windowY1: y1 } = LAYOUT;
    const toU = (x: number) => (x + W) / ROOM.width;
    const toV = (y: number) => y / H;
    const holes = windows.map((w) => ({ u0: toU(w.x0), u1: toU(w.x1), v0: toV(y0), v1: toV(y1) }));
    wall.grid(
      [-W, 0, BACK],
      [ROOM.width, 0, 0],
      [0, H, 0],
      breakpoints(40, holes.flatMap((h) => [h.u0, h.u1])),
      breakpoints(40, [toV(y0), toV(y1)]),
      [0, 0, 1],
      {},
      (u, v) => holes.some((h) => u > h.u0 && u < h.u1 && v > h.v0 && v < h.v1),
    );

    const zi = BACK; // inner wall surface
    const zg = BACK - 0.14; // glass plane
    for (const w of windows) {
      const ww = w.x1 - w.x0;
      const wh = y1 - y0;
      // Reveals (jambs, head and sill) in plaster.
      plaster.grid([w.x0, y0, zi], [0, 0, zg - zi], [0, wh, 0], breakpoints(2), breakpoints(10), [1, 0, 0]);
      plaster.grid([w.x1, y0, zi], [0, 0, zg - zi], [0, wh, 0], breakpoints(2), breakpoints(10), [-1, 0, 0]);
      plaster.grid([w.x0, y1, zi], [ww, 0, 0], [0, 0, zg - zi], breakpoints(8), breakpoints(2), [0, -1, 0]);
      // Glass, with its rectangle in the back wall's surface coordinates (u = x, v = y).
      glass.grid([w.x0, y0, zg], [ww, 0, 0], [0, wh, 0], breakpoints(8), breakpoints(10), [0, 0, 1], {
        extra: [w.x0, y0, ww, wh],
      });
      // Sash frame and glazing bars.
      const f = 0.055;
      const zs0 = zg - 0.01, zs1 = zg + 0.05;
      wood.box([w.x0, y0, zs0], [w.x0 + f, y1, zs1]);
      wood.box([w.x1 - f, y0, zs0], [w.x1, y1, zs1]);
      wood.box([w.x0, y1 - f, zs0], [w.x1, y1, zs1]);
      wood.box([w.x0, y0, zs0], [w.x1, y0 + f * 1.4, zs1]);
      const cx = (w.x0 + w.x1) / 2;
      wood.box([cx - 0.018, y0, zs0], [cx + 0.018, y1, zs1 - 0.01]);
      for (const yb of [y0 + wh / 3, y0 + (2 * wh) / 3]) wood.box([w.x0, yb - 0.018, zs0], [w.x1, yb + 0.018, zs1 - 0.01]);
      // Casing on the wall face, stool (sill) and head.
      wood.box([w.x0 - 0.1, y0 - 0.02, zi], [w.x0, y1 + 0.02, zi + 0.028]);
      wood.box([w.x1, y0 - 0.02, zi], [w.x1 + 0.1, y1 + 0.02, zi + 0.028]);
      wood.box([w.x0 - 0.13, y1 + 0.02, zi], [w.x1 + 0.13, y1 + 0.13, zi + 0.036]);
      wood.box([w.x0 - 0.14, y0 - 0.045, zg], [w.x1 + 0.14, y0, zi + 0.075], { tint: [1.08, 1.08, 1.08] });
    }

    // Wall clock between the windows.
    const { x: cx, y: cy, r } = LAYOUT.clock;
    clockFace.disc([cx, cy, zi + 0.045], [0, 0, 1], r, 48, { extra: [cx, cy, r, 0] });
    wood.tube([cx, cy, zi + 0.045], [0, 0, 1], r, 0.045, 32, { tint: [0.9, 0.9, 0.9], grain: 1 });

    this.mouldings(wood, plaster, [[-W, W]], (a, b, ya, yb, depth) => [
      [a, ya, zi],
      [b, yb, zi + depth],
    ]);

    this.addMesh('back', Kind.Wall, wall, 'back-wall');
    this.addMesh('back', Kind.Wood, wood, 'back-trim');
    this.addMesh('back', Kind.Plaster, plaster, 'back-plaster');
    this.addMesh('back', Kind.Glass, glass, 'back-windows');
    this.addMesh('back', Kind.Clock, clockFace, 'back-clock');
  }

  private buildLeftWall(): void {
    this.group('left', { point: vec3(-W, 0, 0), normal: vec3(1, 0, 0) });
    const wall = new GeoBuilder();
    const wood = new GeoBuilder();
    const plaster = new GeoBuilder();
    const canvas = new GeoBuilder();
    wall.grid([-W, 0, 0], [0, 0, -D], [0, H, 0], breakpoints(40), breakpoints(40), [1, 0, 0]);

    // Framed painting. On the left wall the surface u coordinate is -z.
    const p = LAYOUT.painting;
    const z0 = p.zc + p.w / 2; // nearer edge (larger z)
    const z1 = p.zc - p.w / 2;
    const yb = p.yc - p.h / 2, yt = p.yc + p.h / 2;
    const f = p.frame;
    const xw = -W;
    canvas.grid([xw + 0.018, yb, z0], [0, 0, z1 - z0], [0, p.h, 0], breakpoints(10), breakpoints(8), [1, 0, 0], {
      extra: [-z0, yb, p.w, p.h],
    });
    const gilt: VertexOpts = { tint: [1.25, 1.1, 0.8] };
    wood.box([xw, yb - f, z1 - f], [xw + 0.045, yb, z0 + f], gilt);
    wood.box([xw, yt, z1 - f], [xw + 0.045, yt + f, z0 + f], gilt);
    wood.box([xw, yb, z1 - f], [xw + 0.045, yt, z1], gilt);
    wood.box([xw, yb, z0], [xw + 0.045, yt, z0 + f], gilt);
    // Picture cords up to a hook on the picture rail.
    const hook: V3 = [xw + 0.03, LAYOUT.pictureRail[0] - 0.01, p.zc];
    wood.rod([xw + 0.03, yt + f * 0.5, z1 + 0.05], hook, 0.008, { tint: [0.5, 0.45, 0.4] });
    wood.rod([xw + 0.03, yt + f * 0.5, z0 - 0.05], hook, 0.008, { tint: [0.5, 0.45, 0.4] });

    this.mouldings(wood, plaster, [[0, -D]], (a, b, ya, yb2, depth) => [
      [xw, ya, Math.min(a, b)],
      [xw + depth, yb2, Math.max(a, b)],
    ]);

    this.addMesh('left', Kind.Wall, wall, 'left-wall');
    this.addMesh('left', Kind.Wood, wood, 'left-trim');
    this.addMesh('left', Kind.Plaster, plaster, 'left-plaster');
    this.addMesh('left', Kind.Painting, canvas, 'left-painting');
  }

  private buildRightWall(): void {
    this.group('right', { point: vec3(W, 0, 0), normal: vec3(-1, 0, 0) });
    const wall = new GeoBuilder();
    const wood = new GeoBuilder();
    const plaster = new GeoBuilder();
    const door = new GeoBuilder();
    const brass = new GeoBuilder();
    wall.grid([W, 0, 0], [0, 0, -D], [0, H, 0], breakpoints(40), breakpoints(40), [-1, 0, 0]);

    const d = LAYOUT.door;
    const xw = W;
    const leaf0 = xw - 0.026;
    // Door leaf: the face towards the room carries the panel pattern (u = z on this wall).
    door.grid([leaf0, 0, d.z0], [0, 0, d.z1 - d.z0], [0, d.y1, 0], breakpoints(6), breakpoints(12), [-1, 0, 0], {
      extra: [d.z0, 0, d.z1 - d.z0, d.y1],
    });
    wood.box([leaf0, 0, d.z0], [xw, d.y1, d.z1], {}, 'pypz nz');
    // Casing.
    wood.box([xw - 0.034, 0, d.z0 - 0.1], [xw, d.y1, d.z0]);
    wood.box([xw - 0.034, 0, d.z1], [xw, d.y1, d.z1 + 0.1]);
    wood.box([xw - 0.04, d.y1, d.z0 - 0.12], [xw, d.y1 + 0.12, d.z1 + 0.12]);
    // Knob and rose.
    const kz = d.z1 - 0.09;
    brass.sphere([leaf0 - 0.055, 1.0, kz], 0.034);
    brass.box([leaf0 - 0.022, 0.96, kz - 0.035], [leaf0, 1.04, kz + 0.035]);
    brass.box([leaf0 - 0.006, 0.84, kz - 0.022], [leaf0, 0.92, kz + 0.022]);

    this.mouldings(
      wood,
      plaster,
      [
        [BACK, d.z0 - 0.1],
        [d.z1 + 0.1, 0],
      ],
      (a, b, ya, yb, depth) => [
        [xw - depth, ya, Math.min(a, b)],
        [xw, yb, Math.max(a, b)],
      ],
    );

    this.addMesh('right', Kind.Wall, wall, 'right-wall');
    this.addMesh('right', Kind.Wood, wood, 'right-trim');
    this.addMesh('right', Kind.Plaster, plaster, 'right-plaster');
    this.addMesh('right', Kind.Door, door, 'right-door');
    this.addMesh('right', Kind.Brass, brass, 'right-knob');
  }

  /**
   * The waist-high counter for upper-body mode, along the back wall in front of
   * the walking line. Rebuilt only when its dimensions change.
   */
  setCounter(visible: boolean, height: number, walkDepth: number): void {
    const key = `${height.toFixed(3)}|${walkDepth.toFixed(3)}`;
    const info = this.group('counter', { point: vec3(0, 0, 0), normal: vec3(0, 1, 0) });
    if (key !== this.counterKey) {
      this.counterKey = key;
      for (const child of [...info.group.children]) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        info.group.remove(mesh);
        const i = this.warped.findIndex((w) => w.mesh === mesh);
        if (i >= 0) this.warped.splice(i, 1);
      }
      const wood = new GeoBuilder();
      const { zBack, zFront } = counterDepth(walkDepth);
      wood.box([-W, height - 0.045, zBack - 0.03], [W, height, zFront + 0.045], { tint: [1.12, 1.12, 1.12] }, 'pypznzpx nx', 0.25);
      wood.box([-W, 0.09, zBack], [W, height - 0.045, zFront], { tint: [0.82, 0.82, 0.82] }, 'pzpx nx', 0.25);
      wood.box([-W, 0, zBack + 0.03], [W, 0.09, zFront - 0.03], { tint: [0.5, 0.5, 0.5] }, 'pzpy', 0.25);
      for (let x = -W + 0.375; x < W; x += 0.75) {
        wood.box([x - 0.035, 0.09, zFront], [x + 0.035, height - 0.045, zFront + 0.014], { tint: [0.95, 0.95, 0.95] }, 'pzpxnx');
      }
      wood.box([-W, height - 0.11, zFront], [W, height - 0.045, zFront + 0.02], { tint: [0.9, 0.9, 0.9] }, 'pzny', 0.25);
      this.addMesh('counter', Kind.Wood, wood, 'counter');
    }
    info.group.visible = visible;
  }

  // ---------------------------------------------------------------- overlays

  private buildWireframe(): THREE.LineSegments {
    const v: number[] = [];
    const seg = (a: V3, b: V3) => v.push(...a, ...b);
    const e = 0.002;
    // Room box.
    const xs = [-W, W], ys = [0, H], zs = [0, BACK];
    for (const y of ys) for (const z of zs) seg([-W, y, z], [W, y, z]);
    for (const x of xs) for (const z of zs) seg([x, 0, z], [x, H, z]);
    for (const x of xs) for (const y of ys) seg([x, y, 0], [x, y, BACK]);
    // Floor tile grid.
    for (let x = -W; x <= W + 1e-6; x += 0.5) seg([x, e, 0], [x, e, BACK]);
    for (let z = 0; z >= BACK - 1e-6; z -= 0.5) seg([-W, e, z], [W, e, z]);
    // Windows, door, painting, dado rails.
    for (const w of LAYOUT.windows) {
      const z = BACK + e;
      seg([w.x0, LAYOUT.windowY0, z], [w.x1, LAYOUT.windowY0, z]);
      seg([w.x0, LAYOUT.windowY1, z], [w.x1, LAYOUT.windowY1, z]);
      seg([w.x0, LAYOUT.windowY0, z], [w.x0, LAYOUT.windowY1, z]);
      seg([w.x1, LAYOUT.windowY0, z], [w.x1, LAYOUT.windowY1, z]);
    }
    const d = LAYOUT.door;
    seg([W - e, 0, d.z0], [W - e, d.y1, d.z0]);
    seg([W - e, 0, d.z1], [W - e, d.y1, d.z1]);
    seg([W - e, d.y1, d.z0], [W - e, d.y1, d.z1]);
    const p = LAYOUT.painting;
    const pz0 = p.zc + p.w / 2, pz1 = p.zc - p.w / 2, pyb = p.yc - p.h / 2, pyt = p.yc + p.h / 2;
    seg([-W + e, pyb, pz0], [-W + e, pyb, pz1]);
    seg([-W + e, pyt, pz0], [-W + e, pyt, pz1]);
    seg([-W + e, pyb, pz0], [-W + e, pyt, pz0]);
    seg([-W + e, pyb, pz1], [-W + e, pyt, pz1]);
    const yd = LAYOUT.dado[1];
    seg([-W + e, yd, 0], [-W + e, yd, BACK]);
    seg([-W, yd, BACK + e], [W, yd, BACK + e]);
    seg([W - e, yd, BACK], [W - e, yd, 0]);
    const c = LAYOUT.clock;
    for (let i = 0; i < 32; i++) {
      const a0 = (i / 32) * Math.PI * 2, a1 = ((i + 1) / 32) * Math.PI * 2;
      seg([c.x + Math.cos(a0) * c.r, c.y + Math.sin(a0) * c.r, BACK + 0.046], [c.x + Math.cos(a1) * c.r, c.y + Math.sin(a1) * c.r, BACK + 0.046]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    const lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ color: 0x35e4ff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
    );
    lines.name = 'apparent-wireframe';
    lines.renderOrder = 1000;
    lines.frustumCulled = false;
    lines.visible = false;
    return lines;
  }

  private diagramMat<T extends THREE.LineBasicMaterial | THREE.LineDashedMaterial | THREE.MeshBasicMaterial>(m: T): T {
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    this.diagramMaterials.push(m);
    return m;
  }

  /** The room the viewer believes in (floor plan and back wall), drawn dashed next to the real one. */
  private buildApparentOutline(): THREE.LineSegments {
    const v: number[] = [];
    const seg = (a: V3, b: V3) => v.push(...a, ...b);
    seg([-W, 0, 0], [W, 0, 0]);
    seg([-W, 0, BACK], [W, 0, BACK]);
    seg([-W, 0, 0], [-W, 0, BACK]);
    seg([W, 0, 0], [W, 0, BACK]);
    seg([-W, H, BACK], [W, H, BACK]);
    seg([-W, 0, BACK], [-W, H, BACK]);
    seg([W, 0, BACK], [W, H, BACK]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    const lines = new THREE.LineSegments(g, this.diagramMat(new THREE.LineDashedMaterial({ color: 0x35e4ff, dashSize: 0.12, gapSize: 0.1 })));
    lines.computeLineDistances();
    lines.name = 'apparent-outline';
    return lines;
  }

  private buildEyeMarker(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'eye-marker';
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 20, 12), this.diagramMat(new THREE.MeshBasicMaterial({ color: 0xffd27a })));
    dot.position.set(EYE.x, EYE.y, EYE.z);
    g.add(dot);
    return g;
  }

  /** `eyeOpacity` lets the eye marker wait until the camera is well away from it. */
  setDiagramOpacity(opacity: number, eyeOpacity = opacity): void {
    this.diagram.visible = opacity > 0.001;
    for (const m of this.diagramMaterials) m.opacity = opacity * (m instanceof THREE.LineDashedMaterial ? 0.9 : 0.8);
    this.eyeMarker.visible = eyeOpacity > 0.01;
    this.eyeMarker.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (mat) mat.opacity = eyeOpacity * 0.9;
    });
  }

  // ---------------------------------------------------------------- warp

  private warpMesh(w: WarpedMesh, warp: AmesWarp): void {
    const attr = w.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    warp.forwardArray(w.apparent, attr.array as Float32Array);
    attr.needsUpdate = true;
    w.mesh.geometry.computeBoundingSphere();
    w.mesh.geometry.computeBoundingBox();
  }

  applyWarp(warp: AmesWarp): void {
    this.warp = warp;
    this.uniforms.uW.value.set(warp.w.x, warp.w.y, warp.w.z);
    this.uniforms.uEye.value.set(warp.E.x, warp.E.y, warp.E.z);
    for (const w of this.warped) this.warpMesh(w, warp);
    for (const info of this.groups.values()) {
      if (!info.plane) continue;
      const { point: p, normal: n } = info.plane;
      // Three non-collinear points on the apparent plane, warped.
      const t = Math.abs(n.y) > 0.5 ? vec3(1, 0, 0) : vec3(0, 1, 0);
      const s = vec3(n.y * t.z - n.z * t.y, n.z * t.x - n.x * t.z, n.x * t.y - n.y * t.x);
      const a = warp.forward(p);
      const b = warp.forward(vec3(p.x + t.x, p.y + t.y, p.z + t.z));
      const c = warp.forward(vec3(p.x + s.x, p.y + s.y, p.z + s.z));
      info.realPlane.setFromCoplanarPoints(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z), new THREE.Vector3(c.x, c.y, c.z));
      // Orient the plane so the eye (always inside the room) is on its positive side.
      if (info.realPlane.distanceToPoint(new THREE.Vector3(warp.E.x, warp.E.y, warp.E.z)) < 0) info.realPlane.negate();
    }
    this.updateDiagram(warp);
  }

  private updateDiagram(warp: AmesWarp): void {
    const edges: number[] = [];
    const corner = (x: number, y: number, z: number) => {
      const r = warp.forward(vec3(x, y, z));
      return [r.x, r.y, r.z] as V3;
    };
    const push = (a: V3, b: V3) => edges.push(...a, ...b);
    for (const y of [0, H]) for (const z of [0, BACK]) push(corner(-W, y, z), corner(W, y, z));
    for (const x of [-W, W]) for (const z of [0, BACK]) push(corner(x, 0, z), corner(x, H, z));
    for (const x of [-W, W]) for (const y of [0, H]) push(corner(x, y, 0), corner(x, y, BACK));
    this.realOutline.geometry.dispose();
    this.realOutline.geometry = new THREE.BufferGeometry();
    this.realOutline.geometry.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));

    // Sight lines from the eye through the apparent back corners to the real ones.
    const e: V3 = [warp.E.x, warp.E.y, warp.E.z];
    const rays: number[] = [];
    for (const x of [-W, W]) for (const y of [0, H]) rays.push(...e, ...corner(x, y, BACK));
    this.sightLines.geometry.dispose();
    this.sightLines.geometry = new THREE.BufferGeometry();
    this.sightLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(rays, 3));
    this.sightLines.computeLineDistances();
  }

  /** Dollhouse cutaway: hide any wall (with its trim) whose inside the camera can't see. */
  updateCutaway(cameraPos: THREE.Vector3): void {
    for (const [name, info] of this.groups) {
      if (name === 'floor' || name === 'counter') continue;
      info.group.visible = info.realPlane.distanceToPoint(cameraPos) > -1e-3;
    }
  }

  /** Real floor height below a real (x, z) point, by raycasting the warped floor mesh. */
  floorHeightAt(x: number, z: number, fallbackY: number): number {
    this.raycaster.set(new THREE.Vector3(x, 1000, z), new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 3000;
    const hit = this.raycaster.intersectObject(this.floor, false)[0];
    return hit ? hit.point.y : fallbackY;
  }

  setStyle(name: RoomStyleName): void {
    const s = ROOM_STYLES[name] ?? ROOM_STYLES['Vintage museum'];
    const u = this.uniforms;
    u.uWallUpper.value.set(s.wallUpper);
    u.uWallLower.value.set(s.wallLower);
    u.uStripe.value = s.stripe;
    u.uWood.value.set(s.wood);
    u.uFloorWhite.value.set(s.floorWhite);
    u.uFloorBlack.value.set(s.floorBlack);
    u.uCeiling.value.set(s.ceiling);
    u.uPlaster.value.set(s.plaster);
    u.uGlassTop.value.set(s.glassTop).multiplyScalar(1.6);
    u.uGlassBottom.value.set(s.glassBottom).multiplyScalar(1.6);
    u.uBrass.value.set(s.brass);
    u.uAmbSky.value.set(s.ambSky);
    u.uAmbGround.value.set(s.ambGround);
    u.uKeyColor.value.set(s.key).multiplyScalar(s.keyIntensity);
    u.uWinColor.value.set(s.window).multiplyScalar(s.windowIntensity);
  }

  /** Every warped mesh with its apparent positions (for the startup alignment check). */
  warpedMeshes(): readonly WarpedMesh[] {
    return this.warped;
  }

  setClock(date: Date): void {
    this.uniforms.uClock.value.set(date.getHours(), date.getMinutes() + date.getSeconds() / 60);
  }
}

/** Counter footprint (apparent z) in front of the walking line. */
export function counterDepth(walkDepth: number): { zBack: number; zFront: number } {
  const zWalk = BACK + walkDepth;
  return { zBack: zWalk + 0.32, zFront: zWalk + 0.78 };
}
