import { useStore } from "./store";
import { api } from "./api";

export async function syncDirtyTracks(): Promise<boolean> {
  const s = useStore.getState();
  const dirty = s.tracks.filter((t) => t.dirty && !t.fixed);
  if (dirty.length === 0) return true;
  let i = 0;
  for (const t of dirty) {
    i++;
    const clip = s.clips.find((c) => c.id === t.clipId);
    if (!clip) {
      useStore.getState().updateTrack(t.id, { dirty: false, dirtyFrom: null });
      continue;
    }
    const windowStart = Math.round((t.tStart ?? clip.in) * clip.fps);
    const hasCoverage = Object.keys(t.dense).length > 0;
    const fromFrame = hasCoverage
      ? (t.dirtyFrom ?? windowStart)
      : windowStart;
    const endFrame = Math.round((t.tEnd ?? clip.out) * clip.fps);
    useStore.getState().setBusy(`跟踪中… ${i}/${dirty.length}`);
    try {
      const { dense } = await api.track(clip.src, t.keyframes, fromFrame, endFrame);
      useStore.getState().mergeDense(t.id, dense);
      useStore.getState().updateTrack(t.id, { dirty: false, dirtyFrom: null });
    } catch (e) {
      useStore.getState().setBusy(null);
      useStore
        .getState()
        .setSyncError(
          `遮罩跟踪失败: ${e instanceof Error ? e.message : e}`
        );
      return false;
    }
  }
  useStore.getState().setBusy(null);
  useStore.getState().setSyncError(null);
  return true;
}
