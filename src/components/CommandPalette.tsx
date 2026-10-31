import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Compass,
  Download,
  FolderOpen,
  Gamepad2,
  LayoutGrid,
  ListOrdered,
  Play,
  Search,
  Settings,
  ShieldAlert,
  Stethoscope,
  Terminal,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { categoryLabel, t } from "../i18n";
import type { ModEntry } from "../types";
import type { View } from "./Sidebar";
import { Kbd } from "./ui";

interface PaletteItem {
  id: string;
  group: "COMMAND" | "MOD";
  label: string;
  hint: string;
  icon: ReactNode;
  keywords: string;
  run: () => void;
}

function fuzzyScore(text: string, query: string): number {
  const value = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const direct = value.indexOf(needle);
  if (direct >= 0) return 1000 - direct;
  let cursor = 0;
  let score = 0;
  for (const char of needle) {
    const next = value.indexOf(char, cursor);
    if (next < 0) return -1;
    score += next === cursor ? 6 : 2;
    cursor = next + 1;
  }
  return score;
}

function command(
  id: string,
  label: string,
  hint: string,
  icon: LucideIcon,
  keywords: string,
  run: () => void,
): PaletteItem {
  const Icon = icon;
  return { id, group: "COMMAND", label, hint, icon: <Icon size={15} />, keywords, run };
}

