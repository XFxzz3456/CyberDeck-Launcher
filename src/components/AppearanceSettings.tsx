import {
  Check,
  Image as ImageIcon,
  ImageOff,
  MonitorPlay,
  MonitorSmartphone,
  Moon,
  EyeOff,
  Palette,
  PanelLeftClose,
  RotateCcw,
  Sparkles,
  Sun,
  Type,
  ZoomIn,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { t, type MessageKey } from "../i18n";
import {
  CODE_FONTS,
  UI_FONTS,
  codeFontPreview,
  uiFontPreview,
  type CodeFontId,
  type UiFontId,
} from "../lib/fonts";
import type { Preferences, ThemeId } from "../lib/preferences";
import { HIDEABLE_VIEWS, type HiddenViewsMap, type HideableView } from "../lib/uiPrefs";
import { STYLE_PRESETS, useTheme, type ColorMode } from "../lib/theme";
import { SwitchRow } from "./ui";

/** 背景图填充模式（与 Settings.backgroundFit 同形）。 */
export type BackgroundFit = "cover" | "contain" | "stretch";

/** 自定义背景图控制块（看板【皮肤 UI 优化】P0 子项），由 SettingsView 组装。 */
export interface BackgroundControl {
  path: string;
  opacity: number;
  blur: number;
  /** 暗化遮罩浓度 0–100（可读性任务）。 */
  dim: number;
  fit: BackgroundFit;
  /** 焦点横坐标 0–100，50 = 居中。 */
  posX: number;
  /** 焦点纵坐标 0–100。 */
  posY: number;
  onPick: () => void;
  onClear: () => void;
  onOpacity: (value: number) => void;
  onBlur: (value: number) => void;
  onDim: (value: number) => void;
  onFit: (value: BackgroundFit) => void;
  onPos: (axis: "x" | "y", value: number) => void;
  onResetPos: () => void;
}

/** 填充方式三选一。顺序按「最常用 → 最少用」排，默认项排第一。 */
const FIT_OPTIONS: { id: BackgroundFit; labelKey: MessageKey }[] = [
  { id: "cover", labelKey: "appearance.backgroundFitCover" },
  { id: "contain", labelKey: "appearance.backgroundFitContain" },
  { id: "stretch", labelKey: "appearance.backgroundFitStretch" },
];

const MODE_OPTIONS: { id: ColorMode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: t("appearance.modeLight"), icon: Sun },
  { id: "dark", label: t("appearance.modeDark"), icon: Moon },
  { id: "system", label: t("appearance.modeSystem"), icon: MonitorSmartphone },
];

/**
 * 个性化页（2026-10-31 重构）。
 *
 * 之前是「一张大卡里塞四段 + 虚线分隔」，设置项混排、窗口行为还落在卡片外面。
 * 现在拆成 6 张独立卡片，按「外观 → 导航 → 窗口 → 排版 → 背景 → 动效」排序：
 * 01 / 04 / 05 / 06 满宽，02 / 03 半宽并排（窄窗自动落单列）。
 *
 * 只改排版与归属，不动任何一条 `ncl.ui.*` 存储键，用户现有主题/字体/侧栏状态不会重置。
 */
