import { create } from "zustand";
import type { Clip, Tool, Track, Keyframe } from "./types";

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

export const clipOutDur = (c: Clip) => (c.out - c.in) / c.speed;

interface Snapshot {
  clips: Clip[];
  tracks: Track[];
}

const HISTORY_CAP = 50;

export interface Store {
  clips: Clip[];
  tracks: Track[];
  past: Snapshot[];
  future: Snapshot[];
  tool: Tool;
  playbackRate: number;
  playDir: 1 | -1;
  playing: boolean;
  currentTime: number;
  scrubbing: boolean;
  selectedTrackId: string | null;
  sidecarReady: boolean;
  busy: string | null;
  syncError: string | null;

  setTool: (t: Tool) => void;
  setPlaybackRate: (r: number) => void;
  setPlayDir: (d: 1 | -1) => void;
  setPlaying: (b: boolean) => void;
  setCurrentTime: (t: number) => void;
  setScrubbing: (b: boolean) => void;
  setSidecarReady: (b: boolean) => void;
  setBusy: (b: string | null) => void;
  setSyncError: (e: string | null) => void;
  setSelectedTrack: (id: string | null) => void;

  addClip: (c: Clip) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  splitClip: (id: string, atSrcTime: number) => void;
  speedRange: (t0: number, t1: number, rate: number) => void;

  addTrack: (t: Track) => void;
  removeTrack: (id: string) => void;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  upsertKeyframe: (trackId: string, kf: Keyframe) => void;
  markDirty: (trackId: string, fromFrame: number) => void;
  mergeDense: (
    trackId: string,
    dense: Record<number, [number, number, number, number]>
  ) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  loadProject: (clips: Clip[], tracks: Track[]) => void;
}

export const useStore = create<Store>((set, get) => ({
  clips: [],
  tracks: [],
  past: [],
  future: [],
  tool: "select",
  playbackRate: 1,
  playDir: 1,
  playing: false,
  currentTime: 0,
  scrubbing: false,
  selectedTrackId: null,
  sidecarReady: false,
  busy: null,
  syncError: null,

  setTool: (tool) => set({ tool }),
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  setPlayDir: (playDir) => set({ playDir }),
  setPlaying: (playing) => set({ playing }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setScrubbing: (scrubbing) => set({ scrubbing }),
  setSidecarReady: (sidecarReady) => set({ sidecarReady }),
  setBusy: (busy) => set({ busy }),
  setSyncError: (syncError) => set({ syncError }),
  setSelectedTrack: (selectedTrackId) => set({ selectedTrackId }),

  addClip: (c) => set((s) => ({ clips: [...s.clips, c] })),
  removeClip: (id) =>
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      tracks: s.tracks.filter((t) => t.clipId !== id),
    })),
  moveClip: (id, dir) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.clips.length) return s;
      const clips = [...s.clips];
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return { clips };
    }),
  updateClip: (id, patch) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),
  splitClip: (id, atSrcTime) =>
    set((s) => {
      const r = splitAt(s.clips, s.tracks, id, atSrcTime);
      return r ? { clips: r.clips, tracks: r.tracks } : s;
    }),
  speedRange: (t0, t1, rate) =>
    set((s) => {
      if (t1 - t0 < 0.05) return s;
      let clips = s.clips;
      let tracks = s.tracks;
      for (const t of [t0, t1]) {
        let acc = 0;
        for (const c of clips) {
          const d = clipOutDur(c);
          if (t > acc + 0.05 && t < acc + d - 0.05) {
            const r = splitAt(clips, tracks, c.id, c.in + (t - acc) * c.speed);
            if (r) {
              clips = r.clips;
              tracks = r.tracks;
            }
            break;
          }
          acc += d;
        }
      }
      let acc = 0;
      clips = clips.map((c) => {
        const d = clipOutDur(c);
        const inside = t0 < acc + d - 1e-3 && t1 > acc + 1e-3;
        acc += d;
        return inside ? { ...c, speed: rate } : c;
      });
      return { clips, tracks };
    }),

  addTrack: (t) => set((s) => ({ tracks: [...s.tracks, t] })),
  removeTrack: (id) =>
    set((s) => ({
      tracks: s.tracks.filter((t) => t.id !== id),
      selectedTrackId: s.selectedTrackId === id ? null : s.selectedTrackId,
    })),
  updateTrack: (id, patch) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  upsertKeyframe: (trackId, kf) =>
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const rest = t.keyframes.filter((k) => k.frame !== kf.frame);
        const keyframes = [...rest, kf].sort((a, b) => a.frame - b.frame);
        return { ...t, keyframes };
      }),
    })),
  mergeDense: (trackId, dense) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === trackId ? { ...t, dense: { ...t.dense, ...dense } } : t
      ),
    })),
  markDirty: (trackId, fromFrame) =>
    set((s) => ({
      tracks: s.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const dense = Object.fromEntries(
          Object.entries(t.dense).filter(([f]) => +f < fromFrame)
        );
        return { ...t, dirty: true, dirtyFrom: fromFrame, dense };
      }),
    })),

  pushHistory: () =>
    set((s) => ({
      past: [...s.past.slice(-(HISTORY_CAP - 1)), { clips: s.clips, tracks: s.tracks }],
      future: [],
    })),
  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      const trackIds = new Set(prev.tracks.map((t) => t.id));
      return {
        past: s.past.slice(0, -1),
        future: [...s.future, { clips: s.clips, tracks: s.tracks }],
        clips: prev.clips,
        tracks: prev.tracks,
        selectedTrackId:
          s.selectedTrackId && trackIds.has(s.selectedTrackId)
            ? s.selectedTrackId
            : null,
        currentTime: Math.min(
          s.currentTime,
          Math.max(0, totalDuration(prev.clips) - 1e-3)
        ),
      };
    }),
  redo: () =>
    set((s) => {
      const next = s.future[s.future.length - 1];
      if (!next) return s;
      const trackIds = new Set(next.tracks.map((t) => t.id));
      return {
        future: s.future.slice(0, -1),
        past: [...s.past, { clips: s.clips, tracks: s.tracks }],
        clips: next.clips,
        tracks: next.tracks,
        selectedTrackId:
          s.selectedTrackId && trackIds.has(s.selectedTrackId)
            ? s.selectedTrackId
            : null,
        currentTime: Math.min(
          s.currentTime,
          Math.max(0, totalDuration(next.clips) - 1e-3)
        ),
      };
    }),
  loadProject: (clips, tracks) => {
    get().pushHistory();
    set({
      clips,
      tracks,
      currentTime: 0,
      playing: false,
      selectedTrackId: null,
      tool: "select",
    });
  },
}));

