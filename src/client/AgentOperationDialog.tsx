import type { AgentAction, MachineWithLatest } from "../shared/types";

export function AgentOperationDialog({
  machines,
  action,
  concurrency,
  submitting,
  onActionChange,
  onConfirm,
  onClose,
}: {
  machines: MachineWithLatest[];
  action: AgentAction;
  concurrency: number;
  submitting: boolean;
  onActionChange: (action: AgentAction) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-panel agent-operation-dialog" role="dialog" aria-modal="true" aria-label="Manage agents" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>Manage agents</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="agent-action-options">
          <button className={action === "install" ? "active" : ""} onClick={() => onActionChange("install")}>Install / Upgrade</button>
          <button className={action === "uninstall" ? "active" : ""} onClick={() => onActionChange("uninstall")}>Uninstall</button>
        </div>
        <p>{machines.length} machines · up to {concurrency} concurrent SSH jobs · passwordless sudo required.</p>
        {action === "uninstall" ? <p className="agent-danger">Uninstall removes buffered agent data and the systemd timer from every selected host.</p> : null}
        <ul className="agent-target-list">
          {machines.map((machine) => <li key={machine.id}>{machine.name} <span>{machine.ip}</span></li>)}
        </ul>
        <div className="settings-actions">
          <button onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={submitting || machines.length === 0}>
            {submitting ? "Submitting…" : action === "install" ? "Install / Upgrade agents" : "Uninstall agents"}
          </button>
        </div>
      </div>
    </div>
  );
}
