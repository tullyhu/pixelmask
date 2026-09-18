import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, uid, locate } from "./store";
import { api } from "./api";
import { syncDirtyTracks } from "./trackSync";
import type { Clip, Track } from "./types";
import licensesText from "../licenses/THIRD-PARTY-LICENSES.txt?raw";
import PreviewPlayer from "./components/PreviewPlayer";
import Timeline from "./components/Timeline";
import NumberField from "./components/NumberField";
import "./App.css";

function App() {
  const clips = useStore((s) => s.clips);
  const tracks = useStore((s) => s.tracks);
  const tool = useStore((s) => s.tool);
  const currentTime = useStore((s) => s.currentTime);
  const selectedTrackId = useStore((s) => s.selectedTrackId);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const sidecarReady = useStore((s) => s.sidecarReady);
  const busy = useStore((s) => s.busy);
  const syncError = useStore((s) => s.syncError);
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [notice, setNotice] = useState<{
    title: string;
    msg: string;
    path?: string;
  } | null>(null);
  const [showLicenses, setShowLicenses] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [personSegmentation, setPersonSegmentation] = useState(
    () => localStorage.getItem("vr.personSegmentation") === "1"
  );
  const [startupElapsed, setStartupElapsed] = useState(0);

  useEffect(() => {
    if (sidecarReady) return;
    const t0 = Date.now();
    setStartupElapsed(0);
    const t = setInterval(
      () => setStartupElapsed(Math.floor((Date.now() - t0) / 1000)),
      500
    );
    return () => clearInterval(t);
  }, [sidecarReady]);

  useEffect(() => {
    const check = async () => {
      const ok = await api.health();
      useStore.getState().setSidecarReady(ok);
    };
    check();
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, []);

  const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v"];

  const addFiles = async (paths: string[]) => {
    if (paths.length) useStore.getState().pushHistory();
    for (const p of paths) {
      try {
        const meta = await api.probe(p);
        const clip: Clip = {
          id: uid(),
          src: p,
          duration: meta.duration,
          fps: meta.fps,
          width: meta.width,
          height: meta.height,
          hasAudio: meta.has_audio,
          in: 0,
          out: meta.duration,
          speed: 1,
          crop: null,
        };
        useStore.getState().addClip(clip);
      } catch (e) {
        setNotice({
          title: "导入失败",
          msg: `无法导入 ${p.split("/").pop()}：${e instanceof Error ? e.message : e}。请确认引擎已构建（npm run engine）`,
        });
      }
    }
  };

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths = event.payload.paths.filter((p) =>
          VIDEO_EXTS.includes(p.split(".").pop()?.toLowerCase() ?? "")
        );
        if (paths.length) addFiles(paths).catch(() => {});
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const importVideo = async () => {
    const paths = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: VIDEO_EXTS }],
    });
    if (!paths) return;
    await addFiles(Array.isArray(paths) ? paths : [paths]).catch(() => {});
  };

  const exportVideo = async () => {
    const s = useStore.getState();
    if (s.clips.length === 0 || renderPct !== null) return;
    if (!(await syncDirtyTracks())) return;
    const output = await save({
      defaultPath: "output.mp4",
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!output) return;
    const project = {
      clips: s.clips.map((c) => ({
        id: c.id,
        src: c.src,
        in: c.in,
        out: c.out,
        speed: c.speed,
        fps: c.fps,
        width: c.width,
        height: c.height,
        has_audio: c.hasAudio,
        crop: c.crop,
      })),
      tracks: s.tracks.map((t) => ({
        clipId: t.clipId,
        effect: t.effect,
        keyframes: t.keyframes,
        dense: t.dense,
        tStart: t.tStart,
        tEnd: t.tEnd,
      })),
    };
    s.setBusy("正在导出…");
    setRenderPct(0);
    try {
      await api.render(project, output, personSegmentation);
      const stopPoll = () => {
        if (renderPollRef.current !== null) {
          clearInterval(renderPollRef.current);
          renderPollRef.current = null;
        }
      };
      const poll = setInterval(async () => {
        let st;
        try {
          st = await api.renderStatus();
        } catch {
          stopPoll();
          setRenderPct(null);
          s.setBusy(null);
          setNotice({ title: "导出中断", msg: "引擎连接丢失，请重试" });
          return;
        }
        setRenderPct(Math.round(st.progress * 100));
        if (st.state === "running") {
          s.setBusy("正在导出…");
        } else if (st.state === "idle") {
          stopPoll();
          setRenderPct(null);
          s.setBusy(null);
        } else if (st.state === "done") {
          stopPoll();
          setRenderPct(null);
          s.setBusy(null);
          setNotice({
            title: "导出完成",
            msg: st.output ?? output,
            path: st.output ?? output,
          });
        } else if (st.state === "error") {
          stopPoll();
          setRenderPct(null);
          s.setBusy(null);
          setNotice({ title: "导出失败", msg: st.error ?? "未知错误" });
        }
      }, 500);
      renderPollRef.current = poll;
    } catch (e) {
      const msg =
        e instanceof TypeError
          ? "引擎未响应（已断开），看门狗会自动重启，请几秒后重试"
          : `${e}`;
      s.setBusy(null);
      setRenderPct(null);
      setNotice({ title: "导出失败", msg });
    }
  };

  const cancelExport = async () => {
    try {
      await api.renderCancel();
    } catch {}
    if (renderPollRef.current !== null) {
      clearInterval(renderPollRef.current);
      renderPollRef.current = null;
    }
    setRenderPct(null);
    useStore.getState().setBusy(null);
    setNotice({ title: "导出已取消", msg: "导出任务已终止" });
  };

  const setTrackWindow = (t: Track, which: "start" | "end", raw: number | null) => {
    const s = useStore.getState();
    const clip = s.clips.find((c) => c.id === t.clipId);
    if (!clip) return;
    const v =
      raw === null ? null : Math.max(clip.in, Math.min(clip.out, raw));
    s.pushHistory();
    s.updateTrack(t.id, which === "start" ? { tStart: v } : { tEnd: v });
    const updated = useStore.getState().tracks.find((x) => x.id === t.id)!;
    if (updated.fixed) return;
    const sSec = updated.tStart ?? clip.in;
    const eSec = updated.tEnd ?? clip.out;
    if (eSec <= sSec) return;
    const f0 = Math.round(sSec * clip.fps);
    const f1 = Math.round(eSec * clip.fps);
    const covered = Object.keys(updated.dense).some(
      (f) => +f >= f0 && +f <= f1
    );
    if (!covered) s.markDirty(t.id, f0);
  };

  const saveProject = async () => {
    const s = useStore.getState();
    if (s.clips.length === 0) return;
    const path = await save({
      defaultPath: "project.vproj.json",
      filters: [{ name: "PixelMask 项目", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await api.saveProject(path, {
        version: 1,
        clips: s.clips,
        tracks: s.tracks,
      });
      setNotice({ title: "项目已保存", msg: path, path });
    } catch (e) {
      setNotice({
        title: "保存失败",
        msg: `${e instanceof Error ? e.message : e}`,
      });
    }
  };

  const openProject = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "PixelMask 项目", extensions: ["json"] }],
    });
    if (!path || Array.isArray(path)) return;
    try {
      const data = await api.loadProject(path);
      if (data.version !== 1 || !Array.isArray(data.clips) || !Array.isArray(data.tracks)) {
        setNotice({ title: "打开失败", msg: "项目文件格式不受支持" });
        return;
      }
      const clips: Clip[] = [];
      const skipped: string[] = [];
      for (const c of data.clips as Clip[]) {
        try {
          await api.probe(c.src);
          clips.push(c);
        } catch {
          skipped.push(c.src.split("/").pop() ?? c.src);
        }
      }
      const clipIds = new Set(clips.map((c) => c.id));
      const tracks = (data.tracks as Track[]).filter((t) => clipIds.has(t.clipId));
      if (clips.length === 0) {
        setNotice({
          title: "打开失败",
          msg: `所有源视频均不可用：${skipped.join("、")}`,
        });
        return;
      }
      useStore.getState().loadProject(clips, tracks);
      if (skipped.length) {
        setNotice({
          title: "部分片段缺失",
          msg: `以下源视频不可用，已从项目中移除：${skipped.join("、")}`,
        });
      }
    } catch (e) {
      setNotice({
        title: "打开失败",
        msg: `${e instanceof Error ? e.message : e}`,
      });
    }
  };

  const loc = locate(clips, currentTime);
  const clipTracks = loc ? tracks.filter((t) => t.clipId === loc.clip.id) : [];
  const selected = tracks.find((t) => t.id === selectedTrackId) ?? null;

  return (
    <main className="app">
      <header className="toolbar">
        <button onClick={importVideo} disabled={!sidecarReady}>
          导入视频
        </button>
        <button onClick={openProject} disabled={!sidecarReady} title="打开 .vproj.json 项目文件">
          打开项目
        </button>
        <button onClick={saveProject} disabled={!sidecarReady || clips.length === 0} title="保存为 .vproj.json 项目文件">
          保存项目
        </button>
        <span className="sep" />
        <button onClick={() => useStore.getState().undo()} disabled={!canUndo} title="撤销 (⌘Z)">
          ↩ 撤销
        </button>
        <button onClick={() => useStore.getState().redo()} disabled={!canRedo} title="重做 (⇧⌘Z)">
          ↪ 重做
        </button>
        <span className="sep" />
        <button
          className={tool === "crop" ? "active" : ""}
          onClick={() =>
            useStore.getState().setTool(tool === "crop" ? "select" : "crop")
          }
        >
          裁切画面
        </button>
        {loc?.clip.crop && (
          <button onClick={() => {
            useStore.getState().pushHistory();
            useStore.getState().updateClip(loc.clip.id, { crop: null });
          }}>
            清除裁切
          </button>
        )}
        <span className="sep" />
        <button className="export" onClick={exportVideo} disabled={!sidecarReady || clips.length === 0 || renderPct !== null}>
          {renderPct !== null ? `导出中 ${renderPct}%` : "导出 MP4"}
        </button>
        {renderPct !== null && (
          <button onClick={cancelExport} title="终止当前导出任务">
            取消导出
          </button>
        )}
        <span className="status">
          {sidecarReady ? (busy ?? "") : "引擎未连接（自动重试中）…"}
        </span>
        <button
          className="about-btn"
          onClick={() => setShowSettings(true)}
          title="设置"
        >
          ⚙
        </button>
        <button
          className="about-btn"
          onClick={() => setShowLicenses(true)}
          title="关于与开源许可"
        >
          ⓘ
        </button>
      </header>

      <section className="workspace">
        <PreviewPlayer />
        <aside className="track-panel">
          <h3>遮挡框 ({clipTracks.length})</h3>
          {clipTracks.map((t: Track) => (
            <div
              key={t.id}
              className={`track-item ${t.id === selectedTrackId ? "active" : ""}`}
              onClick={() => useStore.getState().setSelectedTrack(t.id)}
            >
              <span className="dot" style={t.fixed ? { background: "#b88fff" } : undefined} />
              <span>{t.fixed ? "固定遮罩" : "遮罩"}</span>
              <span className="track-range">
                {(t.tStart ?? loc?.clip.in ?? 0).toFixed(1)}–
                {(t.tEnd ?? loc?.clip.out ?? 0).toFixed(1)}s
              </span>
              <select
                value={t.effect}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  useStore.getState().pushHistory();
                  useStore.getState().updateTrack(t.id, {
                    effect: e.target.value as Track["effect"],
                  });
                }}
              >
                <option value="pixelate">马赛克</option>
                <option value="blur">高斯模糊</option>
                <option value="blackbox">黑框</option>
              </select>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().pushHistory();
                  useStore.getState().removeTrack(t.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {selected && (
            <div className="track-window">
              <label>
                出现(s)
                <NumberField
                  step={0.1}
                  placeholder={loc?.clip.in.toFixed(1)}
                  value={selected.tStart}
                  onCommit={(v) => setTrackWindow(selected, "start", v)}
                />
              </label>
              <label>
                消失(s)
                <NumberField
                  step={0.1}
                  placeholder={loc?.clip.out.toFixed(1)}
                  value={selected.tEnd}
                  onCommit={(v) => setTrackWindow(selected, "end", v)}
                />
              </label>
            </div>
          )}
          <details className="hint-details">
            <summary>操作帮助</summary>
            <p className="hint">
              在画面空白处按住拖动 = 创建遮罩；Shift+拖动 =
              固定遮罩（不跟踪）；点住框内部 = 拖动；点住边框 =
              调整大小；双击框 = 在此时间结束。编辑不影响已跟踪内容，按播放键时才统一跟踪。
            </p>
            <p className="hint">
              「扫描人脸」= 自动识别整个视频中的人脸并创建跟踪遮罩。
              圈选遮罩后，首次播放或导出时会自动向前、向后跟踪整个片段。
            </p>
            <p className="hint">
              空格 = 播放/暂停；I = 入点，O = 出点，S = 分割；
              Delete = 删除选中遮罩；←/→ = 逐帧（Shift = ±1s）；
              Esc = 退出裁切/取消选中；⌘Z = 撤销，⇧⌘Z = 重做。
            </p>
          </details>
        </aside>
      </section>

      <Timeline />

      {syncError && (
        <div className="startup-overlay">
          <div className="startup-box" onClick={(e) => e.stopPropagation()}>
            <h2>跟踪失败</h2>
            <p className="notice-msg">{syncError}</p>
            <div className="notice-actions">
              <button
                className="crop-confirm"
                onClick={() => {
                  useStore.getState().setSyncError(null);
                  syncDirtyTracks();
                }}
              >
                重试
              </button>
              <button onClick={() => useStore.getState().setSyncError(null)}>
                忽略
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="startup-overlay" onClick={() => setShowSettings(false)}>
          <div
            className="startup-box license-box"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>设置</h2>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={personSegmentation}
                onChange={(e) => {
                  const v = e.target.checked;
                  setPersonSegmentation(v);
                  localStorage.setItem("vr.personSegmentation", v ? "1" : "0");
                }}
              />
              <span>
                <b>导出时精确人像轮廓</b>
                <br />
                <span className="settings-hint">
                  开启后用 Apple 神经引擎生成贴合人形的遮罩边缘，导出时间明显增加
                </span>
              </span>
            </label>
            <div className="notice-actions">
              <button className="crop-confirm" onClick={() => setShowSettings(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {showLicenses && (
        <div className="startup-overlay" onClick={() => setShowLicenses(false)}>
          <div
            className="startup-box license-box"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>关于与开源许可</h2>
            <p className="notice-msg" style={{ maxWidth: "none" }}>
              PixelMask · 所有处理均在本地完成
            </p>
            <div className="notice-actions" style={{ marginTop: 0 }}>
              <button
                onClick={() =>
                  openUrl("https://video-redactor-privacy.tully-hu.workers.dev").catch(() => {})
                }
              >
                查看隐私政策
              </button>
            </div>
            <div className="license-text">{licensesText}</div>
            <div className="notice-actions">
              <button className="crop-confirm" onClick={() => setShowLicenses(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="startup-overlay" onClick={() => setNotice(null)}>
          <div className="startup-box" onClick={(e) => e.stopPropagation()}>
            <h2>{notice.title}</h2>
            <p className="notice-msg">{notice.msg}</p>
            <div className="notice-actions">
              {notice.path && (
                <button
                  onClick={() =>
                    revealItemInDir(notice.path!).catch(() => {})
                  }
                >
                  在 Finder 中显示
                </button>
              )}
              <button className="crop-confirm" onClick={() => setNotice(null)}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {!sidecarReady && (
        <div className="startup-overlay">
          <div className="startup-box">
            <div className="spinner" />
            <h2>正在启动视频引擎…</h2>
            <p>
              已等待 {startupElapsed} 秒
              {startupElapsed < 60 ? "，通常只需几秒，请稍候" : ""}
            </p>
            <div className="progress-track">
              <div
                className="progress-bar"
                style={{
                  width: `${Math.min(95, (startupElapsed / 30) * 100)}%`,
                }}
              />
            </div>
            {startupElapsed >= 60 && (
              <p className="startup-warn">
                启动时间异常偏长，请尝试退出软件后重新打开
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
