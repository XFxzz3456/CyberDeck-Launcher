import { t, type MessageKey } from "../i18n";
import type {
  DependencyReport,
  FrameworkStatus,
  ModEntry,
  ModDependencyStatus,
} from "../types";

export interface RequiredFramework {
  id: string;
  name: string;
  /** 为什么需要它——只存 key，渲染层用 t() 取。 */
  reasonKey: MessageKey;
}

/**
 * 一条「生效中的」依赖要求：来源可能是 Rust 后端（能读 info.json、能核对版本、
 * 能认整合包自带的前置），也可能是本地启发式兜底（演示模式 / 后端还没返回）。
 * 两种来源统一成同一个形状，界面只认这一种。
 */
export interface EffectiveDependency {
  id: string;
  name: string;
  satisfied: boolean;
  /** 已安装但版本低于要求。 */
  versionMismatch: boolean;
  /** 人话依据，例如「包含 .xl 归档声明文件」或「游戏目录已安装」。 */
  detail: string;
  /** game / bundled:<模组名> / null */
  satisfiedBy: string | null;
  requiredVersion: string | null;
  installedVersion: string | null;
  /** 用户手动忽略过这条警告。 */
  ignored: boolean;
}

const FRAMEWORK_MOD_NAMES = [
  "red4ext",
  "cyber engine tweaks",
  // 缩写也要认：N 网上大量条目叫「CET Framework」「CET 兼容补丁」，
  // 不认的话框架自己会被提示"需要 CET"。startsWith("${name} ") 的空格
  // 要求同时挡掉了 Cetmix 这类形似名（与 Rust 侧 is_framework_name 对齐）。
  "cet",
  "archivexl",
  "tweakxl",
  "codeware",
  "redscript",
  "mod settings",
];

function isFrameworkItself(mod: ModEntry): boolean {
  const name = mod.name.trim().toLowerCase();
  return FRAMEWORK_MOD_NAMES.some(
    (framework) => name === framework || name.startsWith(`${framework} `),
  );
}

/**
 * Infer the frameworks a mod needs from what the importer can prove.
 *
 * 这是**兜底**推断：后端依赖报告拿不到时才用（演示模式、后端未返回）。
 * Rust 侧 `deps.rs` 才是完整实现——它能读 info.json、能核对版本、能认出
 * 整合包自带的前置。这里保持保守：只按能证明的东西推断。
 */
export function requiredFrameworks(mod: ModEntry): RequiredFramework[] {
  if (isFrameworkItself(mod)) return [];

  const required = new Map<string, RequiredFramework>();
  const files = mod.plannedFiles.map((file) => file.replace(/\\/g, "/").toLowerCase());
  const hasXl = files.some((file) => /\.xlp?$/.test(file));

  if (mod.hasCet || mod.layout === "cet") {
    required.set("cet", {
      id: "cet",
      name: "Cyber Engine Tweaks",
      reasonKey: "dependency.reason.cet",
    });
  }
  if (mod.layout === "redscript" || files.some((file) => file.endsWith(".reds"))) {
    required.set("redscript", {
      id: "redscript",
      name: "redscript",
      reasonKey: "dependency.reason.redscript",
    });
  }
  if (hasXl) {
    required.set("archivexl", {
      id: "archivexl",
      name: "ArchiveXL",
      reasonKey: "dependency.reason.archiveXL",
    });
  }
  if (files.some((file) => file.endsWith(".tweak"))) {
    required.set("tweakxl", {
      id: "tweakxl",
      name: "TweakXL",
      reasonKey: "dependency.reason.tweakXL",
    });
  }
  return [...required.values()];
}

// ─────────────────────────────────────────────────────────────
// 手动忽略（本地持久化）
//
// 为什么不进 launcher-state.json：忽略是「本机这个玩家的判断」，不是模组属性；
// 写进状态文件就要动 schema（本项目在 10-26 因 serde 解析错位丢过 195 条索引），
// 而 localStorage 已经承载了主题/已读等同类偏好，放这里与既有约定一致。
// ─────────────────────────────────────────────────────────────

const IGNORE_KEY = "ncl.ui.depIgnores.v1";

type IgnoreMap = Record<string, string[]>;

