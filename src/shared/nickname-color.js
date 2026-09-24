// Hex spells words to the name filter: FA6 is fag, 8008 is boob. A55 is left in
// on purpose, it hits every warm tone and we never confirmed it gets rejected.
// Keep self-contained, the audit tests eval this on its own.
export function nickSafeColor(hex, prefix = "") {
  const raw = String(hex || "");
  const m = raw.match(/^(#?)([0-9A-Fa-f]{3,8})$/);
  if (!m) return raw;
  const body = m[2].toUpperCase();

  const TOKENS = ["FA6", "B00B", "8008", "1488"];
  // Low halves first so the shift stays invisible. Never alpha, that can hide it.
  const ORDER = { 3: [2, 1, 0], 4: [2, 1, 0], 6: [5, 3, 1, 4, 2, 0], 8: [5, 3, 1, 4, 2, 0] }[body.length];
  if (!ORDER) return raw;

  const clean = (text) => !TOKENS.some((token) => text.includes(token));
  const head = String(prefix || "").toUpperCase();
  if (clean(head + body)) return `${m[1] || "#"}${body}`;

  for (const index of ORDER) {
    const current = parseInt(body[index], 16);
    for (let step = 1; step <= 15; step += 1) {
      const digit = ((current + step) % 16).toString(16).toUpperCase();
      const candidate = body.slice(0, index) + digit + body.slice(index + 1);
      if (clean(head + candidate)) return `${m[1] || "#"}${candidate}`;
    }
  }
  return `${m[1] || "#"}${body}`;
}

// The filter drops punctuation, so tags run together and a word can land on the
// join between two of them.
export function sanitizeNicknameColors(code) {
  let tail = "";
  return String(code ?? "").replace(/<#([0-9A-Fa-f]{3,8})>/g, (match, h) => {
    const safe = nickSafeColor("#" + h, tail);
    const body = safe.slice(1);
    if (body.length !== h.length) return match;
    tail = body.slice(-7);
    return `<#${body}>`;
  });
}
