const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function getUtcDayRange(value, now = new Date()) {
  const date = String(value || "").trim() || now.toISOString().slice(0, 10);
  const match = DATE_PATTERN.exec(date);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(Date.UTC(year, month - 1, day));

  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== day
  ) {
    return null;
  }

  const end = new Date(Date.UTC(year, month - 1, day + 1));
  return { date, start, end };
}
