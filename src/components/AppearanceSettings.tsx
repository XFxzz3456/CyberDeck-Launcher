import {
  Check,
  Image as ImageIcon,
  ImageOff,
  MonitorSmartphone,
  Moon,
  EyeOff,
  Palette,
  PanelLeftClose,
  RotateCcw,
  Sun,
  Type,
  ZoomIn,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
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

/** 自定义背景图控制块（看板【皮肤 UI 优化】P0 子项），由 SettingsView 组装。 */
export interface BackgroundControl {
  path: string;
  opacity: number;
  blur: number;
  onPick: () => void;
  onClear: () => void;
  onOpacity: (value: number) => void;
  onBlur: (value: number) => void;
}

const MODE_OPTIONS: { id: ColorMode; label: string; icon: typeof Sun }[] = [
  { id: "light", label: t("appearance.modeLight"), icon: Sun },
  { id: "dark", label: t("appearance.modeDark"), icon: Moon },
  { id: "system", label: t("appearance.modeSystem"), icon: MonitorSmartphone },
];

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
    <section className="panel settings-card span-2 appearance-card">
      <div className="panel-head">
        <div>
          <div className="panel-eyebrow">// INTERFACE / PERSONALIZATION</div>
          <h2>{t("appearance.title")}</h2>
        </div>
        <BadgeLabel theme={active.name} custom={preferences.useCustomAccent} />
      </div>

      {/* 个性化页内部分成四个子分类（2026-10-30 用户反馈「坨在一起」）：
          主题与配色 / 排版与缩放 / 界面元素 / 背景与预览。
          每段自带编号与标题，段间有分隔线，滚动时能看清自己在哪一类。 */}
      <div className="appearance-sections">
        <section className="appearance-section">
          <header className="appearance-section-head">
            <span className="appearance-section-index">01</span>
            <div className="appearance-section-copy">
              <h3>{t("appearance.groupTheme")}</h3>
              <p>{t("appearance.groupThemeHint")}</p>
            </div>
          </header>
          <div className="appearance-grid">
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
          </div>
        </section>

        <section className="appearance-section">
          <header className="appearance-section-head">
            <span className="appearance-section-index">02</span>
            <div className="appearance-section-copy">
              <h3>{t("appearance.groupTypography")}</h3>
              <p>{t("appearance.groupTypographyHint")}</p>
            </div>
          </header>

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
        </section>

        <section className="appearance-section">
          <header className="appearance-section-head">
            <span className="appearance-section-index">03</span>
            <div className="appearance-section-copy">
              <h3>{t("appearance.groupLayout")}</h3>
              <p>{t("appearance.groupLayoutHint")}</p>
            </div>
          </header>

          <div className="appearance-two-col">
          <div className="sidebar-pref">
            <SwitchRow
              title={t("appearance.collapseSidebar")}
              description={t("appearance.collapseSidebarDesc")}
              checked={preferences.sidebarCollapsed}
              onChange={onSidebarCollapsed}
            />
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

          {/* 右列：导航可见性。和左列的动效开关分开，避免一排开关连成一片。 */}
          <div className="appearance-block">
          {/* 界面显示管理（deepseek 任务·模块四）：隐藏侧栏入口；模组库/设置受保护。 */}
          <div className="appearance-label">
            <EyeOff size={13} /> {t("appearance.hiddenViewsLabel")}
          </div>
          <p className="bg-hint">{t("appearance.hiddenViewsHint")}</p>
          <div className="sidebar-pref">
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
          </div>
          </div>
        </section>

        <section className="appearance-section">
          <header className="appearance-section-head">
            <span className="appearance-section-index">04</span>
            <div className="appearance-section-copy">
              <h3>{t("appearance.groupBackdrop")}</h3>
              <p>{t("appearance.groupBackdropHint")}</p>
            </div>
          </header>

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
              <div className={`bg-sliders ${background.path ? "" : "is-disabled"}`}>
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
              </div>
              <p className="appearance-hint">{t("appearance.backgroundHint")}</p>
            </div>
          ) : null}

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
        </section>
      </div>
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
