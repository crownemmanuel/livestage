export function uid(prefix = "id"): string {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${r[0].toString(36)}${r[1].toString(36)}`.slice(0, prefix.length + 12);
}
