// rawCode is the exact in-game TMP markup, while the structured fields are
// used as soon as somebody touches a Forge control. A short name plus one
// extra line is still name + title. Art (ASCII, dots, braille) stays in
// the name so spaces and breaks are not crushed.
export function isAsciiArtText(text) {
  const artMark = /[\\/_#.*:`'"^~+\-|<>()[\]{}=$@%!?]|[·•●○◦∙⋅░▒▓█▄▀▌▐■□▪▫]|[\u2800-\u28FF]|[\u2580-\u25FF]/;
  const isArtLine = (line) => {
    const chars = [...String(line ?? "")].filter((ch) => ch !== " " && ch !== "\t");
    if (chars.length < 2) return false;
    const marks = chars.filter((ch) => artMark.test(ch)).length;
    return marks / chars.length >= 0.5;
  };
  const lines = String(text ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .split(/\r\n?|\n/)
    .filter((line) => line.trim().length || /[\u2800]/.test(line));
  if (lines.length >= 3) return true;
  if (lines.length >= 2 && lines.filter(isArtLine).length >= 2) return true;
  return lines.some((line) =>
    /[\\/_]{2,}/.test(line)
    || /[.]{3,}/.test(line)
    || /[·•●○◦∙⋅]{2,}/.test(line)
    || /[\u2800-\u28FF]{2,}/.test(line)
    || /[\u2580-\u25FF]{2,}/.test(line)
  );
}

export function artLineStats(text) {
  const lines = String(text ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const visible = (line) => [...String(line)
    .replace(/<color=#00000000>\.*<\/color>/gi, "")
    .replace(/<#00000000>\./gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+$/g, "")].length;
  return {
    lines,
    height: lines.length,
    width: lines.reduce((max, line) => Math.max(max, visible(line)), 0),
  };
}

export function artFitSizePct(height, width) {
  // Tight line-height lets more rows fit, so shrink less than a 4-line nameplate.
  const byHeight = height <= 4 ? 100 : Math.round((7 / height) * 100);
  const byWidth = width <= 20 ? 100 : Math.round((20 / width) * 100);
  return Math.max(22, Math.min(100, byHeight, byWidth));
}

export function artLineHeightPct(height) {
  if (height <= 1) return 100;
  return 100;
}

// All one glyph means every cell is the same width, so mspace is wasted. cspace
// and a tight line-height shrink the cell to the ink, which is how 100 columns
// fit a plate that only holds 20 mspace ones.
// Keep self-contained, the audit tests eval each of these on its own.
export function artUniformGlyph(text) {
  const chars = String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\s\u00A0]/g, "");
  if (chars.length < 64) return null;
  const first = chars[0];
  for (const ch of chars) if (ch !== first) return null;
  return first;
}

export function artDotPackMetrics(glyph, width, height, incoming = null) {
  // adv is the cursor step, ink is what gets painted. Cells touch when the width
  // matches the ink. A name we know works uses '.' at .088 ink minus .278 adv.
  const GLYPH_BOX = {
    ".": { adv: 0.278, inkW: 0.088, inkH: 0.15 },
    "\u00B7": { adv: 0.278, inkW: 0.11, inkH: 0.11 },
    "\u2022": { adv: 0.35, inkW: 0.24, inkH: 0.24 },
    "#": { adv: 0.556, inkW: 0.5, inkH: 0.55 },
    "\u2588": { adv: 1, inkW: 1, inkH: 1 },
    "\u25A0": { adv: 1, inkW: 0.8, inkH: 0.8 },
    "\u25AA": { adv: 0.5, inkW: 0.45, inkH: 0.45 },
    "\u25CF": { adv: 1, inkW: 0.75, inkH: 0.75 },
  };
  // What the nameplate fits at 100%: 20 cols of 0.65em, 7 rows of 0.95em.
  const PLATE_W_EM = 13;
  const PLATE_H_EM = 6.65;

  const box = GLYPH_BOX[glyph];
  if (!box || !width || !height) return null;
  const cspace = incoming && incoming.cspace != null
    ? incoming.cspace
    : Math.round((box.inkW - box.adv) * 1000) / 1000;
  const lineHeight = incoming && incoming.lineHeight > 0 ? incoming.lineHeight : box.inkH;
  const cellW = box.adv + cspace;
  if (cellW <= 0) return null;
  const fit = Math.min(PLATE_W_EM / (width * cellW), PLATE_H_EM / (height * lineHeight));
  return { cspace, lineHeight, size: Math.max(5, Math.min(100, Math.floor(fit * 100))) };
}

export function wrapPackedDotArt(body, metrics, align) {
  const side = normalizeForgeAlign(align);
  const padded = /<br\s*\/?\s*>\s*$/i.test(body) ? body : `${body}<br>`;
  let out = `<align=left>${padded}</align>`;
  if (metrics.cspace) out = `<cspace=${metrics.cspace}em>${out}`;
  out = `<line-height=${metrics.lineHeight}em>${out}`;
  if (metrics.size < 100) out = `<size=${metrics.size}%>${out}`;
  if (side !== "left") out = `<rgnf-align=${side}>` + out;
  return out;
}

export function artMspaceEm(text) {
  if (/[\u2800-\u28FF\u2580-\u25FF]/.test(text)) return "0.72em";
  if (/[#:+]/.test(text) && /[.:]/.test(text) && !/[\\/_]{2,}/.test(text)) return "0.72em";
  if (/[·•●○◦∙⋅.]/.test(text) && !/[\\/_]{2,}/.test(text)) return "0.68em";
  return "0.65em";
}

// A hair taller than mspace so #/. grids are not squat.
export function artLineHeightEm(text, height) {
  if (height <= 1) return null;
  const mspace = artMspaceEm(text);
  if (mspace === "0.72em") return "1.12em";
  if (mspace === "0.68em") return "0.95em";
  return "0.88em";
}

// Rocket Goal's font has no braille. Those cells become tofu boxes in-game.
export function isBrailleArtText(text) {
  const chars = [...String(text ?? "").replace(/<[^>]*>/g, "")]
    .filter((ch) => ch !== "\n" && ch !== "\r" && ch !== "\t");
  if (chars.length < 8) return false;
  const braille = chars.filter((ch) => ch >= "\u2800" && ch <= "\u28FF").length;
  return braille / chars.length >= 0.2;
}

export function brailleToAsciiArt(text) {
  return String(text ?? "").replace(/[\u2800-\u28FF]/g, (ch) => {
    let bits = ch.codePointAt(0) - 0x2800;
    let n = 0;
    while (bits) {
      n += bits & 1;
      bits >>= 1;
    }
    if (n === 0) return " ";
    if (n <= 2) return ".";
    if (n <= 4) return ":";
    if (n <= 6) return "+";
    return "#";
  });
}

// 21.8 used = / ' as filter-safe stand-ins. Put + / : back for looks.
// Strip leftover filter-break markers from older Apply attempts.
export function restorePreferredArtChars(text) {
  return String(text ?? "")
    .replace(/<size=0>\.<\/size>/gi, "")
    .replace(/<size=0>x<\/size>/gi, "")
    .replace(/\u200B/g, "")
    .replace(/(<[^>]*>)|[=']/g, (all, tag) => {
      if (tag) return tag;
      return all === "=" ? "+" : ":";
    });
}

export function gameSafeArtChars(text) {
  return restorePreferredArtChars(text);
}

export function artPreviewText(text) {
  return restorePreferredArtChars(brailleToAsciiArt(text));
}

export function preserveForgeNewlines(code) {
  return String(code ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>");
}

export function wrapAsciiMonospace(code) {
  const value = String(code ?? "");
  if (!value || /<mspace=/i.test(value)) return value;
  return `<mspace=0.6em>${value}</mspace>`;
}

// Transparent `.` — the game font has that glyph. NBSP became tofu boxes.
export const ART_WIDTH_PAD = "<#00000000>.";

export function stripArtWidthPads(line) {
  return String(line ?? "")
    .replace(/<color=#00000000>\.*<\/color>/gi, "")
    .replace(/<#00000000>\./gi, "")
    .replace(/<\/?rgnf-align[^>]*>/gi, "")
    .replace(/<space=[^>]*>/gi, "")
    .replace(/\u00A0/g, " ");
}

export function visibleArtWidth(line) {
  return [...stripArtWidthPads(line).replace(/<[^>]*>/g, "").replace(/[ \t]+$/g, "")].length;
}

// Same column budget as artFitSizePct. Center/right keep <align=left>
// (so the last row stays put) and shift the whole block with a closed
// transparent indent the game font can actually draw.
export function artBlockIndentCols(width, align) {
  const side = normalizeForgeAlign(align);
  const extra = Math.max(0, 20 - (Number(width) || 0));
  if (side === "center") return Math.floor(extra / 2);
  if (side === "right") return extra;
  return 0;
}

export function artIndentPad(cols) {
  const n = Math.max(0, Number(cols) || 0);
  if (!n) return "";
  return `<color=#00000000>${".".repeat(n)}</color>`;
}

export function indentArtBody(body, cols) {
  const pad = artIndentPad(cols);
  if (!pad) return String(body ?? "");
  const parts = String(body ?? "").split(/(<br\s*\/?\s*>)/i);
  return parts.map((part, i) => {
    if (/^<br\s*\/?\s*>$/i.test(part)) return part;
    if (!part && i === parts.length - 1) return part;
    return pad + part;
  }).join("");
}

export function padArtLineToWidth(line, width, mspace) {
  const value = stripArtWidthPads(line).replace(/[ \t]+$/g, "");
  const visible = visibleArtWidth(value);
  if (!Number(width) || visible >= width) return value;
  const em = Number.parseFloat(String(mspace ?? "").replace(/em$/i, ""));
  const cell = Number.isFinite(em) && em > 0 ? em : 0.72;
  const pad = Math.round((width - visible) * cell * 100) / 100;
  return `${value}<space=${pad}em>`;
}

export function padArtBodyLines(body, width, mspace) {
  const parts = String(body ?? "").split(/(<br\s*\/?\s*>)/i);
  return parts.map((part, i) => {
    if (/^<br\s*\/?\s*>$/i.test(part)) return part;
    const lastEmpty = !part && i === parts.length - 1;
    if (lastEmpty) return part;
    return padArtLineToWidth(part, width, mspace);
  }).join("");
}

// Nameplates clip the last glyph row. A trailing <br> leaves an empty
// line-box so the last visible row sits above the clip. Skip if one is
// already there so Apply / pack does not keep stacking blanks.
export function padArtLastLine(markup, height) {
  const value = String(markup ?? "");
  if (!value || Number(height) < 2) return value;
  if (/(<br\s*\/?\s*>|\n)\s*(<\/mspace>)?\s*$/i.test(value)) return value;
  if (/<\/mspace>\s*$/i.test(value)) {
    return value.replace(/<\/mspace>\s*$/i, "<br></mspace>");
  }
  return value + "<br>";
}

// #CCAA55 and #CA5 are the same color, one is 3 bytes shorter. Art has thousands
// of tags so that adds up. Only shrinks when it can do it without changing color.
export function shrinkHexTags(code) {
  return String(code ?? "").replace(/<#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})>/g, (match, body) => {
    const pairs = body.match(/../g) || [];
    if (!pairs.every((pair) => pair[0].toLowerCase() === pair[1].toLowerCase())) return match;
    return `<#${pairs.map((pair) => pair[0]).join("")}>`;
  });
}

// Monospace + fit-to-nameplate. Plain art `<` `>` become fullwidth so TMP
// does not eat the rest of a FIGlet / dot piece as tags.
// Left-align so each row shares an edge the way the preview does. The
// nameplate centers the whole block; it must not center each line.
export function normalizeForgeAlign(value) {
  const v = String(value || "").toLowerCase();
  return v === "center" || v === "right" ? v : "left";
}

export function forgeAlignJustify(align) {
  const v = normalizeForgeAlign(align);
  if (v === "right") return "flex-end";
  if (v === "center") return "center";
  return "flex-start";
}

export function wrapPackedArt(body, mspace, lineHeight, size, align) {
  // The game lifts the last line of a name into a title slot (centered,
  // default leading). An empty trailing <br> keeps the real last art row
  // inside the mspace block. Art itself stays left-aligned so a short
  // last row does not jump; center/right only indent the block.
  const side = normalizeForgeAlign(align);
  const padded = /<br\s*\/?\s*>\s*$/i.test(body) ? body : `${body}<br>`;
  let out = `<align=left><mspace=${mspace}>${padded}</mspace></align>`;
  if (side !== "left") out = `<rgnf-align=${side}>` + out;
  if (lineHeight) out = `<line-height=${lineHeight}>${out}`;
  if (size < 100) out = `<size=${size}%>${out}`;
  return out;
}

export function packAsciiArt(text, align) {
  const side = normalizeForgeAlign(align);
  const value = gameSafeArtChars(brailleToAsciiArt(stripArtWidthPads(String(text ?? ""))));
  if (!value) return value;
  if (/<mspace=/i.test(value)) {
    const mspace = artMspaceEm(value);
    const brs = (value.match(/<br\s*\/?\s*>/gi) || []).length;
    const lineHeight = artLineHeightEm(value, brs + 1);
    let packed = value
      .replace(/<\/?rgnf-align[^>]*>/gi, "")
      .replace(/<\/?align[^>]*>/gi, "")
      .replace(/<mspace=[^>]*>/gi, `<mspace=${mspace}>`);
    packed = preserveForgeNewlines(packed);
    let inner = (packed.match(/<mspace=[^>]*>([\s\S]*?)<\/mspace>/i) || [])[1];
    const sizeTag = packed.match(/<size=(\d+)%?>/i);
    const size = sizeTag ? Number(sizeTag[1]) : 100;
    if (inner == null) inner = packed;
    if (side !== "left") {
      const width = artLineStats(inner.replace(/<br\s*\/?\s*>/gi, "\n")).width;
      inner = indentArtBody(inner, artBlockIndentCols(width, side));
    }
    return wrapPackedArt(inner, mspace, lineHeight, size, side);
  }
  // We re-emit these below, so drop any that came in with pasted art.
  const tagNum = (re) => { const m = value.match(re); return m ? Number(m[1]) : null; };
  const incoming = {
    lineHeight: tagNum(/<line-height=(-?\.?\d*\.?\d+)\s*em>/i),
    cspace: tagNum(/<cspace=(-?\.?\d*\.?\d+)\s*em>/i),
  };
  const normalized = value
    .replace(/<\/?(?:size|line-height|cspace)(?:=[^>]*)?>/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n");
  const lines = normalized.split("\n");
  const hasTmp = /<(size|color|b|i|u|s|mark|sprite|sub|sup|align|space|mspace|rotate|pos|voffset|line-height|\/|#)/i.test(normalized)
    || /<#[0-9A-Fa-f]{3,8}>/.test(normalized);
  const stats = artLineStats(normalized);
  let body = lines.map((line) => {
    const safe = hasTmp ? line : line.replace(/</g, "\uFF1C").replace(/>/g, "\uFF1E");
    return safe;
  }).join("<br>");
  if (side !== "left") {
    body = indentArtBody(body, artBlockIndentCols(stats.width, side));
  }
  const uniform = artUniformGlyph(normalized);
  if (uniform) {
    // Pasted art that brought its own metrics knows better than our defaults.
    const metrics = artDotPackMetrics(uniform, stats.width, stats.height, incoming);
    if (metrics) return wrapPackedDotArt(body, metrics, side);
  }
  const size = artFitSizePct(stats.height, stats.width);
  const mspace = artMspaceEm(normalized);
  const lineHeight = artLineHeightEm(normalized, stats.height);
  return wrapPackedArt(body, mspace, lineHeight, size, side);
}
