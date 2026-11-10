import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FileText,
  FolderOpen,
  GripVertical,
  Info,
  ListOrdered,
  Pin,
  PinOff,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import type { ConflictInfo, LoadOrderItem, LoadOrderSuggestion, Snapshot } from "../types";
import { api, normalizeError } from "../lib/api";
import { categoryLabel, t, type MessageKey } from "../i18n";
import { Badge, EmptyState, Spinner, Toggle } from "./ui";

/**
 * 整理依据的类型 → 词条。
 *
 * 用静态映射而不是 `t(`loadOrder.reason.${kind}`)`：动态拼 key 在 i18n 门禁里查不出
 * 缺失词条，新增一种 reason 就会静默显示成 key 本身。
 */
const REASON_LABEL: Record<string, MessageKey> = {
  framework: "loadOrder.reasonFramework",
  conflict: "loadOrder.reasonConflict",
  conflictManual: "loadOrder.reasonManual",
  deployConflict: "loadOrder.reasonDeploy",
  ai: "loadOrder.reasonAi",
  fallback: "loadOrder.reasonFallback",
};

export function LoadOrderView({
  snapshot,
  conflicts,
  saving,
  onSave,
  onSaveRedmodOrder,
  onToggleWrite,
  onExport,
  onRemoveModlist,
  onOpenMod,
}: {
  snapshot: Snapshot;
  conflicts: ConflictInfo[];
  saving: boolean;
  onSave: (order: string[]) => Promise<void>;
  /** 保存 REDmod 顺序（元素是 mod id）。后端会顺手重跑一次 redMod 部署。 */
  onSaveRedmodOrder: (order: string[]) => Promise<void>;
  onToggleWrite: (enabled: boolean) => void;
  onExport: () => void;
  onRemoveModlist: () => void;
  onOpenMod: (modId: string) => void;
}) {
  const view = snapshot.loadOrder;
  const [items, setItems] = useState<LoadOrderItem[]>(view.archives);
  // REDmod 面板用上下箭头调序：REDmod 数量通常只有个位数，按钮比拖拽更省事，
  // 也顺带支持键盘用户。
  const [redmods, setRedmods] = useState<LoadOrderItem[]>(view.redmods);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const itemsRef = useRef(items);
  const dragRef = useRef<{
    id: string;
    from: number;
    offsetY: number;
    moved: boolean;
    ghost: HTMLDivElement;
  } | null>(null);

  useEffect(() => {
    setItems(view.archives);
  }, [view.archives]);

  useEffect(() => {
    setRedmods(view.redmods);
  }, [view.redmods]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const conflictMap = useMemo(() => {
    const map = new Map<string, ConflictInfo[]>();
    for (const conflict of conflicts) {
      const key = conflict.target.toLowerCase();
      const list = map.get(key) ?? [];
      list.push(conflict);
      map.set(key, list);
    }
    return map;
  }, [conflicts]);

  const liveConflicts = useMemo(() => conflicts.filter((conflict) => !conflict.pending), [conflicts]);
  const pendingConflicts = useMemo(
    () => conflicts.filter((conflict) => conflict.pending),
    [conflicts],
  );

  const [suggestion, setSuggestion] = useState<LoadOrderSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>(snapshot.state.loadOrderPins ?? []);

  /**
   * 求一份整理建议并**只做预览**：本地按建议顺序重排，不落盘。
   *
   * 直接写盘会让人没法反悔——158 行的顺序改完再想撤回，只能靠记忆拖回去。
   */
  const runSuggest = async (ai: boolean) => {
    if (saving || suggesting) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const result = await api.suggestLoadOrder(ai);
      setSuggestion(result);
      const byId = new Map(items.map((item) => [item.id, item]));
      const next = result.order
        .map((id) => byId.get(id))
        .filter((item): item is LoadOrderItem => Boolean(item));
      // 长度对不上说明建议里带了已不存在的项（期间卸载过），此时不预览，
      // 让用户重新点一次，而不是展示一个少了行的列表。
      if (next.length === items.length) {
        setItems(next.map((item, index) => ({ ...item, order: index })));
      }
    } catch (error) {
      setSuggestError(normalizeError(error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const discardSuggestion = () => {
    setSuggestion(null);
    setItems(view.archives);
  };

  const applySuggestion = async () => {
    if (!suggestion || suggestion.moves.length === 0) {
      setSuggestion(null);
      return;
    }
    await onSave(suggestion.order);
    setSuggestion(null);
  };

  const togglePin = async (modId: string) => {
    const next = pins.includes(modId) ? pins.filter((id) => id !== modId) : [...pins, modId];
    const previous = pins;
    setPins(next);
    try {
      await api.setLoadOrderPins(next);
    } catch (error) {
      setPins(previous);
      setSuggestError(normalizeError(error).message);
    }
  };

  const commit = async (next: LoadOrderItem[]) => {
    setItems(next);
    await onSave(next.map((item) => item.id));
  };

  const move = async (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    await commit(next);
  };

  const moveRedmod = async (from: number, to: number) => {
    if (saving || to < 0 || to >= redmods.length || from === to) return;
    const next = [...redmods];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // 先动界面再发请求：redMod 部署要几秒，等回来才动会让人觉得按钮没反应。
    setRedmods(next.map((item, index) => ({ ...item, order: index })));
    await onSaveRedmodOrder(next.map((item) => item.modId));
  };

  const startDrag = (event: ReactPointerEvent<HTMLSpanElement>, item: LoadOrderItem, index: number) => {
    if (event.button !== 0 || saving) return;
    const row = (event.currentTarget as HTMLElement).closest(".order-row") as HTMLDivElement | null;
    if (!row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const ghost = row.cloneNode(true) as HTMLDivElement;
    ghost.classList.add("order-drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    document.body.appendChild(ghost);
    document.body.classList.add("is-reordering");
    dragRef.current = {
      id: item.id,
      from: index,
      offsetY: event.clientY - rect.top,
      moved: false,
      ghost,
    };
    setDraggingId(item.id);
  };

  useEffect(() => {
    if (!draggingId) return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
      const current = itemsRef.current;
      const from = current.findIndex((item) => item.id === drag.id);
      let target = current.length;
      for (let index = 0; index < current.length; index += 1) {
        const element = rowRefs.current.get(current[index].id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          target = index;
          break;
        }
      }
      const insertAt = from < target ? target - 1 : target;
      if (from === -1 || insertAt === from) return;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(insertAt, 0, moved);
      itemsRef.current = next;
      drag.moved = true;
      setItems(next);
      // Keep the list area under the pointer while the ghost follows it.
      const list = listRef.current;
      if (list) {
        const bounds = list.getBoundingClientRect();
        if (event.clientY < bounds.top + 36) list.scrollBy({ top: -18, behavior: "auto" });
        else if (event.clientY > bounds.bottom - 36) list.scrollBy({ top: 18, behavior: "auto" });
      }
    };
    const finish = () => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.ghost.remove();
      document.body.classList.remove("is-reordering");
      dragRef.current = null;
      setDraggingId(null);
      if (drag.moved) void commit(itemsRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragRef.current?.ghost.remove();
      document.body.classList.remove("is-reordering");
    };
  }, [draggingId, onSave]);

  return (
    <div className="page loadorder-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">// LOAD ORDER / ARCHIVE PRIORITY</div>
          <h1>
            {t("sidebar.loadOrder")}<span className="h1-accent">.</span>
          </h1>
          <p className="page-sub">
            {t("loadOrder.introA")}<code>archive/pc/mod</code>{t("loadOrder.introB")}
            <code>modlist.txt</code>{t("loadOrder.introC")}
          </p>
        </div>
        <div className="head-actions">
          <button
            className="btn btn-primary"
            onClick={() => void runSuggest(false)}
            disabled={saving || suggesting || items.length === 0}
            title={t("loadOrder.autoArrangeHint")}
          >
            <Wand2 size={15} /> {t("loadOrder.autoArrange")}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => void runSuggest(true)}
            disabled={saving || suggesting || items.length === 0}
            title={t("loadOrder.autoArrangeAiHint")}
          >
            {suggesting ? <Spinner size={13} /> : <Sparkles size={15} />}{" "}
            {t("loadOrder.autoArrangeAi")}
          </button>
          <button className="btn btn-ghost" onClick={onExport} disabled={items.length === 0}>
            <FileText size={15} /> {t("loadOrder.writeModlist")}
          </button>
          <Badge tone={snapshot.state.settings.writeModlist ? "yellow" : view.modlistExists ? "red" : "muted"}>
            {snapshot.state.settings.writeModlist
              ? "NATIVE LIST ACTIVE"
              : view.modlistExists
                ? view.managedModlist
                  ? "MODLIST PRESENT / PAUSED"
                  : "UNMANAGED MODLIST"
                : "ASCII ORDER"}
          </Badge>
        </div>
      </header>

      <div className="loadorder-grid">
        <section className="panel order-panel">
          <div className="panel-head">
            <div>
              <div className="panel-eyebrow">// ARCHIVE PRIORITY</div>
              <h2>{t("loadOrder.archiveOrder")}</h2>
            </div>
            <div className="panel-meta">
              {saving ? (
                <span className="saving">
                  <Spinner size={13} /> SAVING
                </span>
              ) : (
                <span>{items.length} ARCHIVES</span>
              )}
            </div>
          </div>

          {items.length === 0 ? (
            <EmptyState
              icon={<ListOrdered size={26} />}
              title={t("loadOrder.emptyTitle")}
              detail={t("loadOrder.emptyDetail")}
              action={null}
            />
          ) : (
            <>
              <div className="order-hint">
                <Info size={14} />
                <span>
                  {t("loadOrder.hintA")}
                  <strong>{t("loadOrder.hintStrong")}</strong>
                  {t("loadOrder.hintB")}
                </span>
              </div>

              {suggestError ? (
                <p className="order-suggest-error">
                  <AlertTriangle size={13} /> {suggestError}
                </p>
              ) : null}

              {suggestion ? (
                <div className={`order-suggest ${suggestion.aiUsed ? "is-ai" : ""}`}>
                  <div className="order-suggest-main">
                    {suggestion.aiUsed ? <Sparkles size={15} /> : <Wand2 size={15} />}
                    <strong>
                      {suggestion.moves.length > 0
                        ? t("loadOrder.suggestMoves", { count: suggestion.moves.length })
                        : t("loadOrder.suggestNone")}
                    </strong>
                    <div className="order-suggest-actions">
                      <button
                        className="mini-btn"
                        onClick={() => void applySuggestion()}
                        disabled={saving || suggestion.moves.length === 0}
                      >
                        {t("loadOrder.apply")}
                      </button>
                      <button className="mini-btn" onClick={discardSuggestion} disabled={saving}>
                        {t("loadOrder.discard")}
                      </button>
                    </div>
                  </div>
                  {suggestion.aiNote ? (
                    <p className="order-suggest-note">{suggestion.aiNote}</p>
                  ) : null}
                  {suggestion.skipped.length > 0 ? (
                    <p className="order-suggest-note">
                      {t("loadOrder.skippedNote", { count: suggestion.skipped.length })}
                    </p>
                  ) : null}
                  {suggestion.pendingConflicts > 0 ? (
                    <p className="order-suggest-note">
                      {t("loadOrder.pendingNote", { count: suggestion.pendingConflicts })}
                    </p>
                  ) : null}
                  {suggestion.reasons.length > 0 ? (
                    <details className="order-suggest-reasons">
                      <summary>
                        {t("loadOrder.reasons", { count: suggestion.reasons.length })}
                      </summary>
                      <ul>
                        {suggestion.reasons.map((reason, index) => (
                          <li key={`${reason.kind}-${index}`} className={`reason-${reason.kind}`}>
                            <b>{t(REASON_LABEL[reason.kind] ?? "loadOrder.reasonFallback")}</b>
                            <span>{reason.note}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {liveConflicts.length > 0 || pendingConflicts.length > 0 ? (
                <div className="order-conflict-banner">
                  <ShieldAlert size={17} />
                  <div>
                    <strong>
                      {t("loadOrder.conflictCount", {
                        count: liveConflicts.length + pendingConflicts.length,
                      })}
                      {pendingConflicts.length > 0
                        ? t("loadOrder.conflictCountPending", { count: pendingConflicts.length })
                        : ""}
                    </strong>
                    <p>
                      {t("loadOrder.conflictNoteA")}
                      <strong>{t("loadOrder.conflictNoteStrong")}</strong>
                      {t("loadOrder.conflictNoteB")}
                    </p>
                    <div className="order-conflict-chips">
                      {[...liveConflicts, ...pendingConflicts].slice(0, 4).map((conflict) => (
                        <span
                          className={`conflict-chip ${conflict.pending ? "pending" : ""}`}
                          key={`${conflict.target}-${conflict.modId}-${conflict.otherModId}-${conflict.pending}`}
                        >
                          <b>{conflict.target.split("/").pop()}</b>
                          <em>
                            {conflict.modName || t("loadOrder.currentMod")} ↔{" "}
                            {conflict.otherModName ?? t("loadOrder.gameOrManual")}
                          </em>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              <div className={`order-list ${draggingId ? "is-sorting" : ""}`} ref={listRef}>
                {items.map((item, index) => {
                  const rowConflicts = conflictMap.get(item.id.toLowerCase()) ?? [];
                  const isConflict = rowConflicts.length > 0;
                  const other = rowConflicts[0]?.otherModName
                    ?? (rowConflicts[0]?.kind === "unmanaged" ? t("loadOrder.gameOrManual") : null);
                  return (
                    <div
                      key={item.id}
                      ref={(element) => {
                        if (element) rowRefs.current.set(item.id, element);
                        else rowRefs.current.delete(item.id);
                      }}
                      className={[
                        "order-row",
                        draggingId === item.id ? "is-dragging" : "",
                        isConflict ? "has-conflict" : "",
                      ].join(" ")}
                    >
                      <span
                        className="drag-handle"
                        title={t("loadOrder.dragTitle")}
                        onPointerDown={(event) => startDrag(event, item, index)}
                      >
                        <GripVertical size={15} />
                      </span>
                      <span className="order-index">
                        {isConflict ? <AlertTriangle size={11} className="order-index-alert" /> : null}
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <div className="order-file">
                        <div className="order-filename">
                          {item.filename}
                          {isConflict ? (
                            <span className="inline-conflict" title={rowConflicts[0]?.target}>
                              <AlertTriangle size={11} />{" "}
                              {t("loadOrder.conflictWith", {
                                name: other ?? t("loadOrder.otherMod"),
                              })}
                            </span>
                          ) : null}
                        </div>
                        <button className="order-mod" onClick={() => onOpenMod(item.modId)}>
                          {item.modName}
                        </button>
                      </div>
                      <Badge tone={isConflict ? "red" : "muted"}>{categoryLabel(item.category)}</Badge>
                      <div className="order-actions">
                        <button
                          className={`mini-btn pin-btn ${pins.includes(item.modId) ? "is-pinned" : ""}`}
                          aria-label={t("loadOrder.pinTitle")}
                          aria-pressed={pins.includes(item.modId)}
                          title={t("loadOrder.pinTitle")}
                          onClick={() => void togglePin(item.modId)}
                          disabled={saving}
                        >
                          {pins.includes(item.modId) ? <Pin size={13} /> : <PinOff size={13} />}
                        </button>
                        <button
                          className="mini-btn"
                          aria-label={t("loadOrder.moveUp")}
                          disabled={index === 0 || saving}
                          onClick={() => void move(index, index - 1)}
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          className="mini-btn"
                          aria-label={t("loadOrder.moveDown")}
                          disabled={index === items.length - 1 || saving}
                          onClick={() => void move(index, index + 1)}
                        >
                          <ArrowDown size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <aside className="loadorder-side">
          <section className={`panel native-panel ${view.modlistExists && !view.managedModlist ? "warn" : ""}`}>
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// NATIVE OVERRIDE</div>
                <h2>{t("loadOrder.nativeTitle")}</h2>
              </div>
              <Toggle
                checked={snapshot.state.settings.writeModlist}
                onChange={onToggleWrite}
                label={t("loadOrder.nativeToggle")}
              />
            </div>
            <p className="panel-copy">
              {t("loadOrder.nativeCopy")}
            </p>
            {view.modlistExists && !view.managedModlist ? (
              <div className="inline-warning">
                <ShieldAlert size={15} />
                <div>
                  <strong>{t("loadOrder.unmanagedWarnTitle")}</strong>
                  <p>{t("loadOrder.unmanagedWarnCopy")}</p>
                </div>
              </div>
            ) : null}
            <div className="path-box">
              <span>PATH</span>
              <code>{view.modlistPath ?? t("loadOrder.pathMissing")}</code>
              <button
                className="mini-btn"
                title={t("loadOrder.openDir")}
                onClick={() => {
                  const path = view.modlistPath;
                  if (!path) return;
                  // 没有分隔符时 lastIndexOf 返回 -1，`slice(0, -1)` 会把最后一个
                  // 字符切掉，于是一个不存在的路径被交给 openPath，还没有任何提示。
                  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
                  void api.openPath(cut < 0 ? "." : path.slice(0, cut));
                }}
              >
                <FolderOpen size={13} />
              </button>
            </div>
            <div className="native-actions">
              <button className="btn btn-ghost btn-sm" onClick={onExport} disabled={items.length === 0}>
                <RefreshCw size={13} /> {t("loadOrder.rewrite")}
              </button>
              <button
                className="btn btn-ghost btn-sm danger-text"
                onClick={onRemoveModlist}
                disabled={!view.managedModlist}
              >
                <Trash2 size={13} /> {t("loadOrder.removeWrite")}
              </button>
            </div>
            <div className="native-note">
              <Info size={13} />
              <span>{t("loadOrder.asciiNote")}</span>
            </div>
          </section>

          <section className="panel redmod-panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// REDMOD ORDER</div>
                <h2>{t("loadOrder.redmodTitle")}</h2>
              </div>
              <span className="panel-meta">{redmods.length}</span>
            </div>
            <p className="panel-copy">
              {t("loadOrder.redmodCopy")}
            </p>
            <div className="redmod-list">
              {redmods.length === 0 ? (
                <div className="muted-line">{t("loadOrder.noRedmods")}</div>
              ) : (
                redmods.map((item, index) => (
                  <div key={item.id} className="redmod-row">
                    <span className="redmod-rank">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{item.filename}</strong>
                      <span>{item.modName}</span>
                    </div>
                    <div className="redmod-actions">
                      <button
                        className="icon-btn"
                        title={t("loadOrder.moveUp")}
                        aria-label={t("loadOrder.moveUp")}
                        disabled={saving || index === 0}
                        onClick={() => void moveRedmod(index, index - 1)}
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        className="icon-btn"
                        title={t("loadOrder.moveDown")}
                        aria-label={t("loadOrder.moveDown")}
                        disabled={saving || index === redmods.length - 1}
                        onClick={() => void moveRedmod(index, index + 1)}
                      >
                        <ArrowDown size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="native-note">
              <Info size={13} />
              <span>{t("loadOrder.redmodNote")}</span>
            </div>
          </section>

          <section className="panel xl-panel">
            <div className="panel-head">
              <div>
                <div className="panel-eyebrow">// SIDE NOTE</div>
                <h2>{t("loadOrder.xlTitle")}</h2>
              </div>
            </div>
            <p className="panel-copy">
              {t("loadOrder.xlA")}<code>.xl</code>{t("loadOrder.xlB")}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
