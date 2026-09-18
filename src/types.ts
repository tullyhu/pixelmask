export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Clip {
  id: string;
  src: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  in: number;
  out: number;
  speed: number;
  crop: CropRect | null;
}

export interface Keyframe {
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TrackEffect = "blur" | "pixelate" | "blackbox";

export interface Track {
  id: string;
  clipId: string;
  effect: TrackEffect;
  fixed: boolean;
  keyframes: Keyframe[];
  dense: Record<number, [number, number, number, number]>;
  tStart: number | null;
  tEnd: number | null;
  dirty?: boolean;
  dirtyFrom?: number | null;
}

export type Tool = "select" | "crop";
