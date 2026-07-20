// Shared UI primitives used by the bridge widget.

/** Short-form an address / hash for display. */
export function shorten(v, head = 6, tail = 4) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
