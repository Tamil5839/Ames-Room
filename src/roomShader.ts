import * as THREE from 'three';

/**
 * Shading for every room surface.
 *
 * The vertex positions are the REAL (warped) positions. The fragment shader
 * inverts the warp analytically to recover the exact APPARENT position of each
 * fragment, and computes all patterns, lighting and ambient occlusion from that.
 * Because the warp is projective and every surface is planar, this is exact at
 * any mesh resolution: from the hero eye every pixel matches the rectangular
 * room, and from anywhere else the "paint" sits on the warped walls exactly like
 * the painted surfaces of a real Ames room.
 */

export const Kind = {
  Floor: 1,
  Wall: 2,
  Ceiling: 3,
  Wood: 4,
  Plaster: 5,
  Glass: 6,
  Painting: 7,
  Door: 8,
  Brass: 9,
  Clock: 10,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export interface RoomUniforms {
  [name: string]: THREE.IUniform;
  uEye: THREE.IUniform<THREE.Vector3>;
  uW: THREE.IUniform<THREE.Vector3>;
  uAmbSky: THREE.IUniform<THREE.Color>;
  uAmbGround: THREE.IUniform<THREE.Color>;
  uKeyPos: THREE.IUniform<THREE.Vector3>;
  uKeyColor: THREE.IUniform<THREE.Color>;
  uWinPos: THREE.IUniform<THREE.Vector3[]>;
  uWinColor: THREE.IUniform<THREE.Color>;
  uAO: THREE.IUniform<THREE.Vector2>;
  uCasterPos: THREE.IUniform<THREE.Vector4[]>;
  uCasterAxis: THREE.IUniform<THREE.Vector4[]>;
  uWallShadow: THREE.IUniform<THREE.Vector4[]>;
  uWallShadowK: THREE.IUniform<number[]>;
  uWallUpper: THREE.IUniform<THREE.Color>;
  uWallLower: THREE.IUniform<THREE.Color>;
  uStripe: THREE.IUniform<number>;
  uWood: THREE.IUniform<THREE.Color>;
  uFloorWhite: THREE.IUniform<THREE.Color>;
  uFloorBlack: THREE.IUniform<THREE.Color>;
  uCeiling: THREE.IUniform<THREE.Color>;
  uPlaster: THREE.IUniform<THREE.Color>;
  uGlassTop: THREE.IUniform<THREE.Color>;
  uGlassBottom: THREE.IUniform<THREE.Color>;
  uBrass: THREE.IUniform<THREE.Color>;
  uClock: THREE.IUniform<THREE.Vector2>;
  uRoomHalfW: THREE.IUniform<number>;
  uRoomH: THREE.IUniform<number>;
  uRoomD: THREE.IUniform<number>;
}

export function createRoomUniforms(): RoomUniforms {
  return {
    uEye: { value: new THREE.Vector3() },
    uW: { value: new THREE.Vector3() },
    uAmbSky: { value: new THREE.Color() },
    uAmbGround: { value: new THREE.Color() },
    uKeyPos: { value: new THREE.Vector3(0.9, 3.4, 2.2) },
    uKeyColor: { value: new THREE.Color() },
    uWinPos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uWinColor: { value: new THREE.Color() },
    uAO: { value: new THREE.Vector2(0.42, 0.32) },
    uCasterPos: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uCasterAxis: { value: [new THREE.Vector4(1, 0, 0.3, 0.2), new THREE.Vector4(1, 0, 0.3, 0.2)] },
    uWallShadow: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uWallShadowK: { value: [0, 0] },
    uWallUpper: { value: new THREE.Color() },
    uWallLower: { value: new THREE.Color() },
    uStripe: { value: 0.04 },
    uWood: { value: new THREE.Color() },
    uFloorWhite: { value: new THREE.Color() },
    uFloorBlack: { value: new THREE.Color() },
    uCeiling: { value: new THREE.Color() },
    uPlaster: { value: new THREE.Color() },
    uGlassTop: { value: new THREE.Color() },
    uGlassBottom: { value: new THREE.Color() },
    uBrass: { value: new THREE.Color() },
    uClock: { value: new THREE.Vector2(10, 10) },
    uRoomHalfW: { value: 3 },
    uRoomH: { value: 3 },
    uRoomD: { value: 5 },
  };
}

const vertexShader = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aExtra;
attribute float aGrain;
varying vec3 vWorld;
varying vec3 vNormalApp;
varying vec3 vTint;
varying vec4 vExtra;
varying float vGrain;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // The normal attribute holds the APPARENT-space normal: lighting is computed in apparent space.
  vNormalApp = normal;
  vTint = aColor;
  vExtra = aExtra;
  vGrain = aGrain;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uEye;
uniform vec3 uW;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uKeyPos;
uniform vec3 uKeyColor;
uniform vec3 uWinPos[2];
uniform vec3 uWinColor;
uniform vec2 uAO;
uniform vec4 uCasterPos[2];
uniform vec4 uCasterAxis[2];
uniform vec4 uWallShadow[2];
uniform float uWallShadowK[2];
uniform vec3 uWallUpper;
uniform vec3 uWallLower;
uniform float uStripe;
uniform vec3 uWood;
uniform vec3 uFloorWhite;
uniform vec3 uFloorBlack;
uniform vec3 uCeiling;
uniform vec3 uPlaster;
uniform vec3 uGlassTop;
uniform vec3 uGlassBottom;
uniform vec3 uBrass;
uniform vec2 uClock;
uniform float uRoomHalfW;
uniform float uRoomH;
uniform float uRoomD;

varying vec3 vWorld;
varying vec3 vNormalApp;
varying vec3 vTint;
varying vec4 vExtra;
varying float vGrain;

// ---------------------------------------------------------------- helpers
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
// Anti-aliased line: 1 on a line of half-width w (in the units of x) repeating every period.
float gridLine(float x, float period, float w) {
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  float fw = max(fwidth(x), 1e-5);
  return 1.0 - smoothstep(w - fw, w + fw, d);
}
float boxMask(vec2 p, vec2 lo, vec2 hi) {
  vec2 fw = max(fwidth(p), vec2(1e-5));
  vec2 a = smoothstep(lo - fw, lo + fw, p) * (1.0 - smoothstep(hi - fw, hi + fw, p));
  return a.x * a.y;
}

// Real → apparent: X = X' / (1 - w·X'). Exact for every fragment.
vec3 apparentPos(vec3 realPos) {
  vec3 X = realPos - uEye;
  return uEye + X / (1.0 - dot(uW, X));
}

// 2D surface coordinates: u runs to the viewer's right when facing the surface, v up.
vec2 surfaceUV(vec3 P, vec3 N) {
  if (abs(N.y) > 0.7) return vec2(P.x, -P.z);
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), N));
  return vec2(dot(P, t), P.y);
}