export function readDepIgnores(): IgnoreMap {
  try {
    const raw = window.localStorage.getItem(IGNORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: IgnoreMap = {};
    for (const [modId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        out[modId] = value.filter((item): item is string => typeof item === "string");
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeDepIgnores(map: IgnoreMap): void {
  try {
    window.localStorage.setItem(IGNORE_KEY, JSON.stringify(map));
  } catch {
    // 隐私模式下写不进去：忽略只在本次会话生效，不报错打断用户。
  }
}

export function isDependencyIgnored(modId: string, frameworkId: string): boolean {
  return (readDepIgnores()[modId] ?? []).includes(frameworkId);
}

export function ignoreDependency(modId: string, frameworkId: string): void {
  const map = readDepIgnores();
  const list = new Set(map[modId] ?? []);
  list.add(frameworkId);
  map[modId] = [...list];
  writeDepIgnores(map);
}

export function restoreDependency(modId: string, frameworkId: string): void {
  const map = readDepIgnores();
  const list = (map[modId] ?? []).filter((item) => item !== frameworkId);
  if (list.length === 0) {
    delete map[modId];
  } else {
    map[modId] = list;
  }
  writeDepIgnores(map);
}

export function clearAllDependencyIgnores(): void {
  writeDepIgnores({});
}

// ─────────────────────────────────────────────────────────────
// 生效依赖：后端报告优先，本地推断兜底
// ─────────────────────────────────────────────────────────────

function reportEntry(
  modId: string,
  report: DependencyReport | null | undefined,
): ModDependencyStatus | null {
  if (!report) return null;
  return report.mods.find((item) => item.modId === modId) ?? null;
}

/**
 * 某个模组当前生效的依赖列表（含已满足项）。
 *
 * 顺序与口径：后端有这条模组的记录就用后端（它读过元数据、核对过版本），
 * 否则退回本地推断。**已忽略的条目不删除**，标成 ignored 交给界面决定怎么显示——
 * 直接删掉的话用户永远找不到「把提示恢复回来」的入口。
 */
export function effectiveDependencies(
  mod: ModEntry,
  report: DependencyReport | null | undefined,
  frameworks: FrameworkStatus[] | null | undefined,
): EffectiveDependency[] {
  const ignores = new Set(readDepIgnores()[mod.id] ?? []);
  const entry = reportEntry(mod.id, report);

  if (entry) {
    return entry.requirements.map((requirement) => {
      const bundled = requirement.satisfiedBy?.startsWith("bundled:");
      const detail = requirement.satisfied
        ? bundled
          ? t("dependency.detail.bundled", {
              name: requirement.satisfiedBy?.slice("bundled:".length) ?? "",
            })
          : requirement.satisfiedBy === "game"
            ? requirement.installedVersion
              ? t("dependency.detail.installedVersion", {
                  version: requirement.installedVersion,
                })
              : t("dependency.detail.installed")
            : requirement.detail
        : requirement.detail;
      return {
        id: requirement.id,
        name: requirement.name,
        satisfied: requirement.satisfied,
        versionMismatch: requirement.satisfied && !requirement.versionOk,
        detail,
        satisfiedBy: requirement.satisfiedBy,
        requiredVersion: requirement.requiredVersion,
        installedVersion: requirement.installedVersion,
        ignored: ignores.has(requirement.id),
      };
    });
  }

  if (!frameworks || frameworks.length === 0) return [];
  const installed = new Map(frameworks.map((framework) => [framework.id, framework]));
  return requiredFrameworks(mod).map((requirement) => {
    const status = installed.get(requirement.id);
    const ok = status?.installed ?? false;
    return {
      id: requirement.id,
      name: requirement.name,
      satisfied: ok,
      versionMismatch: false,
      detail: ok
        ? status?.version
          ? t("dependency.detail.installedVersion", { version: status.version })
          : t("dependency.detail.installed")
        : t("dependency.detail.missing"),
      satisfiedBy: ok ? "game" : null,
      requiredVersion: null,
      installedVersion: status?.version ?? null,
      ignored: ignores.has(requirement.id),
    };
  });
}

/** 卡片徽标用：只回缺失且未被忽略的框架显示名。 */
export function missingDependencyNames(
  mod: ModEntry,
  report: DependencyReport | null | undefined,
  frameworks: FrameworkStatus[] | null | undefined,
): string[] {
  return effectiveDependencies(mod, report, frameworks)
    .filter((item) => !item.satisfied && !item.ignored)
    .map((item) => item.name);
}

/** 启用拦截用：缺前置且未被忽略的条目。 */
export function blockingDependencies(
  mod: ModEntry,
  report: DependencyReport | null | undefined,
  frameworks: FrameworkStatus[] | null | undefined,
): EffectiveDependency[] {
  return effectiveDependencies(mod, report, frameworks).filter(
    (item) => !item.satisfied && !item.ignored,
  );
}

/** 旧调用点保留：只要缺失名单。 */
export function missingFrameworks(
  mod: ModEntry,
  frameworks: FrameworkStatus[] | null | undefined,
): RequiredFramework[] {
  if (!frameworks || frameworks.length === 0) return [];
  const installed = new Map(frameworks.map((framework) => [framework.id, framework.installed]));
  return requiredFrameworks(mod).filter((requirement) => !installed.get(requirement.id));
}

export function nexusSearchUrl(name: string): string {
  return `https://www.nexusmods.com/cyberpunk2077/search/?gsearch=${encodeURIComponent(name)}`;
}
