import { useCallback, useEffect, useRef, useState } from "react";
import { ActiveSelection, Canvas, type FabricObject, IText, Point } from "fabric";
import type { Project, SceneEdge } from "@diagram/core";
import { api, fileUrl } from "../lib/api";
import { InlineError } from "../ui/InlineError";
import { Spinner } from "../ui/Spinner";
import { toast } from "../ui/Toast";
import { fmtElapsed, useNow } from "../ui/time";
import { errorMessage } from "../ui/useAction";
import {
  buildFromScene,
  reconcile,
  sceneSvgs,
  findNode,
  getData,
  labelObject,
  labelsOf,
  loadSvgObject,
  normColor,
  placeInBox,
  refreshEdges,
  replaceColor,
  restore,
  sceneRect,
  serialize,
  usedColors,
  type WorkspaceDoc,
} from "./fabricScene";
import "./workspace.css";

type RebuildMode = "original" | "trace" | "regenerate" | "native";
type Rect = ReturnType<typeof sceneRect>;
type LoadState = { status: "loading" | "ready" | "empty" | "error"; message?: string };
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const SWATCH_LIMIT = 14;
const isMac = /Mac|iP(hone|ad)/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

function download(name: string, href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}

export function Workspace({ project }: { project: Project }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const edgesRef = useRef<SceneEdge[]>([]);
  const sizeRef = useRef({ width: 1600, height: 1000 });
  // Snapshots are JSON strings so identical commits can be skipped cheaply.
  const history = useRef<{ stack: string[]; index: number; muted: boolean }>({ stack: [], index: -1, muted: false });
  const saveTimer = useRef<number>(0);
  const pendingSave = useRef<WorkspaceDoc | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  // While a colour picker is open: which swatch it started from and the colour currently applied.
  const liveColor = useRef<{ from: string; cur: string } | null>(null);
  const pendingIds = useRef(new Set<string>());
  /** Scene SVG per node that the canvas reflects (saved with the doc). */
  const seenSvgs = useRef<Record<string, string>>({});

  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<FabricObject[]>([]);
  const [palette, setPalette] = useState<string[]>([]);
  const [selPalette, setSelPalette] = useState<string[]>([]);
  const [showAllColors, setShowAllColors] = useState(false);
  const [, force] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [arranging, setArranging] = useState<string | null>(null);
  const [hover, setHover] = useState<Rect | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [rebuildErrors, setRebuildErrors] = useState<Record<string, string>>({});
  const [rebuildMode, setRebuildMode] = useState<RebuildMode>("regenerate");
  const [rebuildNote, setRebuildNote] = useState("");
  const now = useNow(Object.keys(pending).length > 0);

  const urlFor = useCallback((rel: string) => fileUrl(project.id, rel), [project.id]);

  const refreshPanels = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const sel = c.getActiveObjects();
    setSelection(sel);
    setSelPalette(usedColors(sel));
    setPalette(usedColors(c.getObjects(), edgesRef.current));
    force((n) => n + 1);
  }, []);

  // ---- saving: debounced, serialized, retried on demand ----
  const flushSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    const doc = pendingSave.current;
    if (!doc) return saveChain.current;
    pendingSave.current = null;
    setSaveState("saving");
    saveChain.current = saveChain.current.then(() =>
      api.put(`/api/projects/${project.id}/workspace`, { workspace: doc }).then(
        () => setSaveState(pendingSave.current ? "pending" : "saved"),
        () => {
          pendingSave.current ??= doc;
          setSaveState("error");
        },
      ),
    );
    return saveChain.current;
  }, [project.id]);

  const scheduleSave = useCallback(
    (doc: WorkspaceDoc) => {
      pendingSave.current = doc;
      setSaveState("pending");
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushSave, 700);
    },
    [flushSave],
  );

  /** Record a history snapshot (if anything changed) and schedule a save. */
  const commit = useCallback(
    (save = true) => {
      const c = canvasRef.current;
      if (!c || history.current.muted) return;
      const doc = serialize(c, edgesRef.current, sizeRef.current, seenSvgs.current);
      const json = JSON.stringify(doc);
      const h = history.current;
      if (json !== h.stack[h.index]) {
        h.stack = h.stack.slice(0, h.index + 1).concat(json).slice(-60);
        h.index = h.stack.length - 1;
        if (save) scheduleSave(doc);
      }
      refreshPanels();
    },
    [scheduleSave, refreshPanels],
  );

  const applyZoom = useCallback((z: number) => {
    const c = canvasRef.current;
    if (!c) return;
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    c.setZoom(z);
    c.setDimensions({ width: sizeRef.current.width * z, height: sizeRef.current.height * z });
    setZoom(z);
  }, []);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { width, height } = sizeRef.current;
    applyZoom(Math.min(1, (wrap.clientWidth - 32) / width, (wrap.clientHeight - 32) / height));
  }, [applyZoom]);

  /** Replace the canvas contents. Returns ids of nodes whose SVG could not be loaded. */
  const loadDoc = useCallback(
    async (doc: WorkspaceDoc | null, fromScene = project.scene, refit = true) => {
      const c = canvasRef.current;
      const signal = abortRef.current?.signal;
      if (!c) return [];
      let failed: string[] = [];
      history.current.muted = true;
      try {
        if (doc) {
          await restore(c, doc, signal);
          sizeRef.current = { width: doc.width, height: doc.height };
          edgesRef.current = doc.edges;
          if (doc.svgs) seenSvgs.current = doc.svgs;
        } else if (fromScene) {
          failed = await buildFromScene(c, fromScene, urlFor, signal);
          sizeRef.current = { width: fromScene.width, height: fromScene.height };
          edgesRef.current = fromScene.edges;
          seenSvgs.current = sceneSvgs(fromScene);
        }
      } finally {
        history.current.muted = false;
      }
      if (signal?.aborted) return failed;
      refreshEdges(c, edgesRef.current);
      if (refit) fit();
      else applyZoom(c.getZoom());
      setHover(null);
      return failed;
    },
    [project.scene, urlFor, fit, applyZoom],
  );

  const initialLoad = useCallback(
    async (fromScene = false) => {
      const signal = abortRef.current?.signal;
      const doc = fromScene ? null : ((project.workspace as WorkspaceDoc | null) ?? null);
      if (!doc && !project.scene) return setLoad({ status: "empty" });
      setLoad({ status: "loading" });
      try {
        const failed = await loadDoc(doc);
        if (signal?.aborted) return;
        // Components rebuilt since the last save (e.g. from the Components step) replace their old version.
        let updated = 0;
        const c = canvasRef.current;
        if (doc && project.scene && c) {
          history.current.muted = true;
          try {
            updated = await reconcile(c, project.scene, doc.svgs, urlFor, signal);
          } finally {
            history.current.muted = false;
          }
          if (signal?.aborted) return;
          seenSvgs.current = sceneSvgs(project.scene);
          if (updated) refreshEdges(c, edgesRef.current);
        }
        commit(fromScene || updated > 0);
        if (updated) toast(`${updated} rebuilt component${updated > 1 ? "s" : ""} updated on the canvas.`);
        setLoad({ status: "ready" });
        if (failed.length) toast.error(`${failed.length} component${failed.length > 1 ? "s" : ""} could not be loaded and ${failed.length > 1 ? "were" : "was"} left out.`);
      } catch (e) {
        if (!signal?.aborted) setLoad({ status: "error", message: errorMessage(e) });
      }
    },
    [project.workspace, project.scene, loadDoc, commit, urlFor],
  );

  // ---- mount: create canvas, wire events, load once ----
  useEffect(() => {
    const c = new Canvas(elRef.current!, {
      preserveObjectStacking: true,
      selectionColor: "rgba(59,91,219,0.08)",
      selectionBorderColor: "#3b5bdb",
      selectionLineWidth: 1,
    });
    canvasRef.current = c;
    const ac = new AbortController();
    abortRef.current = ac;

    // Labels follow their node(s) while dragged, unless they are part of the selection themselves.
    let drag: { target: FabricObject; left: number; top: number; labels: { o: FabricObject; left: number; top: number }[] } | null = null;
    c.on("mouse:down", () => {
      setHover(null);
      const t = c.getActiveObject();
      const sel = c.getActiveObjects();
      const ids = new Set(sel.flatMap((o) => (getData(o)?.kind === "node" ? [(getData(o) as { id: string }).id] : [])));
      drag =
        t && ids.size
          ? {
              target: t,
              left: t.left,
              top: t.top,
              labels: labelsOf(c, ids)
                .filter((o) => !sel.includes(o))
                .map((o) => ({ o, left: o.left, top: o.top })),
            }
          : null;
    });
    c.on("object:moving", (e) => {
      if (drag && e.target === drag.target) {
        const dx = drag.target.left - drag.left;
        const dy = drag.target.top - drag.top;
        for (const l of drag.labels) {
          l.o.set({ left: l.left + dx, top: l.top + dy });
          l.o.setCoords();
        }
      }
      refreshEdges(c, edgesRef.current);
    });
    c.on("object:scaling", () => refreshEdges(c, edgesRef.current));
    c.on("object:rotating", () => refreshEdges(c, edgesRef.current));
    c.on("object:modified", () => {
      refreshEdges(c, edgesRef.current);
      commit();
    });
    c.on("mouse:over", (e) => {
      const t = e.target;
      if (t?.selectable && t !== c.getActiveObject() && !c.getActiveObjects().includes(t)) setHover(sceneRect(t));
    });
    c.on("mouse:out", () => setHover(null));
    c.on("text:changed", () => refreshPanels());
    c.on("text:editing:exited", () => commit());
    c.on("selection:created", refreshPanels);
    c.on("selection:updated", refreshPanels);
    c.on("selection:cleared", refreshPanels);

    // Defer one tick so StrictMode's throwaway mount never starts loading.
    queueMicrotask(() => !ac.signal.aborted && initialLoad());

    const onResize = () => fit();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingSave.current) e.preventDefault();
    };
    addEventListener("resize", onResize);
    addEventListener("beforeunload", onBeforeUnload);
    return () => {
      ac.abort();
      removeEventListener("resize", onResize);
      removeEventListener("beforeunload", onBeforeUnload);
      flushSave(); // leaving the workspace must not drop the last edit
      c.dispose();
      canvasRef.current = null;
    };
    // Load once per mount: later SSE snapshots must not clobber local edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A scene can arrive while the workspace is open (e.g. a build finishing).
  useEffect(() => {
    if (load.status === "empty" && project.scene) initialLoad();
  }, [load.status, project.scene, initialLoad]);

  // ---- actions ----
  const h = history.current;
  const canUndo = h.index > 0;
  const canRedo = h.index < h.stack.length - 1;
  const ready = load.status === "ready";

  const undo = async (dir: -1 | 1) => {
    const next = h.index + dir;
    if (!ready || arranging || next < 0 || next >= h.stack.length) return;
    h.index = next;
    const doc = JSON.parse(h.stack[next]) as WorkspaceDoc;
    await loadDoc(doc, undefined, false);
    scheduleSave(doc);
    refreshPanels();
  };

  const remove = (objs: FabricObject[]) => {
    const c = canvasRef.current!;
    c.discardActiveObject();
    objs.forEach((o) => c.remove(o));
    refreshEdges(c, edgesRef.current);
    commit();
  };

  /** Move objects by a delta; nodes bring their (unselected) labels along. */
  const nudge = (objs: FabricObject[], dx: number, dy: number) => {
    const c = canvasRef.current!;
    const ids = new Set(objs.flatMap((o) => (getData(o)?.kind === "node" ? [(getData(o) as { id: string }).id] : [])));
    const active = c.getActiveObject();
    const movers = active && objs.length > 1 ? [active] : objs;
    for (const o of [...movers, ...labelsOf(c, ids).filter((l) => !objs.includes(l))]) {
      o.set({ left: o.left + dx, top: o.top + dy });
      o.setCoords();
    }
    refreshEdges(c, edgesRef.current);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = canvasRef.current;
      if (!c || !ready) return;
      const editing = c.getActiveObject() instanceof IText && (c.getActiveObject() as IText).isEditing;
      if (editing || (e.target as HTMLElement).closest("input,textarea,select")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const sel = c.getActiveObjects();
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        undo(e.shiftKey || key === "y" ? 1 : -1);
      } else if (mod && key === "0") {
        e.preventDefault();
        fit();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (!sel.length) return;
        e.preventDefault();
        remove(sel);
      } else if (e.key === "Escape") {
        c.discardActiveObject();
        c.requestRenderAll();
      } else if (e.key.startsWith("Arrow") && sel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (d) nudge(sel, d[0], d[1]);
      } else if (!mod && key === "t" && !e.altKey) {
        e.preventDefault(); // otherwise the "t" lands in the new text box
        addText();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow") && canvasRef.current?.getActiveObjects().length && !(e.target as HTMLElement).closest("input,textarea,select")) commit();
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKeyUp);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKeyUp);
    };
  });

  // ⌘/Ctrl + wheel zooms the canvas instead of the page.
  useEffect(() => {
    const wrap = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !canvasRef.current) return;
      e.preventDefault();
      applyZoom(canvasRef.current.getZoom() * Math.exp(-e.deltaY * 0.002));
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const recolor = (from: string, to: string) => {
    const c = canvasRef.current!;
    const live = liveColor.current?.from === from ? liveColor.current.cur : from;
    const scope = selection.length ? selection : c.getObjects();
    replaceColor(scope, live, to);
    if (!selection.length) edgesRef.current = edgesRef.current.map((e) => (normColor(e.color) === live ? { ...e, color: to } : e));
    liveColor.current = { from, cur: to };
    refreshEdges(c, edgesRef.current);
    force((n) => n + 1);
  };
  const endRecolor = () => {
    if (!liveColor.current) return;
    liveColor.current = null;
    commit();
  };

  const relayout = async (mode: "original" | "auto") => {
    const label = mode === "original" ? "the layout of the picked image" : "an automatic layout";
    const edited = h.index > 0 || !!project.workspace;
    if (edited && !confirm(`Re-arrange using ${label}?\n\nYour manual edits here (moves, colours, text, deletions) will be replaced. You can undo this afterwards.`)) return;
    setArranging(mode === "original" ? "Arranging as in the image…" : "Arranging automatically…");
    try {
      await flushSave();
      const p = await api.post<Project>(`/api/projects/${project.id}/layout`, { mode });
      await loadDoc(null, p.scene);
      commit();
      toast.success("Diagram re-arranged");
    } catch (e) {
      toast.error(`Arrange failed: ${errorMessage(e)}`);
    } finally {
      setArranging(null);
    }
  };

  const flashExported = (what: string) => {
    setExported(what);
    setTimeout(() => setExported((x) => (x === what ? null : x)), 2000);
  };

  const exportSvg = () => {
    const c = canvasRef.current!;
    c.discardActiveObject();
    const z = c.getZoom();
    applyZoom(1);
    const svg = c.toSVG();
    applyZoom(z);
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    download(`${slug(project)}.svg`, url);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashExported("svg");
  };

  const exportPng = () => {
    const c = canvasRef.current!;
    c.discardActiveObject();
    c.requestRenderAll();
    download(`${slug(project)}.png`, c.toDataURL({ format: "png", multiplier: 2 / c.getZoom() }));
    flashExported("png");
  };

  const addText = () => {
    const c = canvasRef.current!;
    const wrap = wrapRef.current!;
    const z = c.getZoom();
    // Drop it in the middle of what is currently visible.
    const x = Math.min(sizeRef.current.width - 40, (wrap.scrollLeft + wrap.clientWidth / 2) / z);
    const y = Math.min(sizeRef.current.height - 40, (wrap.scrollTop + Math.min(wrap.clientHeight, c.getHeight()) / 2) / z);
    const t = labelObject("Text", x, y, 32, "#1f2937", null);
    c.add(t);
    c.setActiveObject(t);
    commit();
    t.enterEditing();
    t.selectAll();
  };

  const arrange = (fn: "bringObjectToFront" | "sendObjectToBack" | "bringObjectForward" | "sendObjectBackwards") => {
    const c = canvasRef.current!;
    for (const o of selection) c[fn](o);
    refreshEdges(c, edgesRef.current);
    commit();
  };

  const alignRows = () => {
    const c = canvasRef.current!;
    const cy = selection.reduce((s, o) => s + o.getCenterPoint().y, 0) / selection.length;
    c.discardActiveObject();
    selection.forEach((o) => {
      const p = o.getCenterPoint();
      o.setPositionByOrigin(new Point(p.x, cy), "center", "center");
      o.setCoords();
    });
    c.setActiveObject(new ActiveSelection(selection, { canvas: c }));
    refreshEdges(c, edgesRef.current);
    commit();
  };

  const rebuild = async (nodeId: string, componentId: string) => {
    if (pendingIds.current.has(nodeId)) return;
    pendingIds.current.add(nodeId);
    setPending((p) => ({ ...p, [nodeId]: Date.now() }));
    setRebuildErrors(({ [nodeId]: _, ...rest }) => rest);
    try {
      const out = await api.post<{ svg: string; fidelity?: number }>(`/api/projects/${project.id}/components/${componentId}/rebuild`, {
        regenerate: rebuildMode === "regenerate",
        nativeSvg: rebuildMode === "native",
        keepOriginal: rebuildMode === "original",
        feedback: rebuildNote || undefined,
      });
      const fresh = await loadSvgObject(urlFor(out.svg));
      const c = canvasRef.current;
      if (!c) return;
      // Look the node up again: it may have moved, been undone/redone or deleted meanwhile.
      const node = findNode(c, nodeId);
      if (!node) return void toast("Component regenerated, but it is no longer on the canvas.");
      placeInBox(fresh, sceneRect(node));
      (fresh as any).data = getData(node);
      seenSvgs.current = { ...seenSvgs.current, [nodeId]: out.svg };
      const wasActive = c.getActiveObjects().includes(node);
      const reselect = wasActive && c.getActiveObjects().length === 1;
      if (wasActive) c.discardActiveObject();
      const idx = c.getObjects().indexOf(node);
      c.remove(node);
      c.insertAt(idx, fresh);
      if (reselect) c.setActiveObject(fresh);
      refreshEdges(c, edgesRef.current);
      commit();
      setRebuildNote("");
      toast.success(
        rebuildMode === "original"
          ? "Restored the original pixels"
          : out.fidelity != null
            ? `Vectorized — matches the original ${Math.round(out.fidelity * 100)}%${out.fidelity < 0.95 ? " (the original pixels may look better)" : ""}`
            : "Component regenerated",
      );
    } catch (e) {
      setRebuildErrors((r) => ({ ...r, [nodeId]: errorMessage(e) }));
    } finally {
      pendingIds.current.delete(nodeId);
      setPending(({ [nodeId]: _, ...rest }) => rest);
    }
  };

  // ---- inspector bindings ----
  const single = selection.length === 1 ? selection[0] : null;
  const singleData = getData(single ?? undefined);
  const setProp = (o: FabricObject, props: Record<string, unknown>) => {
    o.set(props);
    o.setCoords();
    refreshEdges(canvasRef.current!, edgesRef.current);
    canvasRef.current!.requestRenderAll();
    force((n) => n + 1);
  };
  const num = (v: string, min = -Infinity) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) && n >= min ? n : null;
  };
  const colors = selection.length ? selPalette : palette;
  const shownColors = showAllColors ? colors : colors.slice(0, SWATCH_LIMIT);
  const nodePending = singleData?.kind === "node" ? pending[singleData.id] : undefined;
  const nodeError = singleData?.kind === "node" ? rebuildErrors[singleData.id] : undefined;
  const c = canvasRef.current;

  return (
    <div className="workspace">
      <div className="toolbar">
        <button onClick={() => undo(-1)} disabled={!ready || !canUndo} title={`Undo (${MOD}Z)`}>
          ↶ Undo
        </button>
        <button onClick={() => undo(1)} disabled={!ready || !canRedo} title={`Redo (${isMac ? "⇧⌘Z" : "Ctrl+Y"})`}>
          ↷ Redo
        </button>
        <span className="sep" />
        <button onClick={addText} disabled={!ready} title="Add a text box (T)">
          + Text
        </button>
        <span className="sep" />
        <span className="muted small">Arrange:</span>
        <button
          onClick={() => relayout("original")}
          disabled={!ready || !!arranging}
          title="Place components where they were in the picked image (replaces manual edits)"
        >
          As in image
        </button>
        <button
          onClick={() => relayout("auto")}
          disabled={!ready || !!arranging}
          title={`Lay components out automatically${project.concept?.layoutIntent ? ` as a ${project.concept.layoutIntent}` : ""} (replaces manual edits)`}
        >
          Auto{project.concept?.layoutIntent ? ` (${project.concept.layoutIntent})` : ""}
        </button>
        <span className="sep" />
        <button onClick={() => applyZoom(zoom / 1.2)} disabled={!ready || zoom <= MIN_ZOOM} title={`Zoom out (${MOD}scroll)`} aria-label="Zoom out">
          −
        </button>
        <button className="ws-zoom" onClick={() => applyZoom(1)} disabled={!ready} title="Reset to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => applyZoom(zoom * 1.2)} disabled={!ready || zoom >= MAX_ZOOM} title={`Zoom in (${MOD}scroll)`} aria-label="Zoom in">
          +
        </button>
        <button onClick={fit} disabled={!ready} title={`Fit to screen (${MOD}0)`}>
          Fit
        </button>
        <span className="grow" />
        <SaveStatus state={saveState} onRetry={flushSave} />
        <span className="sep" />
        <button onClick={exportPng} disabled={!ready} title="Download a PNG at 2× resolution">
          {exported === "png" ? "✓ Downloaded" : "Export PNG"}
        </button>
        <button className="primary" onClick={exportSvg} disabled={!ready} title="Download an editable SVG">
          {exported === "svg" ? "✓ Downloaded" : "Export SVG"}
        </button>
      </div>

      <div className="ws-body">
        <div className="canvas-wrap" ref={wrapRef}>
          <div className="ws-stage" style={{ visibility: ready || arranging ? "visible" : "hidden" }}>
            <canvas ref={elRef} />
            {hover && ready && !arranging && (
              <div className="ws-hover" style={rectStyle(hover, zoom)} />
            )}
            {c &&
              Object.entries(pending).map(([id, started]) => {
                const node = findNode(c, id);
                return (
                  node && (
                    <div key={id} className="ws-pending" style={rectStyle(sceneRect(node), zoom)}>
                      <span>
                        <Spinner /> Regenerating… {fmtElapsed(now - started)}
                      </span>
                    </div>
                  )
                );
              })}
          </div>
          {load.status === "loading" && (
            <div className="ws-overlay">
              <Spinner size={22} />
              <span>Loading diagram…</span>
            </div>
          )}
          {arranging && (
            <div className="ws-overlay ws-overlay-dim">
              <Spinner size={22} />
              <span>{arranging}</span>
            </div>
          )}
          {load.status === "empty" && (
            <div className="ws-overlay">
              <strong>Nothing to edit yet</strong>
              <span className="muted">Build the components in step 4 and the diagram will be laid out here.</span>
            </div>
          )}
          {load.status === "error" && (
            <div className="ws-overlay">
              <strong>Couldn't open this workspace</strong>
              <span className="muted small">{load.message}</span>
              <div className="btn-row">
                <button onClick={() => initialLoad()}>Try again</button>
                {project.scene && (
                  <button className="primary" onClick={() => initialLoad(true)} title="Discards the saved manual edits">
                    Start over from the layout
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="inspector">
          {ready && !selection.length && (
            <section className="ws-hints">
              <h4>Workspace</h4>
              <p className="small">Select something on the canvas to edit it.</p>
              <ul className="small">
                <li>
                  <b>Drag</b> to move — labels follow their icon
                </li>
                <li>
                  <b>Shift-click</b> or drag a box to select several
                </li>
                <li>
                  <b>Double-click</b> text to edit it
                </li>
                <li>
                  <kbd>←↑→↓</kbd> nudge · <kbd>Shift</kbd> ×10
                </li>
                <li>
                  <kbd>Delete</kbd> remove · <kbd>Esc</kbd> deselect
                </li>
                <li>
                  <kbd>{MOD}Z</kbd> undo · <kbd>T</kbd> add text
                </li>
                <li>
                  <kbd>{MOD}scroll</kbd> zoom · <kbd>{MOD}0</kbd> fit
                </li>
              </ul>
            </section>
          )}

          {ready && selection.length > 1 && (
            <p className="small ws-selcount">
              <b>{selection.length}</b> items selected
            </p>
          )}

          {ready && (
            <section>
              <h4>{selection.length ? "Colours in selection" : "All colours"}</h4>
              <p className="muted small ws-help">
                {selection.length
                  ? "Changes apply only to the selected items."
                  : "Changes apply everywhere. Select items first to recolour just them."}
              </p>
              <div className="palette editable">
                {shownColors.map((col) => (
                  <label key={col} className="swatch" style={{ background: liveColor.current?.from === col ? liveColor.current.cur : col }} title={`${col} — click to change`}>
                    <input
                      type="color"
                      value={liveColor.current?.from === col ? liveColor.current.cur : col}
                      onChange={(e) => recolor(col, e.target.value)}
                      onBlur={endRecolor}
                    />
                  </label>
                ))}
              </div>
              {colors.length > SWATCH_LIMIT && (
                <button className="ws-link" onClick={() => setShowAllColors((v) => !v)}>
                  {showAllColors ? "Show fewer" : `Show all ${colors.length} colours`}
                </button>
              )}
              {project.concept && (
                <>
                  <div className="muted small">Concept palette (reference)</div>
                  <div className="palette">
                    {project.concept.palette.map((p) => (
                      <span key={p.hex} className="swatch small" title={`${p.name} ${p.hex}`} style={{ background: p.hex }} />
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {single && (
            <section>
              <h4>{singleData?.kind === "label" ? "Text" : singleData?.kind === "node" ? "Component" : "Object"}</h4>
              {single instanceof IText && (
                <>
                  <textarea
                    rows={2}
                    value={single.text}
                    onChange={(e) => setProp(single, { text: e.target.value })}
                    onBlur={() => commit()}
                  />
                  <div className="grid2">
                    <label>
                      Size
                      <input
                        type="number"
                        min={4}
                        value={single.fontSize}
                        onChange={(e) => {
                          const v = num(e.target.value, 4);
                          if (v !== null) setProp(single, { fontSize: v });
                        }}
                        onBlur={() => commit()}
                      />
                    </label>
                    <label>
                      Weight
                      <select value={String(single.fontWeight)} onChange={(e) => (setProp(single, { fontWeight: e.target.value }), commit())}>
                        {["400", "600", "800"].map((w) => (
                          <option key={w}>{w}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Font
                    <select value={single.fontFamily} onChange={(e) => (setProp(single, { fontFamily: e.target.value }), commit())}>
                      {FONTS.includes(single.fontFamily) ? null : <option value={single.fontFamily}>{single.fontFamily.split(",")[0]}</option>}
                      {FONTS.map((f) => (
                        <option key={f} value={f}>
                          {f.split(",")[0]}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="grid2">
                {(["left", "top"] as const).map((k) => (
                  <label key={k}>
                    {k === "left" ? "X" : "Y"}
                    <input
                      type="number"
                      value={Math.round(single[k])}
                      onChange={(e) => {
                        const v = num(e.target.value);
                        if (v === null) return;
                        nudge([single], k === "left" ? v - single.left : 0, k === "top" ? v - single.top : 0);
                        force((n) => n + 1);
                      }}
                      onBlur={() => commit()}
                    />
                  </label>
                ))}
                <label>
                  Width
                  <input
                    type="number"
                    min={1}
                    value={Math.round(single.getScaledWidth())}
                    onChange={(e) => {
                      const v = num(e.target.value, 1);
                      if (v === null) return;
                      const s = v / single.width;
                      setProp(single, { scaleX: s, scaleY: s });
                    }}
                    onBlur={() => commit()}
                  />
                </label>
                <label>
                  Rotate°
                  <input
                    type="number"
                    value={Math.round(single.angle)}
                    onChange={(e) => {
                      const v = num(e.target.value);
                      if (v === null) return;
                      single.rotate(v);
                      setProp(single, {});
                    }}
                    onBlur={() => commit()}
                  />
                </label>
              </div>
            </section>
          )}

          {selection.length > 0 && (
            <section>
              <h4>Layer</h4>
              <div className="btn-row">
                <button onClick={() => arrange("bringObjectToFront")} title="Bring to front">
                  Front
                </button>
                <button onClick={() => arrange("bringObjectForward")} title="Bring forward one step">
                  Forward
                </button>
                <button onClick={() => arrange("sendObjectBackwards")} title="Send backward one step">
                  Backward
                </button>
                <button onClick={() => arrange("sendObjectToBack")} title="Send to back">
                  Back
                </button>
              </div>
              <div className="btn-row">
                {selection.length > 1 && (
                  <button onClick={alignRows} title="Line up the selected items on one horizontal row">
                    Align in a row
                  </button>
                )}
                <button className="ws-danger" onClick={() => remove(selection)} title="Delete (Delete / Backspace)">
                  Delete
                </button>
              </div>
            </section>
          )}

          {single && singleData?.kind === "node" && (
            <section>
              <h4>Regenerate this component</h4>
              <label>
                Method
                <select value={rebuildMode} onChange={(e) => setRebuildMode(e.target.value as RebuildMode)} disabled={!!nodePending}>
                  <option value="original">Original pixels (no vectorizing)</option>
                  <option value="trace">Vectorize (trace the original)</option>
                  <option value="regenerate">AI redraw + trace</option>
                  <option value="native">Native SVG (Recraft)</option>
                </select>
              </label>
              <label>
                Notes
                <input
                  placeholder="e.g. simpler, no text, face left"
                  value={rebuildNote}
                  onChange={(e) => setRebuildNote(e.target.value)}
                  disabled={!!nodePending}
                />
              </label>
              <button className="primary" disabled={!!nodePending} onClick={() => rebuild(singleData.id, singleData.componentId)}>
                {nodePending ? (
                  <>
                    <Spinner /> Regenerating… {fmtElapsed(now - nodePending)}
                  </>
                ) : (
                  "Regenerate"
                )}
              </button>
              <p className="muted small ws-help">
                {nodePending
                  ? "Usually takes 10–60s. You can keep editing; the new version replaces this one in place."
                  : "Replaces this component's artwork, keeping its position and size."}
              </p>
              <InlineError
                error={nodeError && `Regeneration failed: ${nodeError}`}
                onDismiss={() => setRebuildErrors(({ [singleData.id]: _, ...rest }) => rest)}
              />
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === "error")
    return (
      <span className="ws-save ws-save-error small" role="alert">
        Save failed{" "}
        <button className="ws-link" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  if (state === "pending" || state === "saving")
    return (
      <span className="ws-save small muted">
        <Spinner size={11} /> Saving…
      </span>
    );
  return <span className="ws-save small muted" title="Changes are saved automatically">{state === "saved" ? "✓ All changes saved" : "Autosave on"}</span>;
}

const FONTS = ["Inter, Helvetica, Arial, sans-serif", "Georgia, serif", "ui-monospace, Menlo, monospace", "Comic Sans MS, cursive"];

const rectStyle = (r: Rect, z: number) => ({ left: r.x * z, top: r.y * z, width: r.w * z, height: r.h * z });

const slug = (p: Project) =>
  (p.concept?.title ?? p.topic)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "diagram";
