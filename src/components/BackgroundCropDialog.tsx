import { useEffect, useRef, useState } from "react";
import { Modal } from "./ui";
import { t } from "../i18n";

const clampPct = (value: number) => Math.min(100, Math.max(0, value));
const clampZoom = (value: number) => Math.min(3, Math.max(1, value));

/**
 * 3A-3「头像式」背景构图调整。
 *
 * 预览区按真实渲染公式（background-size / background-position 百分比）显示，
 * 确认后只回传 posX / posY / zoom 三个数字——拖拽偏移不新增持久化字段，
 * 换算成现有焦点 0–100，与焦点滑块是同一份数据的两种操作方式。
 *
 * 拖拽换算：background-position 的 p% 表示「图的 p% 点对齐容器的 p% 点」，
 * 图比容器宽 (zoom-1)*W 像素，所以鼠标位移 dx 像素对应焦点变化
 * dp = -dx / ((zoom-1)*W) * 100。zoom=1 时没有可拖余量，此时显示锁定提示。
 */
export function BackgroundCropDialog({
  dataUrl,
  initialPosX,
  initialPosY,
  initialZoom,
  onConfirm,
  onClose,
}: {
  dataUrl: string;
  initialPosX: number;
  initialPosY: number;
  initialZoom: number;
  onConfirm: (next: { posX: number; posY: number; zoom: number }) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState({ x: initialPosX, y: initialPosY });
  // 初始给 1.2 而不是 1：zoom=1 时图与预览框同大，拖不了，用户会以为坏掉了。
  const [zoom, setZoom] = useState(() => clampZoom(initialZoom > 1 ? initialZoom : 1.2));
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 滚轮缩放要 preventDefault 阻止页面滚动：React 的 onWheel 是 passive 的，
  // 必须用原生监听挂 { passive: false }。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const step = event.deltaY > 0 ? -0.05 : 0.05;
      setZoom((value) => clampZoom(Math.round((value + step) * 100) / 100));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1.001) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { px: event.clientX, py: event.clientY, x: pos.x, y: pos.y };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !stage) return;
    const rect = stage.getBoundingClientRect();
    const roomX = (zoom - 1) * rect.width;
    const roomY = (zoom - 1) * rect.height;
    setPos({
      x: clampPct(drag.x - (roomX > 0 ? ((event.clientX - drag.px) / roomX) * 100 : 0)),
      y: clampPct(drag.y - (roomY > 0 ? ((event.clientY - drag.py) / roomY) * 100 : 0)),
    });
  };

  const onPointerUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  // 方向键微调：每次 2%，给键盘用户一条不靠鼠标的路。
  const onStageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 2;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setPos((value) => ({ x: clampPct(value.x + move[0]), y: clampPct(value.y + move[1]) }));
  };

  const confirm = () => {
    onConfirm({
      posX: Math.round(pos.x),
      posY: Math.round(pos.y),
      zoom: Math.round(zoom * 100) / 100,
    });
  };

  return (
    <Modal
      open
      width={720}
      eyebrow="// BACKGROUND / CROP"
      title={t("appearance.bgCropTitle")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setPos({ x: 50, y: 50 });
              setZoom(1);
            }}
          >
            {t("appearance.bgCropReset")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm}>
            {t("appearance.bgCropConfirm")}
          </button>
        </>
      }
    >
      <p className="crop-hint">{t("appearance.bgCropHint")}</p>
      <div
        ref={stageRef}
        className={`crop-stage ${dragging ? "is-dragging" : ""} ${zoom <= 1.001 ? "is-locked" : ""}`}
        style={{
          backgroundImage: `url("${dataUrl}")`,
          backgroundSize: `${zoom * 100}% auto`,
          backgroundPosition: `${pos.x}% ${pos.y}%`,
        }}
        role="img"
        aria-label={t("appearance.bgCropStageAria")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onStageKeyDown}
      >
        {zoom <= 1.001 ? (
          <span className="crop-locked-hint">{t("appearance.bgCropZoomHint")}</span>
        ) : null}
      </div>
      <div className="crop-zoom-row">
        <span>{t("appearance.bgCropZoom")}</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.05}
          value={zoom}
          onChange={(event) => setZoom(clampZoom(Number(event.target.value)))}
          aria-label={t("appearance.bgCropZoom")}
        />
        <code>{Math.round(zoom * 100)}%</code>
      </div>
    </Modal>
  );
}
