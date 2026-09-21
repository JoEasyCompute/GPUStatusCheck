export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiError(httpError(response), response.status);
    }
    throw new Error("Invalid JSON response");
  }
  if (!response.ok) {
    const message = isErrorBody(body) ? body.error : httpError(response);
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export function fetchAdminJson<T>(key: string, input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return fetchJson<T>(input, { ...init, headers });
}

export async function fetchJsonArray<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T[]> {
  const body = await fetchJson<unknown>(input, init);
  if (!Array.isArray(body)) {
    throw new Error("Expected an array response");
  }
  return body as T[];
}

function isErrorBody(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string";
}

function httpError(response: Response): string {
  return `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}