export function CommandPalette({
  open,
  onClose,
  mods,
  conflictCount,
  onOpenMod,
  onNavigate,
  onImport,
  onLaunch,
  onOpenConflicts,
  onOpenLogs,
  onOpenStaging,
  onExportModlist,
  onAdopt,
}: {
  open: boolean;
  onClose: () => void;
  mods: ModEntry[];
  conflictCount: number;
  onOpenMod: (mod: ModEntry) => void;
  onNavigate: (view: View) => void;
  onImport: () => void;
  onLaunch: () => void;
  onOpenConflicts: () => void;
  onOpenLogs: () => void;
  onOpenStaging: () => void;
  onExportModlist: () => void;
  onAdopt: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const commands = useMemo(
    // 下面这张表里每个命令的第 5 个参数是**模糊检索关键词**：用户会用中文去搜命令，
    // 所以这些中文串是检索索引数据，不是界面文案，不该进词表。
    // 未来做多语言时它们是「按语言各备一份关键词」的独立改造，与文案抽取无关。
    // i18n-ignore-start
    () => [
      command("import", t("palette.importLabel"), t("palette.importHint"), Upload, "import zip 7z rar", onImport),
      command("launch", t("palette.launchLabel"), t("palette.launchHint"), Play, "launch game steam play", onLaunch),
      command(
        "conflicts",
        `${t("palette.conflictsLabel")}${conflictCount > 0 ? ` (${conflictCount})` : ""}`,
        t("palette.conflictsHint"),
        ShieldAlert,
        "conflict 冲突 覆盖",
        onOpenConflicts,
      ),
      command(
        "adopt",
        t("palette.adoptLabel"),
        t("palette.adoptHint"),
        ArchiveRestore,
        "adopt 收编 external vortex 接管",
        onAdopt,
      ),
      command("library", t("palette.libraryLabel"), t("palette.libraryHint"), LayoutGrid, "library mods 模组库", () =>
        onNavigate("library"),
      ),
      command("discover", t("palette.discoverLabel"), t("palette.discoverHint"), Compass, "nexus discover 发现", () =>
        onNavigate("discover"),
      ),
      command("loadorder", t("palette.loadOrderLabel"), "Archive priority / modlist", ListOrdered, "order load 排序 加载", () =>
        onNavigate("loadorder"),
      ),
      command("downloads", t("palette.downloadsLabel"), t("palette.downloadsHint"), Download, "download 下载 队列", () =>
        onNavigate("downloads"),
      ),
      command("diagnostics", t("palette.diagnosticsLabel"), t("palette.diagnosticsHint"), Stethoscope, "diagnose check 诊断", () =>
        onNavigate("diagnostics"),
      ),
      command("logs", t("palette.logsLabel"), "redscript / CET / RED4ext", Terminal, "log 日志 error", onOpenLogs),
      command("settings", t("palette.settingsLabel"), t("palette.settingsHint"), Settings, "settings 设置", () =>
        onNavigate("settings"),
      ),
      command("export", t("palette.exportLabel"), t("palette.exportHint"), FolderOpen, "modlist export 写入", onExportModlist),
      command("staging", t("palette.stagingLabel"), t("palette.stagingHint"), FolderOpen, "staging folder 暂存", onOpenStaging),
      command("game", t("palette.gameLabel"), t("palette.gameHint"), Gamepad2, "game path 游戏目录", () =>
        onNavigate("settings"),
      ),
    ],
    // i18n-ignore-end
    [conflictCount, onAdopt, onExportModlist, onImport, onLaunch, onNavigate, onOpenConflicts, onOpenLogs, onOpenStaging],
  );

  const items = useMemo(() => {
    const needle = query.trim();
    const matchedCommands = commands
      .map((item) => ({ item, score: fuzzyScore(`${item.label} ${item.hint} ${item.keywords}`, needle) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => (needle ? b.score - a.score : 0))
      .map((entry) => entry.item);

    if (!needle) {
      return [
        ...matchedCommands.slice(0, 6),
        ...mods.slice(0, 3).map((mod) => modItem(mod, onOpenMod)),
      ];
    }

    const matchedMods = mods
      .map((mod) => ({
        mod,
        score: fuzzyScore(
          `${mod.name} ${mod.translatedName ?? ""} ${mod.author ?? ""} ${mod.category} ${mod.version ?? ""} ${mod.id}`,
          needle,
        ),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .map((entry) => modItem(entry.mod, onOpenMod));

    // When a query matches a mod, the mod is what the user is looking for.
    // Commands remain reachable below it (and still lead when no mod matches).
    return matchedMods.length > 0
      ? [...matchedMods, ...matchedCommands.slice(0, 4)]
      : matchedCommands.slice(0, 8);
  }, [commands, mods, onOpenMod, query]);

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const selected = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${active}"]`);
    selected?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const run = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (items.length ? (current + 1) % items.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (items.length ? (current - 1 + items.length) % items.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      if (item) run(item);
    }
  };

  return (
    <div className="command-portal" role="presentation" onKeyDown={onKeyDown}>
      <button className="command-backdrop" onClick={onClose} aria-label={t("palette.closeAria")} />
      <section className="command-panel" role="dialog" aria-modal="true" aria-label={t("palette.dialogAria")}>
        <div className="command-input-row">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder={t("palette.searchPlaceholder")}
            spellCheck={false}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="command-results" ref={listRef}>
          {items.length === 0 ? (
            <div className="command-empty">
              <span>NO MATCH</span>
              <p>{t("palette.emptyHint")}</p>
            </div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                data-palette-index={index}
                className={`command-row ${index === active ? "is-active" : ""}`}
                onMouseMove={() => setActive(index)}
                onClick={() => run(item)}
              >
                <span className="command-icon">{item.icon}</span>
                <span className="command-copy">
                  <strong>{item.label}</strong>
                  <em>{item.hint}</em>
                </span>
                <span className={`command-group ${item.group === "MOD" ? "is-mod" : ""}`}>
                  {item.group}
                </span>
              </button>
            ))
          )}
        </div>
        <footer className="command-foot">
          <span><ArrowUp size={11} /><ArrowDown size={11} /> {t("palette.footerSelect")}</span>
          <span><Kbd>Enter</Kbd> {t("palette.footerRun")}</span>
          <span>{t("palette.footerTitle")} <Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
        </footer>
      </section>
    </div>
  );
}

function modItem(mod: ModEntry, onOpenMod: (mod: ModEntry) => void): PaletteItem {
  return {
    id: `mod-${mod.id}`,
    group: "MOD",
    label: mod.translatedName?.trim() || mod.name,
    hint: `${categoryLabel(mod.category)}${mod.version ? ` · v${mod.version}` : ""} · ${mod.enabled ? t("palette.modDeployed") : t("palette.modStaged")}`,
    icon: <LayoutGrid size={15} />,
    keywords: `${mod.name} ${mod.translatedName ?? ""} ${mod.author ?? ""} ${mod.category}`,
    run: () => onOpenMod(mod),
  };
}