// ---------------------------------------------------------------- lighting (apparent space)
vec3 lighting(vec3 P, vec3 N) {
  vec3 amb = mix(uAmbGround, uAmbSky, 0.5 + 0.5 * N.y);
  vec3 L = uKeyPos - P;
  float d = length(L);
  L /= d;
  float ndl = max(dot(N, L) * 0.75 + 0.25, 0.0);
  float fall = 1.0 / (1.0 + 0.0085 * d * d);
  vec3 col = amb + uKeyColor * ndl * fall;
  for (int i = 0; i < 2; i++) {
    vec3 Lw = uWinPos[i] - P;
    float dw = length(Lw);
    Lw /= dw;
    float ndlw = max(dot(N, Lw) * 0.85 + 0.15, 0.0);
    float front = smoothstep(-0.05, 0.4, -Lw.z); // windows only light what is in front of them
    col += uWinColor * ndlw * front / (1.0 + dw * dw * 0.5);
  }
  return col;
}

float boxAO(vec3 P, vec3 N) {
  float k = uAO.x, r = uAO.y;
  float ao = 1.0;
  ao *= 1.0 - k * (1.0 - abs(N.x)) * exp(-max(P.x + uRoomHalfW, 0.0) / r);
  ao *= 1.0 - k * (1.0 - abs(N.x)) * exp(-max(uRoomHalfW - P.x, 0.0) / r);
  ao *= 1.0 - k * (1.0 - abs(N.y)) * exp(-max(P.y, 0.0) / r);
  ao *= 1.0 - k * 0.8 * (1.0 - abs(N.y)) * exp(-max(uRoomH - P.y, 0.0) / r);
  ao *= 1.0 - k * (1.0 - abs(N.z)) * exp(-max(P.z + uRoomD, 0.0) / r);
  return ao;
}

