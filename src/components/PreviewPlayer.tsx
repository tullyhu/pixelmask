import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useStore, locate, clipOutDur, totalDuration, uid, interpolate } from "../store";
import { syncDirtyTracks } from "../trackSync";
import { api } from "../api";
import type { CropRect, Track } from "../types";

type DragMode =
  | { kind: "none" }
  | { kind: "new"; x0: number; y0: number; x1: number; y1: number; fixed: boolean }
  | { kind: "move"; trackId: string; dx: number; dy: number; box: CropRect }
  | {
      kind: "resize";
      trackId: string;
      edges: { l: boolean; r: boolean; t: boolean; b: boolean };
      box: CropRect;
    }
  | {
      kind: "crop-resize";
      edges: { l: boolean; r: boolean; t: boolean; b: boolean };
      box: CropRect;
    }
  | { kind: "crop-move"; dx: number; dy: number; box: CropRect };

export default function PreviewPlayer() {
  const clips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const tool = useStore((s) => s.tool);
  const playbackRate = useStore((s) => s.playbackRate);
  const playDir = useStore((s) => s.playDir);
  const currentTime = useStore((s) => s.currentTime);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const setSelectedTrack = useStore((s) => s.setSelectedTrack);
  const addTrack = useStore((s) => s.addTrack);
  const updateClip = useStore((s) => s.updateClip);
  const upsertKeyframe = useStore((s) => s.upsertKeyframe);
  const updateTrack = useStore((s) => s.updateTrack);
  const removeTrack = useStore((s) => s.removeTrack);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  const fxTmpRef = useRef<HTMLCanvasElement | null>(null);
  const playing = useStore((s) => s.playing);
  const busy = useStore((s) => s.busy);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [drag, setDragState] = useState<DragMode>({ kind: "none" });
  const dragRef = useRef<DragMode>({ kind: "none" });
  const setDrag = (d: DragMode) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [cropDraft, setCropDraft] = useState<CropRect | null>(null);
  const [loadedClipId, setLoadedClipId] = useState<string | null>(null);
  const lastRevStepRef = useRef(0);

  const loc = clips.length ? locate(clips, currentTime) : null;
  const clip = loc?.clip ?? null;
  const crop: CropRect = clip?.crop ?? {
    x: 0,
    y: 0,
    w: clip?.width ?? 16,
    h: clip?.height ?? 9,
  };
  const scale = size.w > 0 ? size.w / crop.w : 1;
  const srcFrame = clip ? Math.round(loc!.srcTime * clip.fps) : 0;

  const sizeRef = useRef(size);
  sizeRef.current = size;

  const paintFxRef = useRef<() => void>(() => {});
  paintFxRef.current = () => {
    const canvas = fxCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w: W, h: H } = sizeRef.current;
    if (canvas.width !== Math.round(W) || canvas.height !== Math.round(H)) {
      canvas.width = Math.round(W);
      canvas.height = Math.round(H);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const v = videoRef.current;
    const s = useStore.getState();
    const l = s.clips.length ? locate(s.clips, s.currentTime) : null;
    if (!v || !l || v.readyState < 2 || W <= 0) return;
    const c = l.clip;
    const cr: CropRect = c.crop ?? { x: 0, y: 0, w: c.width, h: c.height };
    const sc = W / cr.w;
    const frame = Math.round(l.srcTime * c.fps);
    const d = dragRef.current;
    if (!fxTmpRef.current) fxTmpRef.current = document.createElement("canvas");
    const tmp = fxTmpRef.current;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    for (const t of s.tracks) {
      if (t.clipId !== c.id) continue;
      if (t.tStart != null && l.srcTime < t.tStart) continue;
      if (t.tEnd != null && l.srcTime > t.tEnd) continue;
      let b: [number, number, number, number] | CropRect | null;
      const isDragTarget =
        d.kind !== "none" &&
        (d as { trackId?: string }).trackId === t.id &&
        "box" in d;
      if (isDragTarget) {
        b = (d as { box: CropRect }).box;
      } else if (!t.fixed && t.dense[frame]) {
        b = t.dense[frame];
      } else {
        b = interpolate(t.keyframes, frame);
      }
      if (!b) continue;
      let bx: number, by: number, bw: number, bh: number;
      if (Array.isArray(b)) {
        [bx, by, bw, bh] = b;
      } else {
        bx = b.x;
        by = b.y;
        bw = b.w;
        bh = b.h;
      }
      const dx = (bx - cr.x) * sc;
      const dy = (by - cr.y) * sc;
      const dw = bw * sc;
      const dh = bh * sc;
      if (dw < 2 || dh < 2) continue;
      if (t.effect === "blackbox") {
        ctx.fillStyle = "#000";
        ctx.fillRect(dx, dy, dw, dh);
        continue;
      }
      const sx = Math.max(0, Math.min(c.width - 2, bx));
      const sy = Math.max(0, Math.min(c.height - 2, by));
      const sw = Math.max(2, Math.min(c.width - sx, bw));
      const sh = Math.max(2, Math.min(c.height - sy, bh));
      const ddx = dx + ((sx - bx) / bw) * dw;
      const ddy = dy + ((sy - by) / bh) * dh;
      const ddw = (sw / bw) * dw;
      const ddh = (sh / bh) * dh;
      if (t.effect === "pixelate") {
        const tw = Math.max(2, Math.round(ddw / 14));
        const th = Math.max(2, Math.round(ddh / 14));
        tmp.width = tw;
        tmp.height = th;
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(v, sx, sy, sw, sh, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tw, th, ddx, ddy, ddw, ddh);
        ctx.imageSmoothingEnabled = true;
      } else {
        const tw = Math.max(2, Math.round(ddw / 8));
        const th = Math.max(2, Math.round(ddh / 8));
        tmp.width = tw;
        tmp.height = th;
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(v, sx, sy, sw, sh, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = true;
        for (let pass = 0; pass < 2; pass++) {
          ctx.drawImage(tmp, 0, 0, tw, th, ddx, ddy, ddw, ddh);
          if (pass === 0) {
            tctx.clearRect(0, 0, tw, th);
            tctx.drawImage(canvas, ddx, ddy, ddw, ddh, 0, 0, tw, th);
          }
        }
      }
    }
  };

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      paintFxRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const h = (r.width * crop.h) / crop.w;
      setSize({ w: r.width, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [crop.h, crop.w, clip?.id]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    if (loadedClipId !== clip.id) {
      v.src = convertFileSrc(clip.src);
      v.load();
      setLoadedClipId(clip.id);
      const seekTo = loc!.srcTime;
      v.onloadedmetadata = () => {
        v.currentTime = seekTo;
        if (useStore.getState().playing && useStore.getState().playDir === 1)
          v.play().catch(() => {});
      };
    }
  }, [clip?.id]);

  useEffect(() => {
    const v = videoRef.current;
    if (v && clip) v.playbackRate = clip.speed * playbackRate;
  }, [playbackRate, clip?.speed, loadedClipId]);

  const lastScrubSeekRef = useRef(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    const scrubbing = useStore.getState().scrubbing;
    const threshold = scrubbing ? 0.03 : 0.35;
    if (Math.abs(v.currentTime - loc!.srcTime) > threshold) {
      if (scrubbing) {
        const now = performance.now();
        if (now - lastScrubSeekRef.current < 60) return;
        lastScrubSeekRef.current = now;
      }
      v.currentTime = loc!.srcTime;
    }
  }, [currentTime]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const s = useStore.getState();
      const l = s.clips.length ? locate(s.clips, s.currentTime) : null;
      if (v && l && l.clip.id === loadedClipId && useStore.getState().playing) {
        const total = totalDuration(s.clips);
        if (s.playDir === 1) {
          const t = l.start + (v.currentTime - l.clip.in) / l.clip.speed;
          if (v.currentTime >= l.clip.out - 1e-3) {
            const nextStart = l.start + clipOutDur(l.clip);
            if (nextStart >= total - 1e-3) {
              useStore.getState().setPlaying(false);
              v.pause();
              s.setCurrentTime(total);
            } else {
              s.setCurrentTime(nextStart);
            }
          } else {
            s.setCurrentTime(Math.min(t, total));
          }
        } else {
          const now = performance.now();
          if (now - lastRevStepRef.current > 80) {
            const dt = (now - lastRevStepRef.current) / 1000;
            lastRevStepRef.current = now;
            const ns = v.currentTime - dt * l.clip.speed * s.playbackRate;
            if (ns <= l.clip.in) {
              if (l.start <= 1e-3) {
                useStore.getState().setPlaying(false);
                v.currentTime = l.clip.in;
                s.setCurrentTime(0);
              } else {
                s.setCurrentTime(Math.max(0, l.start - 1e-3));
              }
            } else {
              v.currentTime = ns;
              s.setCurrentTime(l.start + (ns - l.clip.in) / l.clip.speed);
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loadedClipId]);

  const playInDirection = useCallback(
    async (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v || !clip) return;
      const s = useStore.getState();
      if (s.busy) return;
      if (useStore.getState().playing && s.playDir === dir) {
        s.setPlaying(false);
        v.pause();
        return;
      }
      if (!(await syncDirtyTracks())) return;
      s.setPlayDir(dir);
      s.setPlaying(true);
      if (dir === 1) {
        if (s.currentTime >= totalDuration(s.clips) - 1e-3) s.setCurrentTime(0);
        v.play().catch(() => {});
      } else {
        if (s.currentTime <= 1e-3) s.setCurrentTime(totalDuration(s.clips));
        v.pause();
        lastRevStepRef.current = performance.now();
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
    [clip]
  );

  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);

  const scanAllFaces = useCallback(async () => {
    const s = useStore.getState();
    const l = s.clips.length ? locate(s.clips, s.currentTime) : null;
    if (!l || s.busy || detecting) return;
    const c = l.clip;
    setDetecting(true);
    setDetectMsg(null);
    s.setBusy("正在扫描全片人脸…");
    try {
      const { tracks: scanned } = await api.scan(c.src);
      const iou = (
        a: { x: number; y: number; w: number; h: number },
        b: { x: number; y: number; w: number; h: number }
      ) => {
        const x0 = Math.max(a.x, b.x);
        const y0 = Math.max(a.y, b.y);
        const x1 = Math.min(a.x + a.w, b.x + b.w);
        const y1 = Math.min(a.y + a.h, b.y + b.h);
        const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
        const union = a.w * a.h + b.w * b.h - inter;
        return union > 0 ? inter / union : 0;
      };
      const existing = s.tracks.filter((t) => t.clipId === c.id);
      const fresh = scanned.filter((st) => {
        const k0 = st.keyframes[0];
        return !existing.some((t) => {
          const box = interpolate(t.keyframes, k0.frame);
          return box && iou({ x: box[0], y: box[1], w: box[2], h: box[3] }, k0) > 0.3;
        });
      });
      if (fresh.length === 0) {
        setDetectMsg(scanned.length > 0 ? "检测到的人脸已有遮罩" : "整个视频中没有检测到人脸");
        setTimeout(() => setDetectMsg(null), 3000);
        return;
      }
      s.pushHistory();
      let firstId: string | null = null;
      for (const st of fresh) {
        const kfs = st.keyframes;
        const first = kfs[0].frame;
        const last = kfs[kfs.length - 1].frame;
        const track: Track = {
          id: uid(),
          clipId: c.id,
          effect: "pixelate",
          fixed: false,
          keyframes: kfs.map((k) => ({ ...k })),
          dense: {},
          tStart: first / c.fps,
          tEnd: Math.max(last / c.fps, first / c.fps + 0.1),
          dirty: true,
          dirtyFrom: first,
        };
        s.addTrack(track);
        firstId ??= track.id;
      }
      if (firstId) s.setSelectedTrack(firstId);
      setDetectMsg(`已创建 ${fresh.length} 个人脸遮罩，播放时自动跟踪`);
      setTimeout(() => setDetectMsg(null), 3000);
    } catch (e) {
      setDetectMsg(`扫描失败: ${e instanceof Error ? e.message : e}`);
      setTimeout(() => setDetectMsg(null), 5000);
    } finally {
      s.setBusy(null);
      setDetecting(false);
    }
  }, [detecting]);

  const stop = useCallback(() => {
    const v = videoRef.current;
    const s = useStore.getState();
    if (s.busy) return;
    s.setPlaying(false);
    v?.pause();
    s.setCurrentTime(0);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
      if (e.code === "Space") {
        e.preventDefault();
        playInDirection(useStore.getState().playDir);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) {
          useStore.getState().redo();
        } else {
          useStore.getState().undo();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyY") {
        e.preventDefault();
        useStore.getState().redo();
        return;
      }
      if (e.code === "Escape") {
        const s = useStore.getState();
        if (s.tool === "crop") {
          s.setTool("select");
        } else {
          s.setSelectedTrack(null);
        }
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        const s = useStore.getState();
        if (s.selectedTrackId) {
          s.pushHistory();
          s.removeTrack(s.selectedTrackId);
        }
        return;
      }
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        const s = useStore.getState();
        const l = s.clips.length ? locate(s.clips, s.currentTime) : null;
        if (!l) return;
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / l.clip.fps;
        const total = totalDuration(s.clips);
        const dir = e.code === "ArrowRight" ? 1 : -1;
        s.setCurrentTime(Math.max(0, Math.min(total, s.currentTime + dir * step)));
        return;
      }
      if (e.code === "KeyI" || e.code === "KeyO" || e.code === "KeyS") {
        const s = useStore.getState();
        const l = s.clips.length ? locate(s.clips, s.currentTime) : null;
        if (!l) return;
        const c = l.clip;
        e.preventDefault();
        s.pushHistory();
        if (e.code === "KeyI") {
          s.updateClip(c.id, { in: Math.max(0, Math.min(l.srcTime, c.out - 0.1)) });
        } else if (e.code === "KeyO") {
          s.updateClip(c.id, {
            out: Math.max(c.in + 0.1, Math.min(c.duration, l.srcTime)),
          });
        } else {
          s.splitClip(c.id, l.srcTime);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playInDirection]);

  const toSrc = (clientX: number, clientY: number) => {
    const el = containerRef.current!.getBoundingClientRect();
    return {
      x: (clientX - el.left) / scale + crop.x,
      y: (clientY - el.top) / scale + crop.y,
    };
  };

  const clipTracks = clip ? tracks.filter((t) => t.clipId === clip.id) : [];

  const boxAt = (t: Track) => {
    if (t.tStart != null && loc!.srcTime < t.tStart) return null;
    if (t.tEnd != null && loc!.srcTime > t.tEnd) return null;
    if (!t.fixed && t.dense[srcFrame]) return t.dense[srcFrame];
    return interpolate(t.keyframes, srcFrame);
  };

  const hitTest = (sx: number, sy: number): Track | null => {
    for (let i = clipTracks.length - 1; i >= 0; i--) {
      const b = boxAt(clipTracks[i]);
      if (!b) continue;
      if (sx >= b[0] && sx <= b[0] + b[2] && sy >= b[1] && sy <= b[1] + b[3])
        return clipTracks[i];
    }
    return null;
  };

  useEffect(() => {
    if (tool === "crop" && clip) {
      setCropDraft(
        clip.crop ?? { x: 0, y: 0, w: clip.width, h: clip.height }
      );
    } else {
      setCropDraft(null);
    }
  }, [tool, clip?.id]);

  const EDGE = 10;

  const edgeHit = (p: { x: number; y: number }, box: CropRect, th: number) => ({
    l: Math.abs(p.x - box.x) < th,
    r: Math.abs(p.x - (box.x + box.w)) < th,
    t: Math.abs(p.y - box.y) < th,
    b: Math.abs(p.y - (box.y + box.h)) < th,
  });

  const resizeBox = (
    box: CropRect,
    edges: { l: boolean; r: boolean; t: boolean; b: boolean },
    p: { x: number; y: number }
  ): CropRect => {
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    let { x, y, w, h } = box;
    if (edges.l) {
      x = Math.min(p.x, right - 8);
      w = right - x;
    }
    if (edges.r) w = Math.max(8, p.x - x);
    if (edges.t) {
      y = Math.min(p.y, bottom - 8);
      h = bottom - y;
    }
    if (edges.b) h = Math.max(8, p.y - y);
    return { x, y, w, h };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!clip) return;
    const p = toSrc(e.clientX, e.clientY);
    if (tool === "crop") {
      if (!cropDraft) return;
      const th = EDGE / scale;
      const edges = edgeHit(p, cropDraft, th);
      if (edges.l || edges.r || edges.t || edges.b) {
        setDrag({ kind: "crop-resize", edges, box: cropDraft });
      } else if (
        p.x > cropDraft.x &&
        p.x < cropDraft.x + cropDraft.w &&
        p.y > cropDraft.y &&
        p.y < cropDraft.y + cropDraft.h
      ) {
        setDrag({
          kind: "crop-move",
          dx: p.x - cropDraft.x,
          dy: p.y - cropDraft.y,
          box: cropDraft,
        });
      } else {
        return;
      }
    } else {
      const hit = hitTest(p.x, p.y);
      if (hit) {
        setSelectedTrack(hit.id);
        const b = boxAt(hit)!;
        const box = { x: b[0], y: b[1], w: b[2], h: b[3] };
        const th = EDGE / scale;
        const edges = {
          l: Math.abs(p.x - box.x) < th,
          r: Math.abs(p.x - (box.x + box.w)) < th,
          t: Math.abs(p.y - box.y) < th,
          b: Math.abs(p.y - (box.y + box.h)) < th,
        };
        useStore.getState().pushHistory();
        if (edges.l || edges.r || edges.t || edges.b) {
          setDrag({ kind: "resize", trackId: hit.id, edges, box });
        } else {
          setDrag({ kind: "move", trackId: hit.id, dx: p.x - box.x, dy: p.y - box.y, box });
        }
      } else {
        setSelectedTrack(null);
        setDrag({ kind: "new", x0: p.x, y0: p.y, x1: p.x, y1: p.y, fixed: e.shiftKey });
      }
    }
    const move = (ev: MouseEvent) => onDragMove(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onDragEnd();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!clip || tool === "crop") return;
    const p = toSrc(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y);
    if (!hit) return;
    setDrag({ kind: "none" });
    const tEnd = loc!.srcTime;
    const tStart = hit.tStart ?? clip.in;
    useStore.getState().pushHistory();
    if (tEnd <= tStart + 1e-3) {
      removeTrack(hit.id);
    } else {
      updateTrack(hit.id, { tEnd });
    }
  };

  const onDragMove = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (drag.kind === "none") return;
    const p = toSrc(clientX, clientY);
    if (drag.kind === "new") {
      setDrag({ ...drag, x1: p.x, y1: p.y });
    } else if (drag.kind === "move") {
      setDrag({ ...drag, box: { ...drag.box, x: p.x - drag.dx, y: p.y - drag.dy } });
    } else if (drag.kind === "resize") {
      setDrag({ ...drag, box: resizeBox(drag.box, drag.edges, p) });
    } else if (drag.kind === "crop-resize") {
      const box = resizeBox(drag.box, drag.edges, p);
      setDrag({ ...drag, box });
      setCropDraft(box);
    } else if (drag.kind === "crop-move") {
      const box = { ...drag.box, x: p.x - drag.dx, y: p.y - drag.dy };
      setDrag({ ...drag, box });
      setCropDraft(box);
    }
  };

  const normRect = (x0: number, y0: number, x1: number, y1: number): CropRect => ({
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  });

  const onDragEnd = async () => {
    const finished = dragRef.current;
    if (!clip || finished.kind === "none") return;
    setDrag({ kind: "none" });
    if (finished.kind === "crop-resize" || finished.kind === "crop-move") {
      setCropDraft(finished.box);
      return;
    }
    if (finished.kind === "new") {
      const r = normRect(finished.x0, finished.y0, finished.x1, finished.y1);
      if (r.w <= 6 || r.h <= 6) return;
      const track: Track = {
        id: uid(),
        clipId: clip.id,
        effect: "pixelate",
        fixed: finished.fixed,
        keyframes: [
          {
            frame: srcFrame,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.w),
            h: Math.round(r.h),
          },
        ],
        dense: {},
        tStart: null,
        tEnd: null,
      };
      useStore.getState().pushHistory();
      addTrack({ ...track, dirty: !track.fixed, dirtyFrom: track.fixed ? null : srcFrame });
      setSelectedTrack(track.id);
      return;
    }
    const track = tracks.find(
      (t) => t.id === (finished as { trackId: string }).trackId
    );
    if (track) {
      const b = finished.box;
      const kf = {
        frame: srcFrame,
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.w),
        h: Math.round(b.h),
      };
      if (track.fixed) {
        updateTrack(track.id, { keyframes: [kf] });
        return;
      }
      upsertKeyframe(track.id, kf);
      useStore.getState().markDirty(track.id, srcFrame);
    }
  };

  const dragRect =
    drag.kind === "new"
      ? normRect(drag.x0, drag.y0, drag.x1, drag.y1)
      : drag.kind !== "none"
        ? drag.box
        : null;

  return (
    <div className="preview">
      <div
        ref={containerRef}
        className="preview-stage"
        style={{ height: size.h || undefined }}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      >
        {clip ? (
          <>
            <video
              ref={videoRef}
              style={{
                position: "absolute",
                left: -crop.x * scale,
                top: -crop.y * scale,
                width: clip.width * scale,
                height: clip.height * scale,
              }}
              muted={false}
              playsInline
            />
            <canvas
              ref={fxCanvasRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: size.w,
                height: size.h,
                pointerEvents: "none",
              }}
            />
            {clipTracks.map((t) => {
              const isDragTarget =
                drag.kind !== "none" &&
                (drag as { trackId?: string }).trackId === t.id;
              const b = isDragTarget
                ? [dragRect!.x, dragRect!.y, dragRect!.w, dragRect!.h]
                : boxAt(t);
              if (!b) return null;
              const color =
                t.id === selectedTrackId
                  ? "#ffd64d"
                  : t.fixed
                    ? "#b88fff"
                    : "#59e39e";
              return (
                <div
                  key={t.id}
                  style={{
                    position: "absolute",
                    left: (b[0] - crop.x) * scale,
                    top: (b[1] - crop.y) * scale,
                    width: b[2] * scale,
                    height: b[3] * scale,
                    border: `2px solid ${color}`,
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                />
              );
            })}
            {cropDraft && tool === "crop" && (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: "100%",
                    height: Math.max(0, (cropDraft.y - crop.y) * scale),
                    background: "rgba(0,0,0,0.55)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: (cropDraft.y + cropDraft.h - crop.y) * scale,
                    width: "100%",
                    height: Math.max(
                      0,
                      (crop.y + crop.h - cropDraft.y - cropDraft.h) * scale
                    ),
                    background: "rgba(0,0,0,0.55)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: (cropDraft.y - crop.y) * scale,
                    width: Math.max(0, (cropDraft.x - crop.x) * scale),
                    height: cropDraft.h * scale,
                    background: "rgba(0,0,0,0.55)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: (cropDraft.x + cropDraft.w - crop.x) * scale,
                    top: (cropDraft.y - crop.y) * scale,
                    width: Math.max(
                      0,
                      (crop.x + crop.w - cropDraft.x - cropDraft.w) * scale
                    ),
                    height: cropDraft.h * scale,
                    background: "rgba(0,0,0,0.55)",
                    pointerEvents: "none",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: (cropDraft.x - crop.x) * scale,
                    top: (cropDraft.y - crop.y) * scale,
                    width: cropDraft.w * scale,
                    height: cropDraft.h * scale,
                    border: "2px solid #fbbf24",
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                >
                  {(["nw", "ne", "sw", "se"] as const).map((c) => (
                    <div
                      key={c}
                      style={{
                        position: "absolute",
                        width: 10,
                        height: 10,
                        background: "#fbbf24",
                        left: c.includes("w") ? -6 : undefined,
                        right: c.includes("e") ? -6 : undefined,
                        top: c.includes("n") ? -6 : undefined,
                        bottom: c.includes("s") ? -6 : undefined,
                      }}
                    />
                  ))}
                </div>
                <div className="crop-actions">
                  <button
                    className="crop-confirm"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      useStore.getState().pushHistory();
                      updateClip(clip.id, {
                        crop: {
                          x: Math.max(0, Math.round(cropDraft.x)),
                          y: Math.max(0, Math.round(cropDraft.y)),
                          w: Math.round(cropDraft.w),
                          h: Math.round(cropDraft.h),
                        },
                      });
                      useStore.getState().setTool("select");
                    }}
                  >
                    确定裁切
                  </button>
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => useStore.getState().setTool("select")}
                  >
                    取消
                  </button>
                </div>
              </>
            )}
            {drag.kind === "new" && dragRect && (
              <div
                style={{
                  position: "absolute",
                  left: (dragRect.x - crop.x) * scale,
                  top: (dragRect.y - crop.y) * scale,
                  width: dragRect.w * scale,
                  height: dragRect.h * scale,
                  border: "2px dashed #59e39e",
                  background: "rgba(255,255,255,0.08)",
                  pointerEvents: "none",
                }}
              />
            )}
          </>
        ) : (
          <div className="preview-empty">导入视频开始编辑</div>
        )}
        {busy && (
          <div className="preview-busy">
            <div className="spinner" />
            <div>{busy}</div>
            {busy.startsWith("跟踪") && (
              <div className="preview-busy-sub">跟踪完成前无法播放预览</div>
            )}
          </div>
        )}
      </div>
      <div className="preview-controls">
        <button
          className={playing && playDir === -1 ? "active" : ""}
          onClick={() => playInDirection(-1)}
          disabled={!clip || !!busy}
          title="倒放"
        >
          ◀
        </button>
        <button
          className={playing && playDir === 1 ? "active" : ""}
          onClick={() => playInDirection(1)}
          disabled={!clip || !!busy}
          title="播放"
        >
          ▶
        </button>
        <button onClick={stop} disabled={!clip} title="停止并回到开头">
          ■
        </button>
        {[0.5, 1, 2].map((r) => (
          <button
            key={r}
            className={playbackRate === r ? "active" : ""}
            onClick={() => useStore.getState().setPlaybackRate(r)}
          >
            {r}x
          </button>
        ))}
        <button
          onClick={scanAllFaces}
          disabled={!clip || !!busy || detecting}
          title="扫描整个视频，自动识别人脸并创建跟踪遮罩"
        >
          {detecting ? "扫描中…" : "扫描人脸"}
        </button>
        {detectMsg && <span className="detect-msg">{detectMsg}</span>}
        <span className="time">
          {currentTime.toFixed(2)}s / {totalDuration(clips).toFixed(2)}s
        </span>
      </div>
    </div>
  );
}
