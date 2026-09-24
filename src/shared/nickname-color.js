// The nickname API runs a word filter over the raw string, and hex digits spell
// things: 6-as-g makes FA6 -> fag, 8-as-b makes 8008 -> boob.
//
// A55 (ass) is deliberately NOT guarded. It lands on every warm mid-tone like
// #CCAA55, so guarding it rewrites a lot of art colors, and it has not been
// confirmed as something the API rejects. Add "A55" to TOKENS below if it is.
//
// This function is self-contained on purpose: the audit tests eval it on its own,
// so anything it reads from module scope would be undefined in there.
export function nickSafeColor(hex, prefix = "") {
  const raw = String(hex || "");
  const m = raw.match(/^(#?)([0-9A-Fa-f]{3,8})$/);
  if (!m) return raw;
  const body = m[2].toUpperCase();

  const TOKENS = ["FA6", "B00B", "8008", "1488"];
  // Which nibbles may move, least visible first, alpha never. In a 6-digit color
  // the odd indexes are the low half of each channel, so moving one shifts it by
  // 1/255. Short forms only have whole-channel digits and move by 17/255.
  // Alpha stays put: nudging it can blank a glyph.
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

// The filter drops punctuation before matching, so consecutive color tags run
// together and a token can straddle the boundary. Carry the previous tag's tail
// and check the join, not just each tag alone. TMP takes 3, 4, 6 and 8 digit hex,
// and art uses the 3-digit form to save bytes, so all four are covered.
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
