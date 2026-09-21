import { useState, type FormEvent } from "react";
import { isInsecureProtocol, type AdminSessionState } from "./adminSession";

export function AdminAccess({
  state,
  protocol,
  onUnlock,
  onLock,
}: {
  state: AdminSessionState;
  protocol: string;
  onUnlock: (key: string) => Promise<void>;
  onLock: () => void;
}) {
  const [candidate, setCandidate] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (candidate) void onUnlock(candidate);
  };

  if (state.mode === "disabled") {
    return <div className="admin-access disabled">Admin disabled</div>;
  }
  if (state.mode === "verifying") {
    return <div className="admin-access">Verifying admin key…</div>;
  }
  if (state.mode === "unlocked") {
    return (
      <div className="admin-access unlocked">
        <span>Admin unlocked</span>
        {isInsecureProtocol(protocol) ? <span className="admin-http-warning">Admin key is exposed over plain HTTP</span> : null}
        <button type="button" onClick={onLock}>Lock</button>
      </div>
    );
  }
  return (
    <form className="admin-access" onSubmit={submit}>
      <label>
        <span className="sr-only">Admin API key</span>
        <input
          type="password"
          value={candidate}
          onChange={(event) => setCandidate(event.target.value)}
          placeholder="Admin API key"
          autoComplete="off"
        />
      </label>
      <button type="submit" disabled={!candidate}>Unlock admin</button>
      {state.message ? <span className="admin-message">{state.message}</span> : null}
    </form>
  );
}
