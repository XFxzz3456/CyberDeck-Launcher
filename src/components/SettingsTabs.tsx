import { useRef } from "react";
import type { KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";
import { Bell, BookOpen, BrainCircuit, Download, Gamepad2, Palette, ShieldCheck, Wrench } from "lucide-react";
import { t } from "../i18n";
import { indicatorLayoutId, useMotionSprings } from "../lib/motion";
import { useMotionEnabled } from "../lib/preferences";

/**
 * 设置页顶部的八个分区。
 *
 * id 同时用于 tab 按钮的 id（settings-tab-<id>）和面板的
 * aria-labelledby 目标（settings-panel-<id>），改名字要同步改 DOM 引用。
 */
export type SettingsTabId =
  | "appearance"
  | "notifications"
  | "game"
  | "downloads"
  | "ai"
  | "tools"
  | "security"
  | "help";

export interface SettingsTabDef {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
}

export const SETTINGS_TABS: SettingsTabDef[] = [
  { id: "appearance", label: t("settings.tabs.appearance"), icon: Palette },
  { id: "notifications", label: t("settings.tabs.notifications"), icon: Bell },
  { id: "game", label: t("settings.tabs.game"), icon: Gamepad2 },
  // 下载设置原本寄生在「工具组件」里：并发 / 限速 / 链路 / 分片 / 代理 / 目录
  // 六组设置，比「通知」还多，却没有自己的位置，用户根本猜不到点哪。
  { id: "downloads", label: t("settings.tabs.downloads"), icon: Download },
  { id: "ai", label: t("settings.tabs.ai"), icon: BrainCircuit },
  { id: "tools", label: t("settings.tabs.tools"), icon: Wrench },
  { id: "security", label: t("settings.tabs.security"), icon: ShieldCheck },
  // 帮助中心从侧栏挪进来的：它不是高频入口，占着左侧主菜单只会挤压主流程。
  // 「关于」并进「帮助」：两者都是低频信息页，合并后总数仍是 8 个，
  // 既给下载腾出位置，又不会把标签栏挤成需要横向滚动。
  { id: "help", label: t("settings.tabs.help"), icon: BookOpen },
];

/**
 * 水平标签栏。
 *
 * 只负责画标签和派发 onChange，不持有选中状态——选中状态留在 SettingsView，
 * 这样切换标签不会触发整棵内容区重新挂载。
 */
export function SettingsTabs({
  active,
  onChange,
}: {
  active: SettingsTabId;
  onChange: (id: SettingsTabId) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 动效被关掉时不挂 layoutId：下划线退回 CSS ::after（见 styles.css），
  // 两套渲染不能同时存在，否则会出现两条线。
  const motionEnabled = useMotionEnabled();
  // 弹簧参数按主题取：赛博家族更「咔哒」，modern/mono 更柔和。
  const springs = useMotionSprings();

  /** 键盘左右/Home/End 在标签之间移动，选中态跟随（roving tabindex）。 */
  const focusTab = (id: SettingsTabId) => {
    listRef.current?.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)?.focus();
  };

  const move = (delta: number) => {
    const index = SETTINGS_TABS.findIndex((tab) => tab.id === active);
    const next = SETTINGS_TABS[(index + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    onChange(next.id);
    focusTab(next.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? SETTINGS_TABS[0] : SETTINGS_TABS[SETTINGS_TABS.length - 1];
      onChange(next.id);
      focusTab(next.id);
    }
  };

  return (
    <div className="settings-tabs" role="tablist" aria-label={t("settings.tabsLabel")} ref={listRef} onKeyDown={onKeyDown}>
      {SETTINGS_TABS.map((tab) => {
        const selected = tab.id === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-controls={`settings-panel-${tab.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`settings-tab${selected ? " active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{tab.label}</span>
            {/* 下划线是「光标」不是「物体」：固定走 tween（springs.indicator），
                不再吃主题弹簧族——机械族的轻微过冲在整条下划线横移时会被看成「晃」。 */}
            {selected && motionEnabled ? (
              <motion.span
                aria-hidden="true"
                className="settings-tab-underline"
                layoutId={indicatorLayoutId.settingsTab}
                transition={springs.indicator}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
