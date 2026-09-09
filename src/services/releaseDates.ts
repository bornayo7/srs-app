/** Date-only releases retain the packet contract: midnight UTC on that date. */
export function parseReleaseAt(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const dateOnly = `${year}-${month}-${day}`;
  const midnight = Date.parse(`${dateOnly}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== dateOnly)
    return null;
  if (hour !== undefined && (+hour > 23 || +minute > 59 || +(second ?? 0) > 59)) return null;
  if (zone && zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function formatReleaseDate(value: number | undefined): string {
  return value === undefined || parseReleaseAt(value) === null
    ? ''
    : new Date(value).toISOString().slice(0, 10);
}
