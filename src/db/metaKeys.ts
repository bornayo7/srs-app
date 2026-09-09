/** These values describe this browser, never portable learning data. */
export function isLocalOnlyMetaKey(key: string): boolean {
  return key.startsWith('ai:') || key.startsWith('exchange:') || key === 'devClockOffsetMs';
}