// Soft contact shadows under the people, measured in REAL space around their real feet.
float contactShadow(vec3 R) {
  float sh = 1.0;
  for (int i = 0; i < 2; i++) {
    vec4 c = uCasterPos[i];
    if (c.w <= 0.0) continue;
    vec4 ax = uCasterAxis[i];
    vec3 d = R - c.xyz;
    vec2 a = vec2(ax.x, ax.y);
    vec2 b = vec2(-ax.y, ax.x);
    float u = dot(d.xz, a) / ax.z;
    float v = dot(d.xz, b) / ax.w;
    float e = u * u + v * v;
    float vertical = exp(-d.y * d.y / 0.02);
    sh *= 1.0 - c.w * vertical * (0.55 * exp(-e * 2.2) + 0.45 * exp(-e * 9.0));
  }
  return sh;
}

// Soft shadow of each person on the back wall, cast by the key light in APPARENT space.
float wallShadow(vec3 P) {
  float sh = 1.0;
  float wallZ = -uRoomD;
  for (int i = 0; i < 2; i++) {
    float k = uWallShadowK[i];
    if (k <= 0.0) continue;
    vec4 s = uWallShadow[i]; // apparent foot x, apparent foot z, apparent height, apparent half width
    vec3 feet = vec3(s.x, 0.0, s.y);
    float t = (wallZ - uKeyPos.z) / (feet.z - uKeyPos.z);
    vec2 a = uKeyPos.xy + (feet.xy - uKeyPos.xy) * t;
    vec2 b = uKeyPos.xy + (vec2(feet.x, s.z * 0.93) - uKeyPos.xy) * t;
    vec2 pa = P.xy - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float dist = length(pa - ba * h);
    float radius = s.w * t;
    float soft = radius * 0.9 + 0.08;
    sh *= 1.0 - k * (1.0 - smoothstep(radius - soft, radius + soft, dist));
  }
  return sh;
}

// ---------------------------------------------------------------- materials
vec3 woodColor(vec3 P, float axis) {
  vec3 q = axis < 0.5 ? P.yzx : (axis < 1.5 ? P.xzy : P.xyz);
  float n = fbm(vec3(q.x * 26.0, q.y * 26.0, q.z * 1.6));
  float streak = sin((q.x * 0.7 + q.y) * 130.0 + n * 9.0) * 0.5 + 0.5;
  float g = 0.8 + 0.22 * n + 0.1 * streak;
  return uWood * g;
}

vec3 paintingColor(vec2 uv) {
  // A small pastoral landscape, varnished.
  vec3 sky = mix(vec3(0.95, 0.78, 0.52), vec3(0.42, 0.55, 0.72), smoothstep(0.35, 1.0, uv.y));
  float sun = smoothstep(0.075, 0.06, length((uv - vec2(0.72, 0.64)) * vec2(1.4, 1.0)));
  sky = mix(sky, vec3(1.0, 0.9, 0.62), sun);
  float cloud = smoothstep(0.55, 0.8, fbm(vec3(uv * vec2(6.0, 14.0), 2.0))) * smoothstep(0.55, 0.85, uv.y);
  sky = mix(sky, vec3(0.97, 0.9, 0.82), cloud * 0.6);
  vec3 col = sky;
  float hills = 0.44 + 0.06 * sin(uv.x * 7.0 + 1.3) + 0.03 * sin(uv.x * 17.0);
  col = mix(col, vec3(0.36, 0.44, 0.52), smoothstep(hills + 0.004, hills - 0.004, uv.y));
  float field = 0.32 + 0.05 * sin(uv.x * 4.0 - 0.6);
  vec3 grass = mix(vec3(0.28, 0.36, 0.16), vec3(0.5, 0.52, 0.22), fbm(vec3(uv * 18.0, 1.0)));
  col = mix(col, grass, smoothstep(field + 0.004, field - 0.004, uv.y));
  // Tree
  float trunk = boxMask(uv, vec2(0.265, 0.2), vec2(0.285, 0.46));
  float crown = smoothstep(0.13, 0.11, length((uv - vec2(0.275, 0.55)) * vec2(1.0, 1.25)) + 0.03 * fbm(vec3(uv * 30.0, 3.0)));
  col = mix(col, vec3(0.2, 0.14, 0.09), trunk);
  col = mix(col, vec3(0.16, 0.24, 0.12) * (0.8 + 0.4 * fbm(vec3(uv * 40.0, 5.0))), crown);
  // Varnish, craquelure-ish texture and dark edges
  col *= vec3(1.0, 0.93, 0.78);
  col *= 0.92 + 0.08 * fbm(vec3(uv * 90.0, 7.0));
  vec2 e = min(uv, 1.0 - uv);
  col *= smoothstep(0.0, 0.18, min(e.x * 1.3, e.y));
  return col * 0.9;
}

