import { AlertTriangle, Copy, FolderOpen, Link2, ShieldAlert, X } from "lucide-react";
import type { ConflictInfo, ModEntry, Snapshot } from "../types";
import { compactPath } from "../lib/format";
import { t } from "../i18n";
import { Modal, Spinner } from "./ui";

export function ConflictDialog({
  open,
  mod,
  conflicts,
  snapshot,
  busy,
  onResolve,
  onClose,
  onOpenPath,
}: {
  open: boolean;
  mod: ModEntry | null;
  conflicts: ConflictInfo[];
  snapshot: Snapshot;
  busy: boolean;
  onResolve: (otherModId: string | null) => void;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}) {
  const managed = conflicts.filter((item) => item.kind === "managed");
  const unmanaged = conflicts.filter((item) => item.kind === "unmanaged");
  const otherIds = Array.from(
    new Set(managed.map((item) => item.otherModId).filter((value): value is string => Boolean(value))),
  );
  const otherMods = otherIds
    .map((id) => snapshot.state.mods.find((item) => item.id === id) ?? null)
    .filter((item): item is ModEntry => Boolean(item));

  return (
    <Modal
      open={open}
      title={mod ? t("conflictDialog.titleWithMod", { name: mod.name }) : t("conflictDialog.title")}
      eyebrow="// CONFLICT RESOLUTION"
      width={660}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          {managed.length > 0 ? (
            <button className="btn btn-primary" onClick={() => onResolve(otherIds[0] ?? null)} disabled={busy}>
              {busy ? <Spinner size={13} /> : <Link2 size={13} />}
              {t("conflictDialog.disableRetry")}
            </button>
          ) : null}
        </>
      }
    >
      <div className="conflict-intro">
        <ShieldAlert size={20} />
        <div>
          <strong>{t("conflictDialog.introStrong")}</strong>
          <p>
            {t("conflictDialog.introCopy")}
          </p>
        </div>
      </div>

      {managed.length > 0 ? (
        <div className="conflict-block">
          <div className="conflict-block-head">
            <span>{t("conflictDialog.managedTitle")}</span>
            <span>{managed.length} FILES</span>
          </div>
          {managed.slice(0, 12).map((item, index) => (
            <div key={`${item.target}-${item.otherModId}-${index}`} className="conflict-row">
              <AlertTriangle size={14} />
              <div>
                <code>{item.target}</code>
                <span>
                  {t("conflictDialog.occupiedPrefix")}
                  <strong>{item.otherModName ?? t("conflictDialog.anotherMod")}</strong>
                  {t("conflictDialog.occupiedSuffix")}
                </span>
              </div>
            </div>
          ))}
          {managed.length > 12 ? (
            <div className="muted-line">
              {t("conflictDialog.moreFiles", { count: managed.length - 12 })}
            </div>
          ) : null}
        </div>
      ) : null}

      {unmanaged.length > 0 ? (
        <div className="conflict-block">
          <div className="conflict-block-head">
            <span>{t("conflictDialog.unmanagedTitle")}</span>
            <span>{unmanaged.length} FILES</span>
          </div>
          {unmanaged.slice(0, 10).map((item) => (
            <div key={item.target} className="conflict-row">
              <Copy size={14} />
              <div>
                <code>{item.target}</code>
                <span>{t("conflictDialog.unmanagedCopy")}</span>
              </div>
            </div>
          ))}
          {snapshot.game ? (
            <button className="btn btn-ghost btn-sm" onClick={() => onOpenPath(snapshot.game!.root)}>
              <FolderOpen size={13} /> {t("conflictDialog.gameDir")}
            </button>
          ) : null}
        </div>
      ) : null}

      {otherMods.length > 0 ? (
        <div className="conflict-candidates">
          <span className="conflict-candidates-label">{t("conflictDialog.candidates")}</span>
          {otherMods.map((item) => (
            <button
              key={item.id}
              className="conflict-candidate"
              onClick={() => onResolve(item.id)}
              disabled={busy}
            >
              <span>
                <strong>{item.name}</strong>
                <small>{compactPath(item.stagingPath, 46)}</small>
              </span>
              {busy ? <Spinner size={13} /> : <X size={13} />}
            </button>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
