import { useRef, useState } from "react";
import { useStore, clipOutDur, totalDuration } from "../store";
import NumberField from "./NumberField";
import type { Clip } from "../types";

export default function Timeline() {
  const clips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const currentTime = useStore((s) => s.currentTime);
  const setCurrentTime = useStore((s) => s.setCurrentTime);
  const updateClip = useStore((s) => s.updateClip);
  const removeClip = useStore((s) => s.removeClip);
  const moveClip = useStore((s) => s.moveClip);
  const speedRange = useStore((s) => s.speedRange);
  const trimmingRef = useRef(false);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const selRef = useRef<{ a: number; b: number } | null>(null);
  const selDraggingRef = useRef(false);

  const total = totalDuration(clips);

  const railTime = (clientX: number, rail: DOMRect) =>
    Math.max(0, Math.min(total, ((clientX - rail.left) / rail.width) * total));

  const startSel = (e: React.MouseEvent) => {
    if (total <= 0 || useStore.getState().busy) return;
    const rail = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t0 = railTime(e.clientX, rail);
    selRef.current = { a: t0, b: t0 };
    selDraggingRef.current = true;
    setSel({ a: t0, b: t0 });
    const onMove = (ev: MouseEvent) => {
      const t = railTime(ev.clientX, rail);
      const cur = { a: Math.min(t0, t), b: Math.max(t0, t) };
      selRef.current = cur;
      setSel(cur);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      selDraggingRef.current = false;
      const t = railTime(ev.clientX, rail);
      if (Math.abs(t - t0) < 0.05) {
        selRef.current = null;
        setSel(null);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startTrim = (e: React.MouseEvent, c: Clip, side: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    useStore.getState().pushHistory();
    const stripEl = (e.currentTarget as HTMLElement).closest(
      ".clip-strip"
    ) as HTMLElement;
    if (!stripEl) return;
    const rect = stripEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const idx = useStore.getState().clips.findIndex((x) => x.id === c.id);
    const start = useStore
      .getState()
      .clips.slice(0, idx)
      .reduce((a, x) => a + clipOutDur(x), 0);
    const dur = clipOutDur(c);
    const startX = e.clientX;
    const startIn = c.in;
    const startOut = c.out;
    trimmingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      const dSec = ((ev.clientX - startX) / rect.width) * dur * c.speed;
      if (side === "in") {
        const v = Math.max(0, Math.min(startIn + dSec, startOut - 0.1));
        updateClip(c.id, { in: v });
        setCurrentTime(start);
      } else {
        const v = Math.max(startIn + 0.1, Math.min(c.duration, startOut + dSec));
        updateClip(c.id, { out: v });
        setCurrentTime(start + (v - startIn) / c.speed);
      }
    };
    const onUp = () => {
      trimmingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startScrub = (e: React.MouseEvent) => {
    if (useStore.getState().busy || total <= 0) return;
    const rail = (e.currentTarget as HTMLElement).getBoundingClientRect();
    useStore.getState().setScrubbing(true);
    setCurrentTime(railTime(e.clientX, rail));
    const onMove = (ev: MouseEvent) => {
      setCurrentTime(railTime(ev.clientX, rail));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      useStore.getState().setScrubbing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const setAtPlayhead = (c: Clip, side: "in" | "out", start: number) => {
    useStore.getState().pushHistory();
    const local = (currentTime - start) * c.speed;
    const src = c.in + local;
    if (side === "in") {
      updateClip(c.id, { in: Math.max(0, Math.min(src, c.out - 0.1)) });
    } else {
      updateClip(c.id, { out: Math.max(c.in + 0.1, Math.min(c.duration, src)) });
    }
  };

  return (
    <div className="timeline">
      <div className="timeline-strips">
        {clips.map((c) => {
          const start = clips
            .slice(0, clips.indexOf(c))
            .reduce((a, x) => a + clipOutDur(x), 0);
          const w = total > 0 ? (clipOutDur(c) / total) * 100 : 0;
          const nTracks = tracks.filter((t) => t.clipId === c.id).length;
          const playheadInside =
            currentTime >= start && currentTime <= start + clipOutDur(c);
          return (
            <div
              key={c.id}
              className="clip-strip"
              style={{ width: `${w}%` }}
            >
              <div
                className="trim-handle left"
                title="拖动裁剪入点"
                onMouseDown={(e) => startTrim(e, c, "in")}
              />
              <div
                className="trim-handle right"
                title="拖动裁剪出点"
                onMouseDown={(e) => startTrim(e, c, "out")}
              />
              <div className="clip-name">
                {c.src.split("/").pop()} · {clipOutDur(c).toFixed(1)}s
                {c.speed !== 1 && ` · ${c.speed}x`}
                {nTracks > 0 && ` · ${nTracks}框`}
              </div>
              <div className="clip-ops">
                <button title="前移" onClick={(e) => { e.stopPropagation(); useStore.getState().pushHistory(); moveClip(c.id, -1); }}>◀</button>
                <button title="后移" onClick={(e) => { e.stopPropagation(); useStore.getState().pushHistory(); moveClip(c.id, 1); }}>▶</button>
                <button title="删除" onClick={(e) => { e.stopPropagation(); if (window.confirm(`删除片段 ${c.src.split("/").pop()}？该片段上的遮罩也会一并删除`)) { useStore.getState().pushHistory(); removeClip(c.id); } }}>✕</button>
              </div>
              <div className="clip-trim" onClick={(e) => e.stopPropagation()}>
                <label>
                  入
                  <NumberField
                    step={0.1}
                    min={0}
                    max={c.out - 0.1}
                    value={c.in}
                    onCommit={(v) => {
                      if (v === null) return;
                      useStore.getState().pushHistory();
                      updateClip(c.id, {
                        in: Math.max(0, Math.min(v, c.out - 0.1)),
                      });
                    }}
                  />
                </label>
                <label>
                  出
                  <NumberField
                    step={0.1}
                    min={c.in + 0.1}
                    max={c.duration}
                    value={c.out}
                    onCommit={(v) => {
                      if (v === null) return;
                      useStore.getState().pushHistory();
                      updateClip(c.id, {
                        out: Math.max(Math.min(v, c.duration), c.in + 0.1),
                      });
                    }}
                  />
                </label>
                <label>
                  速度
                  <select
                    value={c.speed}
                    onChange={(e) => {
                      useStore.getState().pushHistory();
                      updateClip(c.id, { speed: +e.target.value });
                    }}
                  >
                    <option value={0.5}>0.5x</option>
                    <option value={1}>1x</option>
                    <option value={2}>2x</option>
                  </select>
                </label>
                {playheadInside && (
                  <>
                    <button
                      className="trim-set"
                      title="把入点设为当前播放位置 (I)"
                      onClick={() => setAtPlayhead(c, "in", start)}
                    >
                      入点⌖
                    </button>
                    <button
                      className="trim-set"
                      title="把出点设为当前播放位置 (O)"
                      onClick={() => setAtPlayhead(c, "out", start)}
                    >
                      出点⌖
                    </button>
                    <button
                      className="trim-set"
                      title="在播放头处分割 (S)"
                      onClick={() => {
                        useStore.getState().pushHistory();
                        useStore
                          .getState()
                          .splitClip(c.id, c.in + (currentTime - start) * c.speed);
                      }}
                    >
                      分割✂
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {clips.length === 0 && <div className="timeline-empty">时间轴为空 — 点击"导入视频"</div>}
      </div>
      {total > 0 && (
        <>
          <div
            className="playhead-rail"
            onMouseDown={(e) => {
              if (e.shiftKey) {
                startSel(e);
              } else {
                startScrub(e);
              }
            }}
            title="按住拖动 = 移动播放头；Shift+拖动 = 选择加速区间"
          >
            {sel && sel.b - sel.a >= 0.05 && (
              <div
                className="range-highlight"
                style={{
                  left: `${(sel.a / total) * 100}%`,
                  width: `${((sel.b - sel.a) / total) * 100}%`,
                }}
              />
            )}
            <div
              className="playhead"
              style={{ left: `${(currentTime / total) * 100}%` }}
            />
          </div>
          {sel && sel.b - sel.a >= 0.05 && (
            <div className="range-bar">
              <span>
                已选 {sel.a.toFixed(2)}s – {sel.b.toFixed(2)}s（
                {(sel.b - sel.a).toFixed(2)}s）
              </span>
              {[0.5, 2, 4].map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    useStore.getState().pushHistory();
                    speedRange(sel.a, sel.b, r);
                    selRef.current = null;
                    setSel(null);
                  }}
                >
                  {r}x
                </button>
              ))}
              <button
                onClick={() => {
                  selRef.current = null;
                  setSel(null);
                }}
              >
                清除
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
