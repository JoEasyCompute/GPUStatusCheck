/**
 * nvidia UUIDs look like GPU-104a9675-4527-58e0-1046-9537e3293d95; the first
 * hex group is already distinctive enough to scan a table by, and the full
 * value stays available in the title attribute and the detail modal.
 */
export function shortUuid(uuid: string): string {
  const body = uuid.startsWith("GPU-") ? uuid.slice(4) : uuid;
  const firstGroup = body.split("-")[0] ?? body;
  return firstGroup || uuid;
}
