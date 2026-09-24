// Hex digits spell words to the nickname filter: FA6 reads as fag, 8008 as boob.
// A55 (ass) is left alone on purpose. It hits every warm mid-tone like #CCAA55
// and was never confirmed as a rejection. Add it to TOKENS if it turns out to be.
// Self-contained because the audit tests eval this function alone.
export function nickSafeColor(hex, prefix = "") {
  const raw = String(hex || "");
  const m = raw.match(/^(#?)([0-9A-Fa-f]{3,8})$/);
  if (!m) return raw;
  const body = m[2].toUpperCase();

  const TOKENS = ["FA6", "B00B", "8008", "1488"];
  // Nibbles to try, least visible first. Odd indexes are a channel's low half, so
  // moving one shifts it by 1/255. Alpha is never touched: it can blank a glyph.
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

// The filter strips punctuation, so neighboring tags run together and a token can
// straddle the join. Carry the previous tail and check that, not each tag alone.
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