function splitAt(
  clips: Clip[],
  tracks: Track[],
  id: string,
  atSrcTime: number
): { clips: Clip[]; tracks: Track[] } | null {
  const i = clips.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const c = clips[i];
  if (atSrcTime <= c.in + 0.05 || atSrcTime >= c.out - 0.05) return null;
  const rightId = uid();
  const nextClips = [...clips];
  nextClips.splice(
    i,
    1,
    { ...c, out: atSrcTime },
    { ...c, id: rightId, in: atSrcTime }
  );
  const nextTracks: Track[] = [];
  for (const t of tracks) {
    if (t.clipId !== id) {
      nextTracks.push(t);
      continue;
    }
    const effS = t.tStart ?? c.in;
    const effE = t.tEnd ?? c.out;
    if (effE <= atSrcTime) {
      nextTracks.push(t);
    } else if (effS >= atSrcTime) {
      nextTracks.push({ ...t, clipId: rightId });
    } else {
      nextTracks.push({ ...t, tEnd: atSrcTime });
      nextTracks.push({ ...t, id: uid(), clipId: rightId, tStart: atSrcTime });
    }
  }
  return { clips: nextClips, tracks: nextTracks };
}

export function totalDuration(clips: Clip[]) {
  return clips.reduce((acc, c) => acc + clipOutDur(c), 0);
}

export function locate(clips: Clip[], t: number) {
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipOutDur(clips[i]);
    if (t < acc + d || i === clips.length - 1) {
      const local = Math.min(Math.max(t - acc, 0), d);
      return { clip: clips[i], index: i, start: acc, srcTime: clips[i].in + local * clips[i].speed };
    }
    acc += d;
  }
  return null;
}

export function interpolate(
  keyframes: Keyframe[],
  frame: number
): [number, number, number, number] | null {
  if (keyframes.length === 0) return null;
  const f = Math.round(frame);
  const kfs = [...keyframes].sort((a, b) => a.frame - b.frame);
  if (f <= kfs[0].frame) return [kfs[0].x, kfs[0].y, kfs[0].w, kfs[0].h];
  const last = kfs[kfs.length - 1];
  if (f >= last.frame) return [last.x, last.y, last.w, last.h];
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].frame < f) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const r = (f - a.frame) / (b.frame - a.frame);
  return [
    a.x + (b.x - a.x) * r,
    a.y + (b.y - a.y) * r,
    a.w + (b.w - a.w) * r,
    a.h + (b.h - a.h) * r,
  ];
}