export function AppearanceSettings({
  preferences,
  onSelectTheme,
  onAccent,
  onResetAccent,
  onScale,
  onUiFont,
  onCodeFont,
  onSidebarCollapsed,
  onAnimations,
  onSplash,
  closeBehavior,
  onCloseBehavior,
  background,
  hiddenViews = {},
  onToggleHiddenView,
}: {
  preferences: Preferences;
  onSelectTheme: (theme: ThemeId) => void;
  onAccent: (accent: string) => void;
  onResetAccent: () => void;
  onScale: (scale: number) => void;
  onUiFont: (font: UiFontId) => void;
  onCodeFont: (font: CodeFontId) => void;
  onSidebarCollapsed: (collapsed: boolean) => void;
  onAnimations: (value: boolean) => void;
  onSplash: (value: boolean) => void;
  /** 关闭窗口行为：由 SettingsView 传入（原本是页脚那张独立 panel）。 */
  closeBehavior: "tray" | "exit";
  onCloseBehavior: (value: "tray" | "exit") => void;
  background?: BackgroundControl;
  hiddenViews?: HiddenViewsMap;
  onToggleHiddenView?: (view: HideableView, hidden: boolean) => void;
}) {
  const { styleTheme, colorMode, resolvedMode, modeCapable, setColorMode } = useTheme();
  const active = STYLE_PRESETS.find((preset) => preset.id === styleTheme) ?? STYLE_PRESETS[0];

  // 风格自带的强调色由 CSS 决定（不同风格 / 明暗各不相同），这里读回实际生效的值。
  const [themeAccent, setThemeAccent] = useState(active.swatch[0]);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      if (value) setThemeAccent(value);
    };
    read();
    // 自定义强调色是内联样式，会覆盖 CSS 默认值；下一帧再读一次拿到真正的默认色。
    frame = requestAnimationFrame(read);
    return () => cancelAnimationFrame(frame);
  }, [styleTheme, resolvedMode, preferences.useCustomAccent, preferences.accent]);

  const accent = preferences.useCustomAccent ? preferences.accent : themeAccent;

  return (
    <>
      {/* ── 01 主题与配色 ───────────────────────────────── */}
      <SettingCard
        index="01"
        span
        eyebrow="// THEME / PALETTE"
        title={t("appearance.groupTheme")}
        hint={t("appearance.groupThemeHint")}
        aside={<BadgeLabel theme={active.name} custom={preferences.useCustomAccent} />}
      >
        <div className="appearance-block">
          <div className="appearance-label">
            <Palette size={13} /> {t("appearance.styleLabel")}
          </div>
          <div className="theme-grid">
            {STYLE_PRESETS.map((preset) => {
              const selected = preset.id === styleTheme;
              // 明暗两套都配了图的风格（modern）跟着当前生效的明暗换缩略图，
              // 否则用户选了亮色却看到一张暗色缩略图，会以为没生效。
              const thumb =
                resolvedMode === "light" && preset.thumbLight ? preset.thumbLight : preset.thumb;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`theme-option ${selected ? "selected" : ""}`}
                  onClick={() => onSelectTheme(preset.id)}
                  aria-pressed={selected}
                  data-theme-preview={preset.id}
                >
                  <span
                    className="theme-swatch"
                    aria-hidden="true"
                    style={{ "--swatch-accent": preset.swatch[0] } as CSSProperties}
                  >
                    {thumb ? (
                      <img
                        className="theme-shot"
                        src={thumb}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="theme-shot theme-shot-flat" />
                    )}
                  </span>
                  <span className="theme-copy">
                    <strong>{preset.name}</strong>
                    <em>{t(preset.labelKey)}</em>
                    <small>{t(preset.detailKey)}</small>
                  </span>
                  {selected ? <Check className="theme-check" size={14} /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="appearance-block appearance-controls">
          {modeCapable ? (
            <>
              <div className="appearance-label">
                <MonitorSmartphone size={13} /> {t("appearance.modeLabel")}
              </div>
              <div className="mode-row" role="group" aria-label={t("appearance.modeLabel")}>
                {MODE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = colorMode === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`mode-btn ${selected ? "selected" : ""}`}
                      onClick={() => setColorMode(option.id)}
                      aria-pressed={selected}
                    >
                      <Icon size={12} />
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <p className="appearance-hint">
                {t("appearance.currentModeNote", {
                  mode: resolvedMode === "light" ? t("appearance.modeLight") : t("appearance.modeDark"),
                  system: colorMode === "system" ? t("appearance.followSystem") : "",
                })}
              </p>
            </>
          ) : (
            <p className="appearance-hint">
              {t("appearance.cyberOnlyNote", { theme: active.name })}
            </p>
          )}

          <div className="appearance-label appearance-label-spaced">
            <Type size={13} /> {t("appearance.accentLabel")}
          </div>
          <div className="accent-row">
            <label className="accent-picker" title={t("appearance.accentPickerTitle")}>
              <input
                type="color"
                value={accent}
                onChange={(event) => onAccent(event.target.value)}
                aria-label={t("appearance.accentPickerAria")}
              />
              <span style={{ background: accent }} />
            </label>
            <div className="accent-copy">
              <strong>
                {preferences.useCustomAccent
                  ? t("appearance.accentCustom")
                  : t("appearance.accentThemeDefault", { theme: active.name })}
              </strong>
              <code>{accent.toUpperCase()}</code>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onResetAccent}
              disabled={!preferences.useCustomAccent}
            >
              <RotateCcw size={12} /> {t("appearance.resetAccent")}
            </button>
          </div>
          <p className="appearance-hint">{t("appearance.accentHint")}</p>
        </div>

        {/* 实况预览讲的是「这套配色长什么样」，所以归主题卡，不跟背景图混在一起。 */}
        <div className="appearance-preview" data-preview-theme={styleTheme}>
          <div className="preview-top">
            <span className="preview-dot" />
            <span>LIVE PREVIEW</span>
            <b>{active.name}</b>
          </div>
          <div className="preview-bar">
            <i />
            <i />
            <i />
          </div>
          <div className="preview-row">
            <span />
            <span />
            <span className="preview-accent" />
          </div>
          <p>
            <PanelLeftClose size={11} /> {t("appearance.persistNote")}
          </p>
        </div>
      </SettingCard>

      {/* ── 02 左侧导航栏 ───────────────────────────────── */}
      <SettingCard
        index="02"
        eyebrow="// NAVIGATION"
        title={t("appearance.groupNav")}
        hint={t("appearance.groupNavHint")}
        aside={<EyeOff size={16} />}
      >
        <p className="bg-hint">{t("appearance.hiddenViewsHint")}</p>
        <div className="setting-list">
          {HIDEABLE_VIEWS.map((viewId) => (
            <SwitchRow
              key={viewId}
              title={t(`hiddenView.${viewId}` as MessageKey)}
              description={t("appearance.hiddenViewItemDesc")}
              checked={!hiddenViews[viewId]}
              onChange={(visible) => onToggleHiddenView?.(viewId, !visible)}
            />
          ))}
        </div>
      </SettingCard>

      {/* ── 03 窗口与侧边栏 ─────────────────────────────── */}
      <SettingCard
        index="03"
        eyebrow="// WINDOW / SIDEBAR"
        title={t("appearance.groupWindow")}
        hint={t("appearance.groupWindowHint")}
        aside={<MonitorPlay size={16} />}
      >
        <div className="setting-list">
          <SwitchRow
            title={t("appearance.collapseSidebar")}
            description={t("appearance.collapseSidebarDesc")}
            checked={preferences.sidebarCollapsed}
            onChange={onSidebarCollapsed}
          />
          {/* 关闭方式只换位置，持久化仍走 settings.closeBehavior（避坑指南第 1 条）。 */}
          <div className="setting-item setting-item--stack">
            <div className="setting-item-label">{t("settings.closeBehaviorLabel")}</div>
            <div className="settings-field-row">
              <button
                className={`btn btn-sm ${
                  closeBehavior === "tray" ? "btn-primary" : "btn-ghost"
                }`}
                aria-pressed={closeBehavior === "tray"}
                onClick={() => onCloseBehavior("tray")}
              >
                {t("settings.closeTray")}
              </button>
              <button
                className={`btn btn-sm ${
                  closeBehavior === "exit" ? "btn-primary" : "btn-ghost"
                }`}
                aria-pressed={closeBehavior === "exit"}
                onClick={() => onCloseBehavior("exit")}
              >
                {t("settings.closeExit")}
              </button>
            </div>
            <small className="setting-item-note">{t("settings.closeBehaviorNote")}</small>
          </div>
        </div>
      </SettingCard>

      {/* ── 04 字体与排版 ───────────────────────────────── */}
      <SettingCard
        index="04"
        span
        eyebrow="// TYPOGRAPHY"
        title={t("appearance.groupTypography")}
        hint={t("appearance.groupTypographyHint")}
        aside={<ZoomIn size={16} />}
      >
        <div className="appearance-label">
          <ZoomIn size={13} /> {t("appearance.scaleLabel")}
        </div>
        {/* r20：三档按钮换滑块，80%–150%，拖动即生效（preferences 里按 5% 钳制取整）。 */}
        <div className="scale-row">
          <input
            className="scale-slider"
            type="range"
            min={0.8}
            max={1.5}
            step={0.05}
            value={preferences.scale}
            onChange={(event) => onScale(Number(event.target.value))}
            aria-label={t("appearance.scaleLabel")}
          />
          <span className="scale-value">{Math.round(preferences.scale * 100)}%</span>
          <span className="scale-note">{t("appearance.scaleNote")}</span>
        </div>

        {/* T8 字体设置（2026-10-30 补做）：全局字体 + 代码/日志字体 + 实时预览。 */}
        <div className="appearance-label appearance-label-spaced">
          <Type size={13} /> {t("appearance.fontLabel")}
        </div>
        <div className="font-row">
          <label className="font-field">
            <span>{t("appearance.uiFontLabel")}</span>
            <select
              className="font-select"
              value={preferences.uiFont}
              onChange={(event) => onUiFont(event.target.value as UiFontId)}
            >
              {UI_FONTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {t(option.labelKey as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="font-field">
            <span>{t("appearance.codeFontLabel")}</span>
            <select
              className="font-select"
              value={preferences.codeFont}
              onChange={(event) => onCodeFont(event.target.value as CodeFontId)}
            >
              {CODE_FONTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {t(option.labelKey as MessageKey)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="font-preview">
          <span className="font-preview-tag">{t("appearance.fontPreviewLabel")}</span>
          <p
            className="font-preview-text"
            style={{ fontFamily: uiFontPreview(preferences.uiFont) || undefined }}
          >
            {t("appearance.fontPreviewText")}
          </p>
          <code
            className="font-preview-code"
            style={{ fontFamily: codeFontPreview(preferences.codeFont) || undefined }}
          >
            {t("appearance.fontPreviewCode")}
          </code>
        </div>
        <p className="bg-hint">{t("appearance.fontHint")}</p>
      </SettingCard>

      {/* ── 05 背景图 ───────────────────────────────────── */}
      <SettingCard
        index="05"
        span
        eyebrow="// BACKDROP"
        title={t("appearance.groupBackdrop")}
        hint={t("appearance.groupBackdropHint")}
        aside={<ImageIcon size={16} />}
      >
        {background ? (
          <div className="appearance-label appearance-label-spaced bg-block">
            <div className="appearance-label">
              <ImageIcon size={13} /> {t("appearance.backgroundLabel")}
            </div>
            <div className="bg-row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={background.onPick}
                title={t("appearance.backgroundPickTitle")}
              >
                <ImageIcon size={12} /> {t("appearance.backgroundPick")}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={background.onClear}
                disabled={!background.path}
                title={t("appearance.backgroundClearTitle")}
              >
                <ImageOff size={12} /> {t("appearance.backgroundClear")}
              </button>
              <span className="bg-path" title={background.path}>
                {background.path
                  ? background.path.split(/[\\/]/).pop()
                  : t("appearance.backgroundEmpty")}
              </span>
            </div>
            {/* 填充方式：铺满 / 完整显示 / 拉伸。
                三选一用按钮组而不是下拉框：只有三个互斥项，全部摊开点一下就换，
                下拉框多两次点击还看不到当前布局逻辑。 */}
            <div className={`bg-fit ${background.path ? "" : "is-disabled"}`}>
              <span className="bg-fit-label">{t("appearance.backgroundFit")}</span>
              <div
                className="bg-fit-chips"
                role="group"
                aria-label={t("appearance.backgroundFitAria")}
              >
                {FIT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`bg-fit-chip ${
                      background.fit === option.id ? "selected" : ""
                    }`}
                    disabled={!background.path}
                    aria-pressed={background.fit === option.id}
                    onClick={() => background.onFit(option.id)}
                  >
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <p className="appearance-hint bg-fit-hint">{t("appearance.backgroundFitHint")}</p>

            <div className={`bg-sliders ${background.path ? "" : "is-disabled"}`}>
              {/* 焦点双轴：0% 贴左/上，50% 居中，100% 贴右/下。
                  cover 下决定裁掉哪一边，contain 下决定图靠哪边，stretch 下无视觉效果
                  （但值照样存着，切回 cover 不会丢）。 */}
              <label className="bg-slider">
                <span>{t("appearance.backgroundPosX")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={background.posX}
                  disabled={!background.path}
                  onChange={(event) => background.onPos("x", Number(event.target.value))}
                  aria-label={`${t("appearance.backgroundPosAria")} ${t(
                    "appearance.backgroundPosX",
                  )}`}
                />
                <code>{background.posX}%</code>
              </label>
              <label className="bg-slider">
                <span>{t("appearance.backgroundPosY")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={background.posY}
                  disabled={!background.path}
                  onChange={(event) => background.onPos("y", Number(event.target.value))}
                  aria-label={`${t("appearance.backgroundPosAria")} ${t(
                    "appearance.backgroundPosY",
                  )}`}
                />
                <code>{background.posY}%</code>
              </label>
              <div className="bg-reset-row">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={background.onResetPos}
                  disabled={!background.path || (background.posX === 50 && background.posY === 50)}
                  title={t("appearance.backgroundResetFocusTitle")}
                >
                  <RotateCcw size={12} /> {t("appearance.backgroundResetFocus")}
                </button>
                <span className="bg-pos-readout">
                  {background.posX}% / {background.posY}%
                </span>
              </div>
              <label className="bg-slider">
                <span>{t("appearance.backgroundOpacity")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={background.opacity}
                  disabled={!background.path}
                  onChange={(event) => background.onOpacity(Number(event.target.value))}
                  aria-label={t("appearance.backgroundOpacity")}
                />
                <code>{background.opacity}%</code>
              </label>
              <label className="bg-slider">
                <span>{t("appearance.backgroundBlur")}</span>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={background.blur}
                  disabled={!background.path}
                  onChange={(event) => background.onBlur(Number(event.target.value))}
                  aria-label={t("appearance.backgroundBlur")}
                />
                <code>{background.blur}px</code>
              </label>
              {/* 暗化遮罩：这是「文字可读性」那条的浓度旋钮。和上面的不透明度
                  不是一回事，所以两者挨着放、说明写在 title 上，免得同一张卡里
                  堆三段长注释。 */}
              <label className="bg-slider" title={t("appearance.backgroundDimHint")}>
                <span>{t("appearance.backgroundDim")}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={background.dim}
                  disabled={!background.path}
                  onChange={(event) => background.onDim(Number(event.target.value))}
                  aria-label={t("appearance.backgroundDim")}
                />
                <code>{background.dim}%</code>
              </label>
            </div>
            <p className="appearance-hint">{t("appearance.backgroundHint")}</p>
          </div>
        ) : null}
      </SettingCard>

      {/* ── 06 动效与启动 ───────────────────────────────── */}
      <SettingCard
        index="06"
        span
        eyebrow="// MOTION / STARTUP"
        title={t("appearance.groupMotion")}
        hint={t("appearance.groupMotionHint")}
        aside={<Sparkles size={16} />}
      >
        <div className="setting-list">
          <SwitchRow
            title={t("appearance.animations")}
            description={t("appearance.animationsDesc")}
            checked={preferences.animations}
            onChange={onAnimations}
          />
          <SwitchRow
            title={t("appearance.splash")}
            description={t("appearance.splashDesc")}
            checked={preferences.splash}
            onChange={onSplash}
          />
        </div>
      </SettingCard>
    </>
  );
}

/**
 * 个性化页的单张设置卡：沿用其他 Tab 的 `.panel + .panel-head` 结构，
 * 右上角放序号（01–06）保留极客感，标题下方是灰色副标题说明。
 */
function SettingCard({
  index,
  eyebrow,
  title,
  hint,
  aside,
  span = false,
  children,
}: {
  index: string;
  eyebrow: string;
  title: string;
  hint: string;
  aside?: ReactNode;
  span?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`panel settings-card appearance-card ${span ? "span-2" : ""}`}
      data-setting-card={index}
    >
      <header className="panel-head appearance-card-head">
        <div className="appearance-card-copy">
          <div className="panel-eyebrow">{eyebrow}</div>
          <h2>{title}</h2>
          <p className="appearance-card-hint">{hint}</p>
        </div>
        <div className="appearance-card-aside">
          {aside}
          <span className="appearance-section-index">{index}</span>
        </div>
      </header>
      <div className="appearance-card-body">{children}</div>
    </section>
  );
}

function BadgeLabel({ theme, custom }: { theme: string; custom: boolean }) {
  return (
    <span className="appearance-badge">
      <i /> {theme} {custom ? "+ CUSTOM ACCENT" : "PALETTE"}
    </span>
  );
}
