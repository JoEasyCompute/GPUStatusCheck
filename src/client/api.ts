export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(httpError(response));
    }
    throw new Error("Invalid JSON response");
  }
  if (!response.ok) {
    const message = isErrorBody(body) ? body.error : httpError(response);
    throw new Error(message);
  }
  return body as T;
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