vec3 doorColor(vec3 P, vec2 uv, vec3 N) {
  vec3 col = woodColor(P, 1.0) * 0.92;
  // uv in metres from the door's lower-left corner; vExtra.zw = size
  vec2 size = vExtra.zw;
  float shade = 0.0;
  // Two columns x two rows of raised panels.
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 2; j++) {
      float fi = float(i), fj = float(j);
      vec2 lo = vec2(0.12 + fi * (size.x - 0.12) * 0.5, j == 0 ? 0.16 : size.y * 0.47);
      vec2 hi = vec2(lo.x + (size.x - 0.36) * 0.5, j == 0 ? size.y * 0.41 : size.y - 0.14);
      float outer = boxMask(uv, lo, hi);
      float inner = boxMask(uv, lo + 0.045, hi - 0.045);
      float bevel = outer - inner;
      // Bevel lit from above-front: top bevels bright, bottom dark.
      float up = step(0.5, (uv.y - lo.y) / (hi.y - lo.y));
      shade += bevel * mix(-0.22, 0.16, up);
      shade += outer * 0.03;
    }
  }
  return col * (1.0 + shade);
}

vec3 clockColor(vec2 uv) {
  vec2 c = vExtra.xy;
  float R = vExtra.z;
  vec2 p = (uv - c) / R;
  float r = length(p);
  vec3 face = vec3(0.93, 0.9, 0.82);
  vec3 col = face;
  float ang = atan(p.x, p.y);
  // Hour ticks.
  float tickA = abs(fract(ang / 6.2831853 * 12.0 + 0.5) - 0.5) * 6.2831853 / 12.0 * r;
  float tick = (1.0 - smoothstep(0.018, 0.03, tickA)) * smoothstep(0.7, 0.72, r) * (1.0 - smoothstep(0.84, 0.86, r));
  col = mix(col, vec3(0.08), tick);
  // Hands.
  float hA = 6.2831853 * (mod(uClock.x, 12.0) + uClock.y / 60.0) / 12.0;
  float mA = 6.2831853 * uClock.y / 60.0;
  vec2 hd = vec2(sin(hA), cos(hA));
  vec2 md = vec2(sin(mA), cos(mA));
  float hh = abs(dot(p, vec2(hd.y, -hd.x)));
  float mh = abs(dot(p, vec2(md.y, -md.x)));
  float hs = dot(p, hd), ms = dot(p, md);
  float hand = max((1.0 - smoothstep(0.03, 0.045, hh)) * step(-0.08, hs) * step(hs, 0.45),
                   (1.0 - smoothstep(0.018, 0.03, mh)) * step(-0.1, ms) * step(ms, 0.68));
  col = mix(col, vec3(0.06), hand);
  col = mix(col, vec3(0.06), 1.0 - smoothstep(0.03, 0.05, r));
  // Brass bezel.
  float ring = smoothstep(0.88, 0.9, r);
  col = mix(col, uBrass * (0.7 + 0.5 * smoothstep(0.9, 1.0, r)), ring);
  return col;
}

