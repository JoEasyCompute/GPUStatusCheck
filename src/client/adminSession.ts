import type { AgentOperationDetail } from "../shared/types";

export const ADMIN_SESSION_KEY = "gpucheck.adminApiKey";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type AdminSessionMode = "disabled" | "locked" | "verifying" | "unlocked";
export type AdminSessionState = {
  mode: AdminSessionMode;
  key: string;
  message: string;
  selectedMachineIds: number[];
  lastOperation?: AgentOperationDetail;
};

export type AdminSessionAction =
  | { type: "status"; enabled: boolean }
  | { type: "restore"; key: string }
  | { type: "verifying"; key: string }
  | { type: "verified" }
  | { type: "verificationFailed"; message: string }
  | { type: "lock" }
  | { type: "unauthorized"; message: string }
  | { type: "selection"; machineIds: number[] }
  | { type: "lastOperation"; operation: AgentOperationDetail };

export const initialAdminSessionState: AdminSessionState = {
  mode: "locked",
  key: "",
  message: "",
  selectedMachineIds: [],
};

export function loadAdminKey(storage: StorageLike): string {
  return storage.getItem(ADMIN_SESSION_KEY) ?? "";
}

export function saveAdminKey(storage: StorageLike, key: string): void {
  storage.setItem(ADMIN_SESSION_KEY, key);
}

export function clearAdminKey(storage: StorageLike): void {
  storage.removeItem(ADMIN_SESSION_KEY);
}

export function isInsecureProtocol(protocol: string): boolean {
  return protocol !== "https:";
}

export function adminSessionReducer(state: AdminSessionState, action: AdminSessionAction): AdminSessionState {
  switch (action.type) {
    case "status":
      return action.enabled ? state : { ...initialAdminSessionState, mode: "disabled", lastOperation: state.lastOperation };
    case "restore":
    case "verifying":
      return { ...state, mode: "verifying", key: action.key, message: "" };
    case "verified":
      return { ...state, mode: "unlocked", message: "" };
    case "verificationFailed":
      return { ...initialAdminSessionState, message: action.message, lastOperation: state.lastOperation };
    case "lock":
      return { ...initialAdminSessionState, lastOperation: state.lastOperation };
    case "unauthorized":
      return { ...initialAdminSessionState, message: action.message, lastOperation: state.lastOperation };
    case "selection":
      return { ...state, selectedMachineIds: [...new Set(action.machineIds)] };
    case "lastOperation":
      return { ...state, lastOperation: action.operation };
  }
}
