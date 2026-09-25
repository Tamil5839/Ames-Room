import type { Vec3 } from './warp';

/**
 * The apparent room: what the viewer THINKS they see from the hero eye point.
 * x ∈ [-3, 3] (6 m wide), y ∈ [0, 3] (3 m tall), z ∈ [-5, 0] (5 m deep). The front
 * opening is the plane z = 0 and the camera looks down -z.
 */
export const ROOM = { width: 6, height: 3, depth: 5 } as const;
export const HALF_W = ROOM.width / 2;

/** Hero eye point E, 0.6 m in front of the opening at roughly mid-room height. */
export const EYE: Vec3 = { x: 0, y: 1.45, z: 0.6 };

/** The back corners that the two warp factors refer to (the whole vertical edge shares the factor). */
export const BACK_LEFT: Vec3 = { x: -HALF_W, y: 0, z: -ROOM.depth };
export const BACK_RIGHT: Vec3 = { x: HALF_W, y: 0, z: -ROOM.depth };

/** Hero framing: minimum vertical FOV in landscape, and the half-width that must fit at the walking line. */
export const HERO_MIN_VFOV_DEG = 52;
export const HERO_HALF_WIDTH_AT_WALK = 3.2;

export type AspectPreset = 'fill' | '16:9' | '9:16' | '1:1';
export type BodyMode = 'auto' | 'full' | 'upper';
export type RoomStyleName = 'Vintage museum' | 'Mint parlour' | 'Blush salon' | 'Midnight gallery';
export type SegModel = 'selfie' | 'multiclass (16 MB)';

export const RECORD_SIZES: Record<Exclude<AspectPreset, 'fill'>, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};

export interface Settings {
  // Warp
  leftFactor: number;
  rightFactor: number;
  // Me
  personHeight: number;
  mirror: boolean;
  bodyMode: BodyMode;
  lockScale: boolean;
  counterHeight: number;
  // Mask
  maskFeather: number;
  maskErode: number;
  maskSmoothing: number;
  segModel: SegModel;
  // Walking
  walkDepth: number;
  walkMargin: number;
  walkRangeMin: number;
  walkRangeMax: number;
  walkSpring: number;
  // Look
  roomStyle: RoomStyleName;
  grain: boolean;
  grainAmount: number;
  vignette: number;
  personWarmth: number;
  personBrightness: number;
  personSaturation: number;
  // Output
  aspect: AspectPreset;
  captions: boolean;
  recordSound: boolean;
  // Debug
  debugWireframe: boolean;
  showStats: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  leftFactor: 2.0,
  rightFactor: 0.85,
  personHeight: 1.75,
  mirror: true,
  bodyMode: 'auto',
  lockScale: false,
  counterHeight: 1.05,
  maskFeather: 0.5,
  maskErode: 0.35,
  maskSmoothing: 0.5,
  segModel: 'selfie',
  walkDepth: 0.45,
  walkMargin: 0.3,
  walkRangeMin: 0.15,
  walkRangeMax: 0.85,
  walkSpring: 5,
  roomStyle: 'Vintage museum',
  grain: true,
  grainAmount: 0.05,
  vignette: 0.55,
  personWarmth: 0.35,
  personBrightness: 1.0,
  personSaturation: 0.9,
  aspect: 'fill',
  captions: true,
  recordSound: true,
  debugWireframe: false,
  showStats: false,
};

const STORAGE_KEY = 'ames-room-settings-v1';

export function loadSettings(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (key in saved && typeof saved[key] === typeof DEFAULT_SETTINGS[key]) {
          (s as unknown as Record<string, unknown>)[key] = saved[key];
        }
      }
    }
  } catch {
    // Storage can be unavailable (private mode, blocked site data): defaults are fine.
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
