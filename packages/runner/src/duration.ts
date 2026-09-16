/** Parse a duration to milliseconds. Bare numbers are seconds. */
export function parseDuration(value: unknown, field = "duration"): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value * 1000);
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a number of seconds or a duration string`);
  }
  const raw = value.trim();
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?$/i);
  if (!match) throw new Error(`invalid ${field}: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      throw new Error(`invalid ${field} unit: ${value}`);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
