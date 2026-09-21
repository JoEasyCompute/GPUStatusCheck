import type { AgentOperationDetail } from "../shared/types";
import { eligibleRetryMachineIds } from "./agentAdmin";
import { formatTime } from "./formatters";

export function AgentOperationDrawer({
  operation,
  loadingError,
  onClose,
  onRetry,
}: {
  operation: AgentOperationDetail;
  loadingError: string;
  onClose: () => void;
  onRetry: (machineIds: number[]) => void;
}) {
  const retryIds = eligibleRetryMachineIds(operation);
  return (
    <aside className="agent-operation-drawer" aria-label={`Agent operation ${operation.id}`}>
      <div className="modal-head">
        <h2>Agent operation #{operation.id}</h2>
        <span className={`status ${operation.status}`}>{operation.status}</span>
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <p>
        {operation.action} · {operation.succeededCount} succeeded · {operation.skippedCount} skipped · {operation.failedCount} failed · {operation.interruptedCount} interrupted
      </p>
      {loadingError ? <p className="load-error">Progress unavailable: {loadingError}</p> : null}
      <div className="agent-operation-items">
        {operation.items.map((item) => (
          <details key={item.id} className={`agent-operation-item ${item.status}`}>
            <summary>
              <strong>{item.machineName}</strong>
              <span>{item.status}</span>
              <span>{item.summary}</span>
              <span>{formatTime(item.finishedAt ?? item.startedAt)}</span>
            </summary>
            {item.output ? <pre>{item.output}</pre> : null}
          </details>
        ))}
      </div>
      {retryIds.length > 0 ? <button onClick={() => onRetry(retryIds)}>Retry {retryIds.length} machines</button> : null}
    </aside>
  );
}