void main() {
  vec3 P = apparentPos(vWorld);
  vec3 N = normalize(vNormalApp);
  vec2 uv = surfaceUV(P, N);
  vec3 albedo = vec3(1.0);
  vec3 emissive = vec3(0.0);
  float receiveContact = 0.0;
  float receiveWall = 0.0;

#if KIND == 1
  // Floor tile: vTint.x = 0 (white) / 1 (black), vTint.y = per-tile variation.
  vec3 base = mix(uFloorWhite, uFloorBlack, vTint.x) * (0.94 + 0.12 * vTint.y);
  float marble = fbm(vec3(P.x * 3.0, P.z * 3.0, vTint.y * 10.0));
  float vein = smoothstep(0.02, 0.0, abs(fbm(vec3(P.x * 1.8 + 3.0, P.z * 1.8, vTint.y * 7.0)) - 0.5));
  base *= 0.93 + 0.1 * marble;
  base = mix(base, base * (vTint.x > 0.5 ? 1.35 : 0.86), vein * 0.35);
  float grout = max(gridLine(P.x, 0.5, 0.004), gridLine(P.z, 0.5, 0.004));
  albedo = mix(base, vec3(0.34, 0.31, 0.27), grout * 0.75);
  receiveContact = 1.0;
#elif KIND == 2
  // Wall: striped paper above the dado rail, painted panelling below.
  float dado = 0.92;
  float stripes = smoothstep(0.35, 0.65, abs(fract(uv.x / 0.16) - 0.5) * 2.0);
  vec3 upper = uWallUpper * (1.0 + uStripe * (stripes - 0.5));
  // Tiny motifs in every other stripe.
  vec2 cell = vec2(fract(uv.x / 0.32), fract(uv.y / 0.32 + 0.5 * floor(uv.x / 0.32)));
  float dot_ = 1.0 - smoothstep(0.02, 0.035, length((cell - 0.5) * vec2(1.0, 0.7)));
  upper *= 1.0 - dot_ * uStripe * 1.4;
  vec3 lower = uWallLower;
  float px = fract((uv.x + 0.06) / 0.75);
  float panel = boxMask(vec2(px * 0.75, uv.y), vec2(0.07, 0.24), vec2(0.68, dado - 0.1));
  float panelIn = boxMask(vec2(px * 0.75, uv.y), vec2(0.09, 0.26), vec2(0.66, dado - 0.12));
  lower *= 1.0 - 0.1 * (panel - panelIn) + 0.02 * panelIn;
  albedo = uv.y > dado ? upper : lower;
  albedo *= 0.97 + 0.05 * fbm(vec3(P * 5.0));
  receiveWall = abs(N.z) > 0.7 ? 1.0 : 0.0;
#elif KIND == 3
  float beams = max(gridLine(P.x, 1.0, 0.012), gridLine(P.z, 1.0, 0.012));
  albedo = uCeiling * (1.0 - 0.07 * beams) * (0.97 + 0.04 * fbm(vec3(P * 3.0)));
#elif KIND == 4
  albedo = woodColor(P, vGrain) * vTint;
  receiveWall = abs(N.z) > 0.7 ? 1.0 : 0.0;
  receiveContact = N.y > 0.7 ? 1.0 : 0.0;
#elif KIND == 5
  albedo = uPlaster * vTint;
#elif KIND == 6
  // Window glass: bright daylight, a hint of garden low in the panes.
  vec2 wuv = (uv - vExtra.xy) / vExtra.zw;
  vec3 sky = mix(uGlassBottom, uGlassTop, smoothstep(0.1, 0.95, wuv.y));
  float garden = smoothstep(0.3, 0.2, wuv.y + 0.05 * fbm(vec3(wuv * 12.0, 4.0)));
  sky = mix(sky, uGlassBottom * vec3(0.72, 0.82, 0.62), garden * 0.45);
  albedo = vec3(0.0);
  emissive = sky * (0.95 + 0.05 * fbm(vec3(wuv * 30.0, 1.0)));
#elif KIND == 7
  vec2 puv = (uv - vExtra.xy) / vExtra.zw;
  albedo = paintingColor(puv);
#elif KIND == 8
  albedo = doorColor(P, uv - vExtra.xy, N) * vTint;
#elif KIND == 9
  vec3 V = normalize(uKeyPos - P);
  float spec = pow(max(dot(N, V), 0.0), 18.0);
  albedo = uBrass * (0.55 + 0.25 * N.y);
  emissive = uBrass * spec * 0.45;
#elif KIND == 10
  albedo = clockColor(uv);
  receiveWall = 1.0;
#endif

  vec3 col = albedo * lighting(P, N) * boxAO(P, N) + emissive;
  if (receiveContact > 0.0) col *= contactShadow(vWorld);
  if (receiveWall > 0.0) col *= wallShadow(P);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createRoomMaterial(kind: Kind, uniforms: RoomUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: `room-kind-${kind}`,
    uniforms,
    vertexShader,
    fragmentShader,
    defines: { KIND: kind },
    side: THREE.FrontSide,
  });
}
