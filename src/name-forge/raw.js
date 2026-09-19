import { isAsciiArtText } from "./art.js";

// module-scope so rawSnapshotFields doesn't reach into createNameForge
export function alignFromRawInline(raw) {
  const value = String(raw ?? "");
  const marked = value.match(/<rgnf-align=(left|center|right)>/i);
  if (marked) return marked[1].toLowerCase();
  const m = value.match(/<align\s*=\s*(left|center|right)>/i);
  if (m) return m[1].toLowerCase();
  return "left";
}

export function editableTextFromRaw(raw) {
  return String(raw ?? "")
    .replace(/<color=#00000000>\.*<\/color>/gi, "")
    .replace(/<#00000000>\./gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<(?!sprite=\d+\s*>)[^>]*>/gi, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

export function editableFieldsFromRaw(raw) {
  const prepared = String(raw ?? "").replace(/<br\s*\/?\s*>/gi, "\n");
  if (isAsciiArtText(prepared)) {
    return {
      name: editableTextFromRaw(prepared),
      titleOn: false,
      titleText: "",
    };
  }
  const lines = prepared
    .split(/\r\n?|\n/)
    .map(editableTextFromRaw)
    .filter((line) => line.trim().length);
  const titleText = lines.length > 1 ? lines[lines.length - 1] : "";
  return {
    name: lines[0] ?? "",
    titleOn: Boolean(titleText),
    titleText,
  };
}

// Names without a Scored suffix keep the player's saved default (Hide, etc).
export function resolveScoredMode(parsedMode, pref) {
  if (parsedMode && parsedMode !== 'default') return parsedMode;
  if (pref === 'hide' || pref === 'tiny' || pref === 'styled' || pref === 'default') {
    return pref;
  }
  return parsedMode || 'default';
}

export function scoredSuffix(s) {
  switch (s.scoredMode) {
    case 'hide': return '<size=0>';
    case 'tiny': return '<sub><size=25%>';
    case 'styled': return `<size=${s.scoredSizePct}%><${s.scoredColor.toUpperCase()}>`;
    default: return '';
  }
}

export function splitRawScoredSuffix(raw) {
  const value = String(raw ?? '');
  let match = value.match(/<size=0>\s*$/i);
  if (match) {
    return { rawCode: value.slice(0, match.index), scoredMode: 'hide' };
  }
  match = value.match(/<sub><size=25%>\s*$/i);
  if (match) {
    return { rawCode: value.slice(0, match.index), scoredMode: 'tiny' };
  }
  // Older custom names hid "Scored!" by stacking many empty <sub> tags.
  // That shrinks/moves the text but keeps its width, shifting centered titles.
  match = value.match(/(?:\s*<sub>){4,}\s*$/i);
  if (match) {
    return { rawCode: value.slice(0, match.index), scoredMode: 'hide' };
  }
  match = value.match(/<size=(\d+)%><(#[0-9a-f]{6})>\s*$/i);
  if (match) {
    return {
      rawCode: value.slice(0, match.index),
      scoredMode: 'styled',
      scoredSizePct: Number(match[1]),
      scoredColor: match[2],
    };
  }
  return { rawCode: value, scoredMode: 'default' };
}

export function rawSnapshotFields(raw) {
  const scored = splitRawScoredSuffix(raw);
  return {
    rawCode: scored.rawCode,
    ...editableFieldsFromRaw(scored.rawCode),
    colorMode: 'none',
    solidAlpha: 255,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePct: 100,
    rotateDeg: 0,
    waveOn: false,
    markOn: false,
    titleColorMode: 'inherit',
    titleSizePct: 100,
    titleSub: false,
    titlePaletteKey: null,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    titleAlpha: 255,
    align: alignFromRawInline(scored.rawCode),
    scoredMode: scored.scoredMode,
    ...(scored.scoredSizePct ? { scoredSizePct: scored.scoredSizePct } : {}),
    ...(scored.scoredColor ? { scoredColor: scored.scoredColor } : {}),
  };
}

export function editableGlyphs(text) {
  const glyphs = [];
  const value = String(text ?? '');
  for (let i = 0; i < value.length;) {
    const sprite = value.slice(i).match(/^<sprite=\d+\s*>/i);
    if (sprite) {
      glyphs.push(sprite[0]);
      i += sprite[0].length;
      continue;
    }
    const glyph = String.fromCodePoint(value.codePointAt(i));
    glyphs.push(glyph);
    i += glyph.length;
  }
  return glyphs;
}

export function replaceRawVisibleText(raw, nextText) {
  const replacements = editableGlyphs(nextText);
  const value = String(raw ?? '');
  const tokens = [];
  for (let i = 0; i < value.length;) {
    if (value[i] === '<') {
      const close = value.indexOf('>', i);
      if (close >= 0) {
        const tag = value.slice(i, close + 1);
        tokens.push({
          type: /^<sprite=\d+\s*>$/i.test(tag) ? 'visible' : 'tag',
          value: tag,
        });
        i = close + 1;
        continue;
      }
    }
    const glyph = String.fromCodePoint(value.codePointAt(i));
    tokens.push({ type: 'visible', value: glyph });
    i += glyph.length;
  }
  let lastVisible = -1;
  tokens.forEach((token, index) => {
    if (token.type === 'visible') lastVisible = index;
  });
  let replacementIndex = 0;
  let output = '';
  let trailingTags = '';
  tokens.forEach((token, index) => {
    if (index > lastVisible && token.type === 'tag') {
      trailingTags += token.value;
    } else if (token.type === 'tag') {
      output += token.value;
    } else if (replacementIndex < replacements.length) {
      output += replacements[replacementIndex++];
    }
  });
  if (lastVisible < 0) {
    output = '';
    trailingTags = tokens.map(token => token.value).join('');
  }
  return output
    + replacements.slice(replacementIndex).join('')
    + trailingTags;
}

export function replaceRawNameText(raw, nextName) {
  const value = String(raw ?? '');
  if (isAsciiArtText(value) || isAsciiArtText(nextName)) {
    return replaceRawVisibleText(value, nextName);
  }
  const lineBreak = /<br\s*\/?\s*>|\r\n?|\n/i;
  const match = lineBreak.exec(value);
  if (!match) return replaceRawVisibleText(value, nextName);
  return replaceRawVisibleText(value.slice(0, match.index), nextName)
    + value.slice(match.index);
}

export function replaceRawTitleText(raw, nextTitle) {
  const value = String(raw ?? '');
  const lineBreak = /<br\s*\/?\s*>|\r\n?|\n/gi;
  const lines = [];
  let lineStart = 0;
  let match;
  while ((match = lineBreak.exec(value)) !== null) {
    lines.push({ start: lineStart, end: match.index });
    lineStart = match.index + match[0].length;
  }
  lines.push({ start: lineStart, end: value.length });
  if (lines.length === 1) {
    return nextTitle ? value + '<br>' + nextTitle : value;
  }
  let titleLine = null;
  for (let i = lines.length - 1; i >= 1; i--) {
    const candidate = value.slice(lines[i].start, lines[i].end);
    if (editableTextFromRaw(candidate)) {
      titleLine = lines[i];
      break;
    }
  }
  titleLine ||= lines[lines.length - 1];
  return value.slice(0, titleLine.start)
    + replaceRawVisibleText(
      value.slice(titleLine.start, titleLine.end),
      nextTitle,
    )
    + value.slice(titleLine.end);
}

// Recognise the stacked-layer emission pattern (base name followed by
// one or more <pos=…>…text…</color> blocks) so a reset / steal / paste
// lands as an editable base name + populated Layers cards, not a raw
// markup blob that concatenates every layer's text into one field.
export function decodeLayeredRaw(raw) {
  const src = String(raw || '');
  const posRe = /<pos=[^>]*>/gi;
  const boundaries = [];
  let m;
  while ((m = posRe.exec(src)) !== null) boundaries.push({ start: m.index, tagLen: m[0].length });
  if (!boundaries.length) return null;
  const basePart = src.slice(0, boundaries[0].start);
  let baseName = basePart.replace(/<[^>]*>/g, '').trim();
  const layers = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].start + boundaries[i].tagLen;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].start : src.length;
    let chunk = src.slice(start, end);
    const ghostRe = /^<color=#[0-9A-Fa-f]{6}00>[\s\S]*?<\/color>/i;
    if (ghostRe.test(chunk)) chunk = chunk.replace(ghostRe, '');
    const spaceMatch = chunk.match(/^<space=([-\d.]+)em>/i);
    const x = spaceMatch ? Number(spaceMatch[1]) : 0;
    if (spaceMatch) chunk = chunk.slice(spaceMatch[0].length);
    const colorMatch = chunk.match(/<color=(#[0-9A-Fa-f]{6,8})>/i);
    const rawColor = colorMatch ? colorMatch[1] : '#ffffff';
    const color = rawColor.length === 9 ? rawColor.slice(0, 7) : rawColor;
    const voffsetMatch = chunk.match(/<voffset=(-?[\d.]+)em>/i);
    const y = voffsetMatch ? Number(voffsetMatch[1]) : 0;
    const bold = /<b>/i.test(chunk);
    const sizeMatch = chunk.match(/<size=(\d+)%?>/i);
    const sizePct = sizeMatch ? Number(sizeMatch[1]) : 100;
    const text = chunk.replace(/<[^>]*>/g, '').trim();
    if (!text) continue;
    layers.push({ text, color, x, y, sizePct, bold });
  }
  if (!layers.length) return null;
  // If a prior emit accidentally accumulated layer text into the base (e.g.
  // "RIS3NRIS3NRIS3N" instead of "RIS3N"), collapse it back to one copy.
  const layerTexts = layers.map(l => l.text).filter(Boolean);
  if (baseName && layerTexts.length && layerTexts.every(t => t === layerTexts[0])) {
    const one = layerTexts[0];
    if (baseName.length % one.length === 0 && baseName === one.repeat(baseName.length / one.length)) {
      baseName = one;
    }
  }
  // Blank a layer's text when it matches the (now-canonical) base name so the
  // Layers UI shows the "defaults to your name" placeholder.
  for (const L of layers) if (L.text === baseName) L.text = '';
  return { baseName, layers };
}
