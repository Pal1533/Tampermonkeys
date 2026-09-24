import { nickSafeColor, sanitizeNicknameColors } from "../shared/nickname-color.js";
import {
  nameForgePresetKey,
  nameForgeHistoryKey,
  PALETTES,
  SPRITES,
  spriteEmoji,
} from "./constants.js";
import { saveJSON, loadJSON } from "./storage.js";
import {
  isAsciiArtText,
  artLineStats,
  artFitSizePct,
  artLineHeightPct,
  artMspaceEm,
  artLineHeightEm,
  artUniformGlyph,
  artDotPackMetrics,
  shrinkHexTags,
  isBrailleArtText,
  brailleToAsciiArt,
  restorePreferredArtChars,
  gameSafeArtChars,
  artPreviewText,
  preserveForgeNewlines,
  wrapAsciiMonospace,
  stripArtWidthPads,
  visibleArtWidth,
  artBlockIndentCols,
  artIndentPad,
  indentArtBody,
  padArtLineToWidth,
  padArtBodyLines,
  padArtLastLine,
  normalizeForgeAlign,
  forgeAlignJustify,
  wrapPackedArt,
  packAsciiArt,
} from "./art.js";
import {
  hexToRgb,
  rgbToHex,
  lerpColor,
  normalizeColorSpans,
  colorStyleAt,
  splitByColorSpans,
  cloneColorStyle,
  bakeUncoveredColorSpans,
  subtractColorRange,
  applySliceColor,
  expandPaintHex,
  colorSpansFromRawName,
  gradientAt,
  alphaHex,
  hslToHex,
  randomStops,
  esc,
} from "./paint.js";
import {
  editableTextFromRaw,
  editableFieldsFromRaw,
  resolveScoredMode,
  scoredSuffix,
  splitRawScoredSuffix,
  rawSnapshotFields,
  editableGlyphs,
  replaceRawVisibleText,
  replaceRawNameText,
  replaceRawTitleText,
  decodeLayeredRaw,
} from "./raw.js";
import {
  colorizeText,
  colorizeNamedArt,
  tokenize,
  resolveTitleColorStyle,
  resolveSubtitleColorStyle,
} from "./markup.js";

export function createNameForge(host = {}) {
  const dbg = typeof host.dbg === "function"
    ? host.dbg
    : (msg) => console.log("[RG HUD] " + msg);
  const getErrMsg = typeof host.getErrMsg === "function"
    ? host.getErrMsg
    : (e) => (e && e.message ? e.message : String(e));
  const stripLeadingClanTagMarkup = typeof host.stripLeadingClanTagMarkup === "function"
    ? host.stripLeadingClanTagMarkup
    : (value) => value;

      let _rgnfFab = null, _rgnfPanel = null;

  // ---- Constants ----
  const API_URL = 'https://us-central1-rocketball-23c12.cloudfunctions.net/v0304_player/nickname';
  // Quantum's frame is 49152 bytes and the name shares it, so leave room. 40k
  // works in game, 81k crashed the client.
  const NICKNAME_BYTE_LIMIT = 48000;
  const NICKNAME_BYTE_WARN = 40000;
  const STORE_KEY_LEGACY = 'rgNameForge.presets.v1';
  const STATE_KEY_LEGACY = 'rgNameForge.lastState.v1';
  // per-account state, legacy key read once as a fallback on upgrade
  let _currentUserId = null;
  let _lastRawNickname = '';
  const stateKey = () => _currentUserId ? ('rgNameForge.state.v5.' + _currentUserId) : STATE_KEY_LEGACY;

  const presetKey = () => nameForgePresetKey(_currentUserId);
  const folderCollapseKey = () => 'rgNameForge.folderCollapse.v2.' + (_currentUserId || 'anon');

  const historyKey = () => nameForgeHistoryKey(_currentUserId);
  // steal receipt. boot-time SetNickname echo can undo a fresh steal, so we
  // re-apply once after boot if the login nickname doesn't match.
  const pendingStealKey = () => 'rgNameForge.pendingSteal.v1.' + (_currentUserId || 'anon');
  const PENDING_STEAL_TTL_MS = 15 * 60 * 1000;
  const FABPOS_KEY = 'rgNameForge.fabPos.v1';

  // ---- State ----
  const defaultState = () => ({
    name: 'RootedEngineering',
    colorMode: 'gradient',            // 'none' | 'solid' | 'gradient'
    solidColor: '#22d3ee',
    stops: ['#22d3ee', '#e94fff'],    // 2-5 gradient stops
    skipSpaces: true,                 // don't waste tags coloring spaces
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sizePct: 100,                     // <size=N%>
    rotateDeg: 0,                     // <rotate=N>
    waveOn: false,                    // per-letter alternating rotation
    waveAmp: 12,                      // wave tilt degrees
    markOn: false,
    markColor: '#facc15',
    markAlpha: 64,                    // 0-255 -> hex alpha appended to mark color
    titleOn: false,
    titleText: '',
    titleColorMode: 'solid',          // 'inherit' | 'solid' | 'gradient'
    titleColor: '#94a3b8',
    titleSizePct: 60,
    titleSub: true,                   // wrap title in <sub> for that low-set look
    // title has its own styling now, used to borrow name's stops
    titleStops: ['#ff8fb1', '#a78bfa'],
    titlePaletteKey: null,
    titleBold: false,
    titleItalic: false,
    titleUnderline: false,
    titleStrike: false,
    titleAlpha: 255,                  // 0-255 alpha on titleColor (solid only)
    titleGapLines: 1,                 // blank lines inserted between name/art and title
    // Subtitle mirrors title but sits below it; independent styling.
    subtitleOn: false,
    subtitleText: '',
    subtitleColorMode: 'inherit',     // 'inherit' | 'solid' | 'gradient'
    subtitleColor: '#94a3b8',
    subtitleSizePct: 55,
    subtitleSub: true,
    subtitleStops: ['#ff8fb1', '#a78bfa'],
    subtitlePaletteKey: null,
    subtitleBold: false,
    subtitleItalic: false,
    subtitleUnderline: false,
    subtitleStrike: false,
    subtitleAlpha: 255,
    subtitleGapLines: 0,              // blank lines between title and subtitle
    // alpha on the name's solid color, dims trailing URL text etc
    solidAlpha: 255,
    colorSpans: [],                   // selected-range paints; empty = whole name
    scoredMode: readScoredDefault() || 'default', // 'default' | 'hide' | 'tiny' | 'styled'
    scoredColor: '#22d3ee',
    scoredSizePct: 100,
    rawCode: null,                    // when set: exact current in-game markup, used verbatim
    align: readAlignDefault() || 'left',
    layers: [],                       // stacked overlays: [{text,color,x,y,bold}], max 10
  });

  let state = loadJSON(stateKey(), null) || loadJSON(STATE_KEY_LEGACY, defaultState());
  // backfill any new fields if an old state was saved
  state = Object.assign(defaultState(), state);
  if (!Array.isArray(state.colorSpans)) state.colorSpans = [];
  state.align = normalizeForgeAlign(state.align);
  let namePaintSel = { start: 0, end: 0 };
  let previewZoom = 1;
  let refreshForgePreview = () => {};

  function clampPreviewZoom(value) {
    const stepped = Math.round(Number(value) * 20) / 20;
    return Math.max(0.4, Math.min(2.5, stepped));
  }

  function previewNameFontPx(s) {
    const base = 18 * Math.min(Math.max(Number(s?.sizePct) || 100, 10), 300) / 100;
    return Math.max(4, base * previewZoom);
  }

  function setPreviewZoom(next) {
    previewZoom = clampPreviewZoom(next);
    refreshForgePreview();
  }

  // ---- Utilities ----
  // Tampermonkey storage survives a rocketgoal.io site-data wipe.
  // Origin localStorage does not. Read TM first, then localStorage, and
  // write both so a wipe still leaves presets / last name / history.


  // rawCode is the exact in-game TMP markup, while the structured fields are
  // used as soon as somebody touches a Forge control. A short name plus one
  // extra line is still name + title. Art (ASCII, dots, braille) stays in
  // the name so spaces and breaks are not crushed.


  // A hair taller than mspace so #/. grids are not squat.


  // Rocket Goal's font has no braille. Those cells become tofu boxes in-game.


  // 21.8 used = / ' as filter-safe stand-ins. Put + / : back for looks.
  // Strip leftover filter-break markers from older Apply attempts.


  // Transparent `.` — the game font has that glyph. NBSP became tofu boxes.
  const ART_WIDTH_PAD = "<#00000000>.";


  // Same column budget as artFitSizePct. Center/right keep <align=left>
  // (so the last row stays put) and shift the whole block with a closed
  // transparent indent the game font can actually draw.


  // Nameplates clip the last glyph row. A trailing <br> leaves an empty
  // line-box so the last visible row sits above the clip. Skip if one is
  // already there so Apply / pack does not keep stacking blanks.


  // Monospace + fit-to-nameplate. Plain art `<` `>` become fullwidth so TMP
  // does not eat the rest of a FIGlet / dot piece as tags.
  // Left-align so each row shares an edge the way the preview does. The
  // nameplate centers the whole block; it must not center each line.


  function alignFromRaw(raw) {
    const value = String(raw ?? "");
    const marked = value.match(/<rgnf-align=(left|center|right)>/i);
    if (marked) return marked[1].toLowerCase();
    const m = value.match(/<align\s*=\s*(left|center|right)>/i);
    if (m) return m[1].toLowerCase();
    return readAlignDefault() || "left";
  }

  function applyAlignToRaw(raw, align) {
    const side = normalizeForgeAlign(align);
    const value = String(raw ?? "");
    if (/<align\s*=\s*(left|center|right)>/i.test(value)) {
      return value.replace(/<align\s*=\s*(left|center|right)>/gi, `<align=${side}>`);
    }
    return `<align=${side}>${value}</align>`;
  }


  function alignDefaultKey() {
    return 'rgNameForge.alignDefault.v1.' + (_currentUserId || 'anon');
  }

  function readAlignDefault() {
    try {
      const v = loadJSON(alignDefaultKey(), null);
      if (v === 'left' || v === 'center' || v === 'right') return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeAlignDefault(align) {
    const side = normalizeForgeAlign(align);
    saveJSON(alignDefaultKey(), side);
  }

  function scoredDefaultKey() {
    return 'rgNameForge.scoredDefault.v1.' + (_currentUserId || 'anon');
  }

  function readScoredDefault() {
    try {
      const v = loadJSON(scoredDefaultKey(), null);
      if (v === 'hide' || v === 'tiny' || v === 'styled' || v === 'default') return v;
    } catch (e) { /* ignore */ }
    return null;
  }

  function writeScoredDefault(mode) {
    if (mode === 'hide' || mode === 'tiny' || mode === 'styled' || mode === 'default') {
      saveJSON(scoredDefaultKey(), mode);
    }
  }

  // Names without a Scored suffix keep the player's saved default (Hide, etc).


  function updatedRecentHistory(history, entry) {
    const entries = Array.isArray(history) ? history : [];
    return [
      entry,
      ...entries.filter(item => item && item.code !== entry.code),
    ].slice(0, 5);
  }

  function recordRecentApply(code, rawCode = code) {
    const editableName = editableFieldsFromRaw(rawCode).name;
    const plain = editableName
      .replace(/<sprite=\d+\s*>/gi, '')
      .trim()
      .slice(0, 24) || '(markup only)';
    const entry = {
      code: String(code),
      rawCode: String(rawCode),
      plain,
      ts: Date.now(),
    };
    const history = loadJSON(historyKey(), []);
    saveJSON(historyKey(), updatedRecentHistory(history, entry));
  }

  function syncEditableFieldsFromRaw(raw) {
    const fields = editableFieldsFromRaw(raw);
    state.name = fields.name;
    state.titleOn = fields.titleOn;
    state.titleText = fields.titleText;
  }

  function loadStateSnapshot(snapshot) {
    state = Object.assign(defaultState(), snapshot || {});
    namePaintSel = { start: 0, end: 0 };
    if (state.rawCode) setRawSnapshot(state.rawCode);
    else state.scoredMode = resolveScoredMode(state.scoredMode, readScoredDefault());
  }

  // Preset / recent / live-nickname loads must land in the sticky preview,
  // not just the NAME box or the raw textarea.
  function applyLoadedForgeName(source) {
    if (typeof source === "string") {
      setRawSnapshot(source);
      namePaintSel = { start: 0, end: 0 };
    } else {
      loadStateSnapshot(source);
    }
    if (_rgnfPanel) render(_rgnfPanel);
  }

  // Recognise the stacked-layer emission pattern (base name followed by
  // one or more <pos=…>…text…</color> blocks) so a reset / steal / paste
  // lands as an editable base name + populated Layers cards, not a raw
  // markup blob that concatenates every layer's text into one field.


  function setRawSnapshot(raw) {
    const cleaned = _stripTag(restorePreferredArtChars(raw));
    Object.assign(state, rawSnapshotFields(cleaned));
    const decoded = decodeLayeredRaw(cleaned);
    if (decoded) {
      state.rawCode = null;
      if (decoded.baseName) state.name = decoded.baseName;
      state.layers = decoded.layers;
    } else {
      state.layers = [];
    }
    namePaintSel = { start: 0, end: 0 };
    state.colorSpans = [];
    state.scoredMode = resolveScoredMode(state.scoredMode, readScoredDefault());
  }

  // Repair a persisted pre-fix state before the first render.
  if (state.rawCode) {
    setRawSnapshot(state.rawCode);
    saveJSON(stateKey(), state);
  }

  const FORGE_HISTORY_LIMIT = 30;
  let forgeUndoStack = [];
  let forgeRedoStack = [];
  let forgeHistoryRestoring = false;

  function forgeSnapshot() {
    return {
      state: JSON.parse(JSON.stringify(state)),
      namePaintSel: { ...namePaintSel },
      previewZoom,
    };
  }

  function forgeSnapshotKey(snapshot) {
    return JSON.stringify(snapshot);
  }

  let forgeHistoryCurrent = forgeSnapshot();
  let forgeHistoryCurrentKey = forgeSnapshotKey(forgeHistoryCurrent);

  function syncForgeHistoryButtons(panel = _rgnfPanel) {
    const undo = panel?.querySelector?.('[data-rgnf-undo]');
    const redo = panel?.querySelector?.('[data-rgnf-redo]');
    if (undo) undo.disabled = forgeUndoStack.length === 0;
    if (redo) redo.disabled = forgeRedoStack.length === 0;
  }

  function commitForgeHistory() {
    if (forgeHistoryRestoring) return false;
    const next = forgeSnapshot();
    const nextKey = forgeSnapshotKey(next);
    if (nextKey === forgeHistoryCurrentKey) return false;
    forgeUndoStack.push(forgeHistoryCurrent);
    if (forgeUndoStack.length > FORGE_HISTORY_LIMIT) forgeUndoStack.shift();
    forgeRedoStack = [];
    forgeHistoryCurrent = next;
    forgeHistoryCurrentKey = nextKey;
    syncForgeHistoryButtons();
    return true;
  }

  function restoreForgeHistorySnapshot(snapshot) {
    forgeHistoryRestoring = true;
    try {
      state = Object.assign(defaultState(), JSON.parse(JSON.stringify(snapshot.state || {})));
      if (!Array.isArray(state.colorSpans)) state.colorSpans = [];
      state.align = normalizeForgeAlign(state.align);
      namePaintSel = { start: 0, end: 0, ...(snapshot.namePaintSel || {}) };
      previewZoom = clampPreviewZoom(snapshot.previewZoom ?? 1);
      forgeHistoryCurrent = forgeSnapshot();
      forgeHistoryCurrentKey = forgeSnapshotKey(forgeHistoryCurrent);
      if (_rgnfPanel) render(_rgnfPanel);
    } finally {
      forgeHistoryRestoring = false;
    }
    syncForgeHistoryButtons();
  }

  function undoForge() {
    if (!forgeUndoStack.length) return;
    forgeRedoStack.push(forgeHistoryCurrent);
    restoreForgeHistorySnapshot(forgeUndoStack.pop());
  }

  function redoForge() {
    if (!forgeRedoStack.length) return;
    forgeUndoStack.push(forgeHistoryCurrent);
    restoreForgeHistorySnapshot(forgeRedoStack.pop());
  }

  function resetForgeHistory() {
    forgeUndoStack = [];
    forgeRedoStack = [];
    forgeHistoryCurrent = forgeSnapshot();
    forgeHistoryCurrentKey = forgeSnapshotKey(forgeHistoryCurrent);
    syncForgeHistoryButtons();
  }

  function rememberNamePaintSel(el) {
    if (!el) return;
    const start = Number(el.selectionStart) || 0;
    const end = Number(el.selectionEnd) || 0;
    if (end > start) namePaintSel = { start, end };
  }

  function namePaintRange() {
    const start = Math.min(namePaintSel.start, namePaintSel.end);
    const end = Math.max(namePaintSel.start, namePaintSel.end);
    const len = String(state.name || "").length;
    const a = Math.max(0, Math.min(len, start));
    const b = Math.max(0, Math.min(len, end));
    if (b <= a) return null;
    return { start: a, end: b };
  }

  function paintRangeGlyphCount(range) {
    const slice = String(state.name || "").slice(range.start, range.end);
    return [...slice].filter((ch) => ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r").length;
  }

  function paintBarLabel() {
    const range = namePaintRange();
    if (!range) {
      return "Drag on the preview to pick a slice. Then change Color. No highlight paints everything.";
    }
    const n = paintRangeGlyphCount(range);
    return `Painting ${n} character${n === 1 ? "" : "s"} in the preview. Color changes apply to this highlight only.`;
  }

  function paintPreviewRoot(node) {
    return node?.closest?.(".rgnf-preview-stack") || node;
  }

  function isPaintSpaceEl(el) {
    if (!el || el.dataset.forgeStart != null) return false;
    return /^\s+$/.test(el.textContent || "");
  }

  function paintPreviewSelection(root) {
    const scope = paintPreviewRoot(root);
    if (!scope) return;
    const range = namePaintRange();
    for (const el of scope.querySelectorAll("[data-forge-i]")) {
      const i = Number(el.dataset.forgeI);
      el.classList.toggle(
        "rgnf-paint-on",
        !!(range && i >= range.start && i < range.end && !isPaintSpaceEl(el)),
      );
    }
    for (const el of scope.querySelectorAll("[data-forge-start]")) {
      const a = Number(el.dataset.forgeStart);
      const b = Number(el.dataset.forgeEnd);
      el.classList.toggle("rgnf-paint-on", !!(range && a < range.end && b > range.start));
    }
    const label = scope.querySelector(".rgnf-paintbar-label");
    if (label) label.textContent = paintBarLabel();
  }

  function forgeHitRange(el) {
    const hit = el?.closest?.("[data-forge-i],[data-forge-start]");
    if (!hit) return null;
    if (hit.dataset.forgeI != null) {
      const i = Number(hit.dataset.forgeI);
      return { start: i, end: i + 1 };
    }
    return {
      start: Number(hit.dataset.forgeStart),
      end: Number(hit.dataset.forgeEnd),
    };
  }

  function makePaintBar() {
    const bar = document.createElement("div");
    bar.className = "rgnf-paintbar";
    const label = document.createElement("div");
    label.className = "rgnf-paintbar-label";
    label.textContent = paintBarLabel();
    const zoom = document.createElement("div");
    zoom.className = "rgnf-zoom";
    const zoomOut = document.createElement("button");
    zoomOut.className = "rgnf-chip";
    zoomOut.type = "button";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom preview out. Does not change the in-game name size.";
    zoomOut.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(previewZoom - 0.2);
    });
    const zoomLabel = document.createElement("button");
    zoomLabel.className = "rgnf-chip rgnf-zoom-label";
    zoomLabel.type = "button";
    zoomLabel.textContent = `${Math.round(previewZoom * 100)}%`;
    zoomLabel.title = "Reset preview zoom to 100%. Does not change the in-game name size.";
    zoomLabel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(1);
    });
    const zoomIn = document.createElement("button");
    zoomIn.className = "rgnf-chip";
    zoomIn.type = "button";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom preview in. Does not change the in-game name size.";
    zoomIn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPreviewZoom(previewZoom + 0.2);
    });
    zoom.appendChild(zoomOut);
    zoom.appendChild(zoomLabel);
    zoom.appendChild(zoomIn);
    const clear = document.createElement("button");
    clear.className = "rgnf-chip";
    clear.type = "button";
    clear.textContent = "Clear highlight";
    clear.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      namePaintSel = { start: 0, end: 0 };
      paintPreviewSelection(bar);
    });
    const actions = document.createElement("div");
    actions.className = "rgnf-paintbar-actions";
    actions.appendChild(zoom);
    actions.appendChild(clear);
    bar.appendChild(label);
    bar.appendChild(actions);
    return bar;
  }

  function wirePreviewPaint(root) {
    let dragging = false;
    let anchor = 0;
    root.addEventListener("pointerdown", (e) => {
      if (e.button != null && e.button !== 0) return;
      if (e.target?.closest?.(".rgnf-paintbar")) return;
      const hit = forgeHitRange(e.target);
      if (!hit) {
        namePaintSel = { start: 0, end: 0 };
        paintPreviewSelection(root);
        return;
      }
      e.preventDefault();
      dragging = true;
      anchor = hit.start;
      namePaintSel = { start: hit.start, end: hit.end };
      try { root.setPointerCapture(e.pointerId); } catch (err) {}
      paintPreviewSelection(root);
    });
    root.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const hit = forgeHitRange(under);
      if (!hit) return;
      namePaintSel = {
        start: Math.min(anchor, hit.start),
        end: Math.max(anchor + 1, hit.end),
      };
      paintPreviewSelection(root);
    });
    root.addEventListener("pointerup", () => { dragging = false; });
    root.addEventListener("pointercancel", () => { dragging = false; });
    root.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setPreviewZoom(previewZoom + (e.deltaY > 0 ? -0.2 : 0.2));
    }, { passive: false });
  }


  function snapshotNameColorStyle() {
    return cloneColorStyle({
      mode: state.colorMode,
      solid: state.solidColor,
      stops: state.stops,
      solidAlpha: state.solidAlpha ?? 255,
    });
  }


  // Packed TMP (`<#7A4E08>.`) has no colorSpans. Paint needs those spans,
  // so turn visible hex runs into slice marks aligned to state.name.


  function ensureStateColorSpans() {
    if ((state.colorSpans || []).length) return;
    const src = typeof state.rawCode === "string"
      ? state.rawCode
      : (_lastRawNickname ? _stripTag(String(_lastRawNickname)) : "");
    if (!src || !state.name) return;
    const spans = colorSpansFromRawName(src, state.name);
    if (spans.length) state.colorSpans = spans;
  }

  function absorbRawIntoPaintState() {
    if (typeof state.rawCode !== "string") return;
    const raw = state.rawCode;
    const nameBefore = state.name;
    const spansBefore = state.colorSpans;
    syncEditableFieldsFromRaw(raw);
    // Keep the name the highlight was measured against so slice indices
    // still point at the same glyphs after leaving raw TMP.
    if (nameBefore && String(state.name) !== String(nameBefore)) {
      const sameArt = editableTextFromRaw(nameBefore) === editableTextFromRaw(state.name);
      if (sameArt) state.name = nameBefore;
    }
    if (!(spansBefore || []).length) {
      state.colorSpans = colorSpansFromRawName(raw, state.name);
    } else {
      state.colorSpans = spansBefore;
    }
    state.rawCode = null;
  }

  function commitNameColor(mutator) {
    const range = namePaintRange();
    const before = snapshotNameColorStyle();
    absorbRawIntoPaintState();
    ensureStateColorSpans();
    mutator?.();
    const len = String(state.name || "").length;
    const start = Math.max(0, Math.min(len, range?.start ?? 0));
    const end = Math.max(0, Math.min(len, range?.end ?? 0));
    if (range && end > start) {
      state.colorSpans = applySliceColor(
        state.colorSpans,
        len,
        { start, end },
        before,
        snapshotNameColorStyle(),
      );
      state.rawCode = null;
      return;
    }
    // A lost highlight must not fall through to "paint everything".
    if (!range) state.colorSpans = [];
  }

  // multi-stop gradient sample at t in [0,1]


  // ------------------------------------------------------------------
  // TMP code generation
  // ------------------------------------------------------------------


  // chars, but <sprite=N> tags stay as single tokens


  // Compose either title or subtitle: color processing, style tags, optional
  // clan-tag prefix. Returns { line, visibleWidth } or null if nothing to render.
  function composeExtraLine(s, kind) {
    const isTitle = kind === 'title';
    const textKey = isTitle ? 'titleText' : 'subtitleText';
    const text = String(s[textKey] || '');
    if (!text.trim()) return null;
    const style = isTitle ? resolveTitleColorStyle(s) : resolveSubtitleColorStyle(s);
    const sizeKey = isTitle ? 'titleSizePct' : 'subtitleSizePct';
    const subKey = isTitle ? 'titleSub' : 'subtitleSub';
    const boldKey = isTitle ? 'titleBold' : 'subtitleBold';
    const italicKey = isTitle ? 'titleItalic' : 'subtitleItalic';
    const underlineKey = isTitle ? 'titleUnderline' : 'subtitleUnderline';
    const strikeKey = isTitle ? 'titleStrike' : 'subtitleStrike';
    const prefix = isTitle ? _prefix('title') : '';
    let t = text;
    if (style.mode === 'solid') {
      const aa = style.alpha < 255 ? alphaHex(style.alpha) : '';
      t = `<${style.solid.toUpperCase()}${aa}>` + t;
    } else if (style.mode === 'gradient') {
      t = colorizeText(t, 'gradient', style.solid, style.stops, s.skipSpaces);
      const aaG = style.alpha < 255 ? alphaHex(style.alpha) : '';
      if (aaG) t = t.replace(/<(#[0-9A-Fa-f]{6})>/g, `<$1${aaG}>`);
    }
    // getClanTagPrefix already trails a single space, so just concat.
    if (prefix) t = prefix + t;
    let open = '', close = '';
    if (s[sizeKey] !== 100) open += `<size=${s[sizeKey]}%>`;
    if (s[subKey]) { open += '<sub>'; close = '</sub>' + close; }
    if (s[boldKey]) { open += '<b>'; close = '</b>' + close; }
    if (s[italicKey]) { open += '<i>'; close = '</i>' + close; }
    if (s[underlineKey]) { open += '<u>'; close = '</u>' + close; }
    if (s[strikeKey]) { open += '<s>'; close = '</s>' + close; }
    const line = open + t + close;
    const prefixVisible = prefix ? visibleArtWidth(prefix) + 1 : 0;
    const visibleWidth = [...text].length + prefixVisible;
    return { line, visibleWidth };
  }

  // Render the actual prefix TMP into a hidden probe inside the Name Forge
  // panel so it inherits the same font/size, then measure and convert to em.
  function estimatePrefixEm(pfx) {
    const raw = String(pfx || '');
    if (!raw.trim()) return 0;
    try {
      const host = document.querySelector('.rgnf-panel') || document.body;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'visibility:hidden;position:absolute;left:-9999px;top:-9999px;display:inline-block;';
      const probe = renderRawTMP(raw);
      wrap.appendChild(probe);
      host.appendChild(wrap);
      const w = wrap.getBoundingClientRect().width;
      wrap.remove();
      if (!w) throw new Error('zero');
      return Math.round((w / 18) * 100) / 100;
    } catch {
      const plain = raw.replace(/<[^>]*>/g, '');
      return Math.round(plain.length * 0.55 * 100) / 100;
    }
  }

  function layersMarkup(s, opts = {}) {
    if (!Array.isArray(s.layers) || !s.layers.length) return '';
    // Ghost the clan tag inside each layer so <pos=0> becomes font-independent.
    // The invisible copy takes the same width TMP gives the real tag in
    // whichever scene the game happens to be rendering.
    const pfx = opts.noPrefixOffset ? '' : _prefix();
    const plainPfx = pfx ? pfx.replace(/<[^>]*>/g, '') : '';
    const ghostPrefix = plainPfx ? `<color=#00000000>${plainPfx}</color>` : '';
    let out = '';
    for (const L of s.layers) {
      const text = String(L?.text || '') || String(s.name || '');
      if (!text) continue;
      const x = Number(L.x) || 0;
      const y = Number(L.y) || 0;
      const size = Math.max(1, Math.min(1000, Number(L.sizePct) || 100));
      const c = String(L.color || '#ffffff').toUpperCase();
      let inner = text;
      if (y) inner = `<voffset=${y}em>${inner}</voffset>`;
      if (L.bold) inner = `<b>${inner}</b>`;
      if (size !== 100) inner = `<size=${size}%>${inner}</size>`;
      const spaceTag = x ? `<space=${x}em>` : '';
      out += `<pos=0>${ghostPrefix}${spaceTag}<color=${c}>${inner}</color>`;
    }
    return out;
  }

  // TMP <pos=0> is the start of the *current* line. Titles/subtitles live
  // after <br>, so appending layers at the end of the string paints them
  // over the extra line instead of the name.
  function spliceLayersOnFirstLine(body, s, opts) {
    const layers = layersMarkup(s, opts);
    if (!layers) return body;
    const match = /<br\s*\/?\s*>/i.exec(body);
    if (!match) return body + layers;
    return body.slice(0, match.index) + layers + body.slice(match.index);
  }

  function buildCode(s) {
    let open = '';
    let close = '';

    if (s.rotateDeg !== 0 && !s.waveOn) open += `<rotate=${s.rotateDeg}>`;
    if (s.sizePct !== 100) open += `<size=${s.sizePct}%>`;
    if (s.markOn) { open += `<mark=${s.markColor.toUpperCase()}${alphaHex(s.markAlpha)}>`; close = '</mark>' + close; }
    if (s.bold) { open += '<b>'; close = '</b>' + close; }
    if (s.italic) { open += '<i>'; close = '</i>' + close; }
    if (s.underline) { open += '<u>'; close = '</u>' + close; }
    if (s.strike) { open += '<s>'; close = '</s>' + close; }

    const artName = restorePreferredArtChars(brailleToAsciiArt(s.name));
    const nameCode = colorizeNamedArt(artName, s);
    const packedArt = isAsciiArtText(artName) || isAsciiArtText(s.name);
    const align = normalizeForgeAlign(s.align);
    if (!packedArt && align !== "left") {
      open += `<align=${align}>`;
      close = `</align>${close}`;
    }

    let code = open + nameCode + close;
    if (packedArt) code = shrinkHexTags(packAsciiArt(code, align));

    // Build title and subtitle blocks. Both share the same alignment as the
    // name/art (packAsciiArt already emits a trailing <br> so injecting the
    // title lines inside the mspace block keeps them left/center/right in
    // step with the art). Subtitle lives below title with its own gap.
    const composed = [];
    if (s.titleOn) {
      const t = composeExtraLine(s, 'title');
      if (t) composed.push({
        line: t.line, visibleWidth: t.visibleWidth,
        gap: Math.max(0, Math.min(10, Number(s.titleGapLines) || 0)),
      });
    }
    if (s.subtitleOn) {
      const st = composeExtraLine(s, 'subtitle');
      if (st) composed.push({
        line: st.line, visibleWidth: st.visibleWidth,
        gap: Math.max(0, Math.min(10, Number(s.subtitleGapLines) || 0)),
      });
    }

    if (composed.length) {
      if (packedArt) {
        // Extract the art's own visible width so we can center each extra
        // line horizontally within it. Compute artAlignIndent once so the
        // block-position matches the art's alignment.
        const artInnerMatch = code.match(/<mspace=[^>]*>([\s\S]*?)<\/mspace>/i);
        const artBody = artInnerMatch ? artInnerMatch[1] : '';
        const artWidth = artLineStats(artBody.replace(/<br\s*\/?\s*>/gi, '\n')).width;
        const artAlignIndent = artBlockIndentCols(artWidth, align);
        let payload = '';
        for (const c of composed) {
          const centerOffset = Math.max(0, Math.floor((artWidth - c.visibleWidth) / 2));
          const totalIndent = artAlignIndent + centerOffset;
          const padded = totalIndent > 0
            ? artIndentPad(totalIndent) + c.line
            : c.line;
          payload += '<br>'.repeat(c.gap) + padded + '<br>';
        }
        const anchor = '</mspace>';
        const idx = code.lastIndexOf(anchor);
        if (idx >= 0) code = code.slice(0, idx) + payload + code.slice(idx);
        else code += payload;
      } else {
        // Non-art path: outer <align> from the name wraps both title and
        // subtitle so they inherit the name's alignment automatically.
        for (const c of composed) code += '<br>' + '<br>'.repeat(c.gap) + c.line;
      }
    }

    code = spliceLayersOnFirstLine(code, s);

    // trailing tags style whatever "Scored!" text the game appends.
    code += scoredSuffix(s);

    return code;
  }

  function effectiveForgeCode(s) {
    if (typeof s.rawCode === 'string') {
      const art = isAsciiArtText(s.rawCode) || isAsciiArtText(s.name);
      const raw = art
        ? shrinkHexTags(packAsciiArt(s.rawCode, s.align))
        : preserveForgeNewlines(s.rawCode);
      return spliceLayersOnFirstLine(raw, s) + scoredSuffix(s);
    }
    return buildCode(s);
  }

  // ------------------------------------------------------------------
  // preview rendering (approximates TMP output)
  // ------------------------------------------------------------------
  function renderPreview(s) {
    const wrap = document.createElement('div');
    wrap.className = 'rgnf-preview-inner';

    let nameLine = document.createElement('div');
    nameLine.className = 'rgnf-preview-name';

    const styles = [];
    if (s.bold) styles.push('font-weight:700');
    if (s.italic) styles.push('font-style:italic');
    // per-letter decoration mirrors in-game TMP. applied per-span below via decoCSS.
    // Preview-only zoom. Style Size still drives in-game <size=...>.
    styles.push(`font-size:${previewNameFontPx(s)}px`);
    if (s.markOn) styles.push(`background:${s.markColor}${alphaHex(s.markAlpha)}`);
    nameLine.style.cssText = styles.join(';');

    // clan tag prefix: parse a small TMP subset into styled DOM so the preview
    // matches what actually gets sent
    const pfx = _prefix();
    if (pfx) {
      let inner = pfx;
      let outerBold = false, outerItalic = false;
      let m;
      while ((m = inner.match(/^<b>([\s\S]*)<\/b>\s*$/))) { outerBold = true; inner = m[1]; }
      while ((m = inner.match(/^<i>([\s\S]*)<\/i>\s*$/))) { outerItalic = true; inner = m[1]; }
      const pfxWrap = document.createElement('span');
      if (outerBold) pfxWrap.style.fontWeight = '700';
      if (outerItalic) pfxWrap.style.fontStyle = 'italic';
      pfxWrap.style.marginRight = '4px';
      let idx = 0, currentColor = null, currentRotate = 0;
      while (idx < inner.length) {
        const rest = inner.slice(idx);
        const colorTag = rest.match(/^<(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/);
        if (colorTag) { currentColor = colorTag[1]; idx += colorTag[0].length; continue; }
        const rotateTag = rest.match(/^<rotate=(-?\d+)>/);
        if (rotateTag) { currentRotate = Number(rotateTag[1]); idx += rotateTag[0].length; continue; }
        const ch = inner[idx];
        const chSpan = document.createElement('span');
        chSpan.textContent = ch;
        if (currentColor) chSpan.style.color = currentColor;
        if (currentRotate) {
          chSpan.style.display = 'inline-block';
          chSpan.style.transform = 'rotate(' + currentRotate + 'deg)';
        }
        pfxWrap.appendChild(chSpan);
        idx++;
      }
      nameLine.appendChild(pfxWrap);
    }


    const decoParts = [];
    if (s.underline) decoParts.push('underline');
    if (s.strike) decoParts.push('line-through');
    const decoCSS = decoParts.length ? decoParts.join(' ') : '';

    const previewName = artPreviewText(s.name);
    const ascii = isAsciiArtText(previewName) || isAsciiArtText(s.name);
    // Match what the packer emits so this looks like the real nameplate.
    const artGlyph = ascii ? artUniformGlyph(previewName) : null;
    const artStats = artGlyph ? artLineStats(previewName) : null;
    const artMetrics = artGlyph ? artDotPackMetrics(artGlyph, artStats.width, artStats.height) : null;
    const artPx = previewNameFontPx(s) * (artMetrics ? artMetrics.size / 100 : 1);
    const applyAsciiStyle = (el) => {
      el.style.whiteSpace = 'pre';
      el.style.textAlign = 'left';
      if (artMetrics) {
        const ink = glyphInk(artGlyph, ART_PREVIEW_FONT);
        const cell = artCellStyle(
          artGlyph,
          (ink.adv + artMetrics.cspace) * artPx,
          artMetrics.lineHeight * artPx
        );
        el.style.fontFamily = ART_PREVIEW_FONT;
        el.style.fontSize = cell.px.toFixed(3) + 'px';
        el.style.lineHeight = cell.line.toFixed(3) + 'px';
        el.style.letterSpacing = cell.letter.toFixed(3) + 'px';
      } else {
        el.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
        el.style.lineHeight = '1.1';
      }
    };
    if (ascii) {
      wrap.classList.add('rgnf-ascii');
      applyAsciiStyle(nameLine);
    } else {
      nameLine.style.textAlign = normalizeForgeAlign(s.align);
    }
    const previewFallback = {
      mode: s.colorMode,
      solid: s.solidColor,
      stops: s.stops,
      solidAlpha: s.solidAlpha ?? 255,
    };
    if (s === state) ensureStateColorSpans();
    const previewSpans = String(s.name || "").length === previewName.length
      ? s.colorSpans
      : [];
    const previewRuns = splitByColorSpans(previewName, previewSpans, previewFallback);
    let i = 0;
    let srcIndex = 0;
    const startNameLine = () => {
      const line = document.createElement('div');
      line.className = 'rgnf-preview-name';
      line.style.cssText = (line.style.cssText ? line.style.cssText + ';' : '') + styles.join(';');
      if (ascii) applyAsciiStyle(line);
      return line;
    };
    for (const run of previewRuns) {
      const tokens = tokenize(run.text);
      const paintable = tokens.filter(t => t.type === 'char' && !(s.skipSpaces && t.value === ' '));
      const n = paintable.length;
      let runI = 0;
      for (const tok of tokens) {
        if (tok.type === 'br') {
          wrap.appendChild(nameLine);
          nameLine = startNameLine();
          srcIndex += 1;
          continue;
        }
        const span = document.createElement('span');
        if (tok.type === 'sprite') {
          const num = Number(tok.value.match(/\d+/)[0]);
          span.textContent = spriteEmoji(num);
          span.title = tok.value;
          span.dataset.forgeStart = String(srcIndex);
          span.dataset.forgeEnd = String(srcIndex + tok.value.length);
          srcIndex += tok.value.length;
        } else {
          span.dataset.forgeI = String(srcIndex);
          srcIndex += tok.value.length;
          span.textContent = tok.value;
          if (tok.value !== ' ' || !s.skipSpaces) {
            if (run.style.mode === 'solid') {
              const aa = (run.style.solidAlpha ?? 255) < 255 ? alphaHex(run.style.solidAlpha) : '';
              span.style.color = run.style.solid + aa;
            }
            else if (run.style.mode === 'gradient' && n > 0 && tok.value !== ' ') {
              const t = n === 1 ? 0 : runI / (n - 1);
              span.style.color = gradientAt(run.style.stops, t);
            }
          }
          if (decoCSS && tok.value !== ' ') {
            span.style.textDecorationLine = decoCSS;
            span.style.textDecorationColor = span.style.color || 'currentColor';
            span.style.textDecorationThickness = 'from-font';
          }
          if (tok.value !== ' ') {
            if (s.waveOn) {
              span.style.display = 'inline-block';
              span.style.transform = `rotate(${(i % 2 === 0 ? -1 : 1) * s.waveAmp}deg)`;
            }
            runI++;
            i++;
          }
        }
        if (!s.waveOn && s.rotateDeg !== 0) {
          span.style.display = 'inline-block';
          span.style.transform = `rotate(${s.rotateDeg}deg)`;
        }
        nameLine.appendChild(span);
      }
    }
    wrap.appendChild(nameLine);

    if (s.titleOn && s.titleText.trim()) {
      const titleLine = document.createElement('div');
      titleLine.className = 'rgnf-preview-title';
      titleLine.style.fontSize = `${Math.max(5, 18 * s.titleSizePct / 100 * previewZoom)}px`;
      titleLine.style.textAlign = normalizeForgeAlign(s.align);
      titleLine.style.width = '100%';
      const previewGap = Math.max(0, Math.min(10, Number(s.titleGapLines) || 0));
      if (previewGap > 0) titleLine.style.marginTop = `${previewGap * 1.1}em`;
      if (s.titleSub) titleLine.style.verticalAlign = 'sub';
      if (s.titleBold) titleLine.style.fontWeight = '700';
      if (s.titleItalic) titleLine.style.fontStyle = 'italic';
      const titleDeco = [];
      if (s.titleUnderline) titleDeco.push('underline');
      if (s.titleStrike) titleDeco.push('line-through');
      if (titleDeco.length) titleLine.style.textDecorationLine = titleDeco.join(' ');
      const titleColor = resolveTitleColorStyle(s);
      if (titleColor.mode === 'solid') {
        titleLine.textContent = s.titleText;
        // 8-digit hex: append alpha byte when < 255
        const aa = titleColor.alpha < 255 ? alphaHex(titleColor.alpha) : '';
        titleLine.style.color = titleColor.solid + aa;
      } else if (titleColor.mode === 'gradient') {
        const chars = [...s.titleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = titleColor.alpha < 255 ? alphaHex(titleColor.alpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(titleColor.stops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          titleLine.appendChild(sp);
        }
      } else {
        titleLine.textContent = s.titleText;
      }
      wrap.appendChild(titleLine);
    }

    if (s.subtitleOn && s.subtitleText.trim()) {
      const subLine = document.createElement('div');
      subLine.className = 'rgnf-preview-title';
      subLine.style.fontSize = `${Math.max(5, 18 * s.subtitleSizePct / 100 * previewZoom)}px`;
      subLine.style.textAlign = normalizeForgeAlign(s.align);
      subLine.style.width = '100%';
      const previewSubGap = Math.max(0, Math.min(10, Number(s.subtitleGapLines) || 0));
      if (previewSubGap > 0) subLine.style.marginTop = `${previewSubGap * 1.1}em`;
      if (s.subtitleSub) subLine.style.verticalAlign = 'sub';
      if (s.subtitleBold) subLine.style.fontWeight = '700';
      if (s.subtitleItalic) subLine.style.fontStyle = 'italic';
      const subDeco = [];
      if (s.subtitleUnderline) subDeco.push('underline');
      if (s.subtitleStrike) subDeco.push('line-through');
      if (subDeco.length) subLine.style.textDecorationLine = subDeco.join(' ');
      const subColor = resolveSubtitleColorStyle(s);
      if (subColor.mode === 'solid') {
        subLine.textContent = s.subtitleText;
        const aa = subColor.alpha < 255 ? alphaHex(subColor.alpha) : '';
        subLine.style.color = subColor.solid + aa;
      } else if (subColor.mode === 'gradient') {
        const chars = [...s.subtitleText];
        const paint = chars.filter(c => c !== ' ').length;
        const aa = subColor.alpha < 255 ? alphaHex(subColor.alpha) : '';
        let j = 0;
        for (const c of chars) {
          const sp = document.createElement('span');
          sp.textContent = c;
          if (c !== ' ') {
            sp.style.color = gradientAt(subColor.stops, paint === 1 ? 0 : j / (paint - 1)) + aa;
            j++;
          }
          subLine.appendChild(sp);
        }
      } else {
        subLine.textContent = s.subtitleText;
      }
      wrap.appendChild(subLine);
    }

    // fake "Scored!" suffix
    const scored = document.createElement('span');
    scored.className = 'rgnf-preview-scored';
    scored.textContent = ' Scored!';
    switch (s.scoredMode) {
      case 'hide': scored.style.display = 'none'; break;
      case 'tiny': scored.style.fontSize = `${Math.max(4, 6 * previewZoom)}px`; scored.style.verticalAlign = 'sub'; break;
      case 'styled':
        scored.style.color = s.scoredColor;
        scored.style.fontSize = `${Math.max(4, 14 * s.scoredSizePct / 100 * previewZoom)}px`;
        break;
      default: scored.style.color = '#cbd5e1'; break;
    }
    nameLine.appendChild(scored);

    const stack = document.createElement('div');
    stack.className = 'rgnf-preview-stack';
    stack.appendChild(makePaintBar());
    stack.appendChild(wrap);
    wirePreviewPaint(wrap);
    paintPreviewSelection(stack);
    return stack;
  }

  // ------------------------------------------------------------------
  // auth: fresh Firebase ID token. SDK first, IndexedDB fallback + refresh.
  // ------------------------------------------------------------------
  async function getIdToken() {
    // 1) Firebase SDK exposed on the page
    try {
      if (window.firebase && window.firebase.auth) {
        const u = window.firebase.auth().currentUser;
        if (u) return await u.getIdToken();
      }
    } catch (e) { /* fall through */ }

    // 2) IndexedDB cache written by the Firebase JS SDK
    const rec = await readAuthFromIDB();
    if (!rec) throw new Error('No Firebase auth found. Are you logged in on this tab?');

    const { apiKey, sts } = rec;
    const expMs = Number(sts.expirationTime || 0);
    if (Date.now() < expMs - 60_000 && sts.accessToken) return sts.accessToken;

    // 3) Token expired, refresh it
    const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sts.refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed (${resp.status})`);
    const j = await resp.json();
    if (!j.access_token) throw new Error('Token refresh returned no access_token');
    return j.access_token;
  }

  function readAuthFromIDB() {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open('firebaseLocalStorageDb'); } catch (e) { return resolve(null); }
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('firebaseLocalStorage', 'readonly');
          const store = tx.objectStore('firebaseLocalStorage');
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = all.result || [];
            const row = rows.find(r => typeof r.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:'));
            if (!row || !row.value || !row.value.stsTokenManager) return resolve(null);
            const apiKey = row.fbase_key.split(':')[2];
            resolve({ apiKey, sts: row.value.stsTokenManager });
          };
          all.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    });
  }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  async function applyNickname(code) {
    const token = await getIdToken();
    // guard: IndexedDB fallback can serve a stale token in multi-account
    // browsers, which would apply to the WRONG account. fail loudly instead.
    let mismatch = null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (_currentUserId && payload.user_id && payload.user_id !== _currentUserId) {
        mismatch = payload.user_id;
      }
    } catch (e) { /* undecodable token: proceed, the server will judge it */ }
    if (mismatch) {
      throw new Error('Auth token belongs to a different account (' + mismatch.slice(0, 8) + '…). Refresh the page and try again.');
    }
    code = sanitizeNicknameColors(code);
    // Too big and the client dies mid match, so stop it here.
    const codeBytes = new TextEncoder().encode(code).length;
    if (codeBytes > NICKNAME_BYTE_LIMIT) {
      throw new Error(
        `Nickname is ${codeBytes.toLocaleString()} bytes, over the ${NICKNAME_BYTE_LIMIT.toLocaleString()} `
        + `byte Quantum frame limit. It would crash the game client. Drop the column count or the color count.`
      );
    }
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Bearer ' + token,
      },
      body: new URLSearchParams({ nickname: code }),
    });
    const body = await res.text();
    // log every apply's server verdict, helps debug "why didn't my name change"
    console.log('[RG HUD] nickname apply ->', res.status, body.trim().slice(0, 60));
    return { ok: res.ok && body.trim() === 'true', status: res.status, body };
  }

  // The nickname endpoint can return true before the game finishes its own
  // SetNickname boot echo. Keep one receipt for every Name Forge write and
  // re-apply once after the echo window. A newer click cancels the old retry.
  let _nicknameApplyRevision = 0;
  const NICKNAME_SETTLE_RETRY_MS = 4000;
  async function applyNicknameStable(code, body = code) {
    const revision = ++_nicknameApplyRevision;
    const receipt = { code, body, ts: Date.now(), revision };
    _stealVerified = false;
    saveJSON(pendingStealKey(), receipt);

    let first;
    try {
      first = await applyNickname(code);
    } catch (err) {
      const current = loadJSON(pendingStealKey(), null);
      if (current?.revision === revision) saveJSON(pendingStealKey(), null);
      throw err;
    }
    if (!first.ok) {
      const current = loadJSON(pendingStealKey(), null);
      if (current?.revision === revision) saveJSON(pendingStealKey(), null);
      return first;
    }

    setTimeout(async () => {
      if (_nicknameApplyRevision !== revision) return;
      const current = loadJSON(pendingStealKey(), null);
      if (!current || current.revision !== revision || current.code !== code) return;
      try {
        const retry = await applyNickname(code);
        dbg(`nickname settle retry -> ${retry.ok ? "OK" : "FAILED (" + retry.status + ")"}`);
      } catch (err) {
        dbg("nickname settle retry error: " + getErrMsg(err));
      }
    }, NICKNAME_SETTLE_RETRY_MS);

    return first;
  }

  // once per page load: check the last name apply survived the game's boot echo.
  // mismatch -> re-apply once after 4s so our write lands last. TTL-guarded.
  let _stealVerified = false;
  function verifyPendingSteal(rawNickname) {
    if (_stealVerified) return;
    _stealVerified = true;
    const fdbg = (m) => { try { dbg(m); } catch (e) { console.log('[RG HUD] ' + m); } };
    const pending = loadJSON(pendingStealKey(), null);
    if (!pending || !pending.code) return;
    if (Date.now() - (pending.ts || 0) > PENDING_STEAL_TTL_MS) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending steal receipt expired — dropped');
      return;
    }
    const nick = String(rawNickname || '');
    // caller has stripped clan-tag prefix from nick, pending.* wasn't
    // stripped. compare both forms or same-clan steals ping-pong forever.
    let stripFn;
    try { stripFn = stripLeadingClanTagMarkup; } catch (e) { stripFn = s => s; }
    const strip = s => { try { return stripFn(String(s || "")); } catch (e) { return String(s || ""); } };
    const nickStripped = strip(nick);
    const bodyStripped = strip(pending.body);
    const codeStripped = strip(pending.code);
    if (nick && (
        nick === String(pending.body || '') ||
        nick === String(pending.code || '') ||
        (nickStripped && (nickStripped === bodyStripped || nickStripped === codeStripped))
    )) {
      saveJSON(pendingStealKey(), null);
      fdbg('pending name apply verified — nickname stuck server-side');
      return;
    }
    if (pending.revision && pending.revision === _nicknameApplyRevision) {
      fdbg('pending name apply is waiting for its scheduled settle retry');
      return;
    }
    fdbg('pending name apply MISMATCH — boot echo overwrote it, re-applying in 4s');
    setTimeout(async () => {
      try {
        const r = await applyNickname(pending.code);
        fdbg(`pending name re-apply -> ${r.ok ? 'OK — refresh once more to see it in-game' : 'FAILED (' + r.status + ')'}`);
        if (r.ok) saveJSON(pendingStealKey(), null);
      } catch (err) {
        fdbg('pending name re-apply error: ' + getErrMsg(err));
      }
    }, 4000);
  }

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------
  const css = `
    :root {
      --rgnf-bg: #0b0e1a;
      --rgnf-panel: #10142a;
      --rgnf-panel-2: #171c38;
      --rgnf-line: #23294d;
      --rgnf-text: #e2e8f0;
      --rgnf-muted: #8b93b8;
      --rgnf-code: #9fb3ff;
      --rgnf-accent: #22d3ee;
      --rgnf-accent-2: #e94fff;
    }
    .rgnf-fab {
      position: fixed; bottom: 90px; right: 18px; z-index: 999999;
      width: 52px; height: 52px; border-radius: 14px; border: 1px solid var(--rgnf-line);
      background: linear-gradient(135deg, var(--rgnf-panel) 0%, var(--rgnf-panel-2) 100%);
      color: var(--rgnf-accent); font-size: 24px; cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,.5), 0 0 0 1px rgba(34,211,238,.15) inset;
      transition: transform .15s ease;
      display: flex; align-items: center; justify-content: center;
      touch-action: none; user-select: none;
    }
    .rgnf-fab:hover { transform: translateY(-2px) scale(1.04); }
    .rgnf-fab:active { cursor: grabbing; }
    .rgnf-panel {
      /* fly-out positioning + 360px is in .rgnf-open, base fills container */
      color: var(--rgnf-text);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      display: none;
      width: 100%; box-sizing: border-box;
    }
    .rgnf-panel.rgnf-open {
      position: fixed; bottom: 82px; right: 18px; z-index: 999999;
      width: 360px; max-height: 78vh; overflow-y: auto;
      background: var(--rgnf-bg);
      border: 1px solid var(--rgnf-line); border-radius: 16px;
      box-shadow: 0 16px 48px rgba(0,0,0,.6);
      display: block;
    }
    .rgnf-head {
      position: sticky; top: 0; z-index: 2;
      padding: 14px 16px; cursor: grab;
      background: linear-gradient(90deg, rgba(34,211,238,.12), rgba(233,79,255,.12)), var(--rgnf-bg);
      border-bottom: 1px solid var(--rgnf-line);
      display: flex; align-items: center; justify-content: space-between;
    }
    .rgnf-head b {
      font-size: 14px; letter-spacing: .08em; text-transform: uppercase;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .rgnf-x { background: none; border: none; color: var(--rgnf-muted); font-size: 16px; cursor: pointer; }
    .rgnf-sec { padding: 12px 16px; border-bottom: 1px solid var(--rgnf-line); }
    .rgnf-sec h4 {
      margin: 0 0 8px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
      color: var(--rgnf-text); font-weight: 700;
    }
    .rgnf-hint { margin: 0 0 8px; font-size: 12px; line-height: 1.4; color: var(--rgnf-muted); }
    .rgnf-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
    .rgnf-row label { color: var(--rgnf-muted); min-width: 74px; }
    .rgnf-panel input[type=text], .rgnf-panel select {
      flex: 1; min-width: 0; background: var(--rgnf-panel); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 7px 9px; font-size: 13px;
    }
    .rgnf-panel input[type=color] {
      width: 40px; height: 32px; padding: 0; border: 1px solid var(--rgnf-line);
      border-radius: 6px; background: none; cursor: pointer;
    }
    .rgnf-panel input[type=range] { flex: 1; accent-color: var(--rgnf-accent); }
    .rgnf-val { min-width: 44px; text-align: right; color: var(--rgnf-accent); font-variant-numeric: tabular-nums; }
    .rgnf-chip {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line); color: var(--rgnf-text);
      border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px;
    }
    .rgnf-panel button:focus-visible,
    .rgnf-panel input:focus-visible,
    .rgnf-panel textarea:focus-visible,
    .rgnf-panel select:focus-visible,
    .rgnf-fab:focus-visible {
      outline: 2px solid var(--rgnf-accent);
      outline-offset: 2px;
    }
    .rgnf-chip.rgnf-on { border-color: var(--rgnf-accent); color: var(--rgnf-accent); box-shadow: 0 0 0 1px rgba(34,211,238,.25) inset; }
    .rgnf-stops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .rgnf-stop { position: relative; }
    .rgnf-stop button {
      position: absolute; top: -7px; right: -7px; width: 15px; height: 15px; border-radius: 50%;
      border: none; background: #ef4444; color: #fff; font-size: 9px; line-height: 1; cursor: pointer;
    }
    .rgnf-gradbar { height: 10px; border-radius: 6px; margin-top: 6px; border: 1px solid var(--rgnf-line); }
    .rgnf-sprites { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
    .rgnf-sprites button {
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 6px; padding: 3px 0; cursor: pointer; font-size: 15px; line-height: 1.2;
    }
    .rgnf-sprites button:hover { border-color: var(--rgnf-accent); transform: scale(1.1); }
    .rgnf-sprites button.rgnf-sprite-broken { opacity: .45; filter: grayscale(.6); }
    .rgnf-preview {
      background: radial-gradient(120% 140% at 50% 0%, #101a3a 0%, #070a16 70%);
      border: 1px solid var(--rgnf-line); border-radius: 12px; padding: 14px; text-align: center;
      min-height: 56px; max-height: min(42vh, 320px); overflow: auto;
      display: flex; align-items: flex-start; justify-content: center;
      /* sticky at top of scrollable body; must be a direct panel child */
      position: sticky; top: 0; z-index: 5;
      box-shadow: 0 6px 8px -6px rgba(0,0,0,0.6);
      margin-bottom: 8px;
    }
    .rgnf-preview.rgnf-align-left { justify-content: flex-start; }
    .rgnf-preview.rgnf-align-center { justify-content: center; }
    .rgnf-preview.rgnf-align-right { justify-content: flex-end; }
    .rgnf-preview-stack { width: 100%; }
    .rgnf-preview-inner { user-select: none; cursor: text; }
    .rgnf-paintbar {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px; text-align: left;
      position: sticky; top: 0; z-index: 2;
      background: linear-gradient(180deg, #101a3a 70%, transparent);
      padding-bottom: 4px;
    }
    .rgnf-paintbar-label { color: var(--rgnf-muted); font-size: 11px; line-height: 1.35; flex: 1; }
    .rgnf-paintbar-actions {
      display: flex; align-items: center; justify-content: flex-end;
      gap: 6px; flex-wrap: wrap; width: 100%; min-width: 0;
    }
    .rgnf-zoom { display: flex; align-items: center; gap: 4px; }
    .rgnf-zoom-label { min-width: 46px; text-align: center; }
    .rgnf-paint-on {
      background: color-mix(in srgb, #22d3ee 32%, transparent);
      border-radius: 3px;
      box-shadow: inset 0 0 0 1px #22d3eecc;
    }
    .rgnf-preview-name { font-size: 18px; font-weight: 400; word-break: break-word; }
    .rgnf-preview-inner.rgnf-ascii { text-align: left; width: max-content; min-width: max-content; }
    .rgnf-preview-inner.rgnf-ascii > div,
    .rgnf-preview-inner.rgnf-ascii .rgnf-preview-name {
      white-space: pre; word-break: normal; font-family: ui-monospace, Menlo, Consolas, monospace;
    }
    .rgnf-name-input {
      width: 100%; min-height: 42px; max-height: 220px; resize: vertical; box-sizing: border-box;
      overflow: auto;
      font: 12px/1.3 ui-monospace, Menlo, Consolas, monospace; white-space: pre; tab-size: 4;
      background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; color: inherit;
    }
    .rgnf-preview-title { margin-top: 2px; }
    .rgnf-code {
      margin-top: 8px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 8px; padding: 8px; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
      color: var(--rgnf-code); word-break: break-all; max-height: 180px; overflow-y: auto; user-select: all;
    }
    .rgnf-meta { display: flex; justify-content: space-between; color: var(--rgnf-muted); font-size: 11px; margin-top: 4px; }
    .rgnf-btn {
      border: none; border-radius: 10px; padding: 9px 12px; font-weight: 700; cursor: pointer; font-size: 13px;
      min-width: 0;
    }
    .rgnf-btn-apply {
      flex: 1; color: #06121a;
      background: linear-gradient(90deg, var(--rgnf-accent), var(--rgnf-accent-2));
      transition: filter .12s ease, transform .12s ease;
    }
    .rgnf-btn-apply:hover { filter: brightness(1.12) drop-shadow(0 0 6px rgba(34,211,238,.4)); transform: translateY(-1px); }
    .rgnf-btn-apply:active { transform: translateY(0); filter: brightness(.95); }
    .rgnf-btn-apply:disabled { opacity: .6; cursor: not-allowed; transform: none; filter: none; }
    .rgnf-btn-ghost { background: var(--rgnf-panel); color: var(--rgnf-text); border: 1px solid var(--rgnf-line); flex-shrink: 0; }
    .rgnf-btn-ghost:hover { border-color: var(--rgnf-accent); color: var(--rgnf-accent); }
    /* wrap on narrow embeds so buttons stay on-screen */
    .rgnf-row { flex-wrap: wrap; }
    .rgnf-status { margin-top: 8px; font-size: 12px; min-height: 16px; }
    .rgnf-status.ok { color: #34d399; }
    .rgnf-status.err { color: #f87171; }
    .rgnf-presets { display: flex; flex-direction: column; gap: 6px; }
    .rgnf-preset { display: flex; align-items: center; gap: 6px; }
    .rgnf-preset > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rgnf-picker-backdrop {
      position: absolute; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
      background: rgba(4,6,12,.6); border-radius: 12px;
    }
    .rgnf-picker {
      width: 82%; max-width: 320px; background: var(--rgnf-panel); border: 1px solid var(--rgnf-line);
      border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .rgnf-picker-title { font-weight: 700; font-size: 13px; color: var(--rgnf-text); }
    .rgnf-picker-label { font-size: 11px; color: var(--rgnf-muted); margin-top: 2px; }
    .rgnf-picker-select, .rgnf-picker-input {
      width: 100%; box-sizing: border-box; background: var(--rgnf-bg); color: var(--rgnf-text);
      border: 1px solid var(--rgnf-line); border-radius: 8px; padding: 8px; font-size: 13px;
    }
    @media (max-width: 420px) {
      .rgnf-preset { flex-wrap: wrap; }
      .rgnf-preset > span { flex-basis: 100%; }
      .rgnf-layer-head { flex-wrap: wrap; }
    }
  `;

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  // inline styled overlay picker, not a native prompt. onPick gets
  // ({ name, folder }); name is '' when nameField is false.
  function openFolderPicker(panel, { title, existing, current, onPick, nameField = false, nameDefault = '', nameOnly = false }) {
    const backdrop = el('div', { class: 'rgnf-picker-backdrop' });
    const box = el('div', { class: 'rgnf-picker' });
    box.appendChild(el('div', { class: 'rgnf-picker-title', text: title }));

    // name field (Save / promote / rename)
    let nameInput = null;
    if (nameField) {
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Name' }));
      nameInput = el('input', { type: 'text', class: 'rgnf-picker-input', value: nameDefault, placeholder: nameOnly ? 'Folder name' : 'Preset name' });
      box.appendChild(nameInput);
      if (!nameOnly) box.appendChild(el('div', { class: 'rgnf-picker-label', text: 'Folder' }));
    }

    // hidden entirely for name-only calls
    const sel = el('select', { class: 'rgnf-picker-select' });
    sel.appendChild(el('option', { value: '', text: '📂 Ungrouped' }));
    existing.filter(f => f && f !== 'Ungrouped').forEach(f => {
      const o = el('option', { value: f, text: '📁 ' + f });
      if (f === current) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.appendChild(el('option', { value: '__new__', text: '➕ New folder…' }));
    if (!nameOnly) box.appendChild(sel);

    // shown when "New folder…" is picked
    const newWrap = el('div', { class: 'rgnf-row' });
    newWrap.style.display = 'none';
    const newInput = el('input', { type: 'text', placeholder: 'New folder name', class: 'rgnf-picker-input' });
    newWrap.appendChild(newInput);
    box.appendChild(newWrap);
    sel.addEventListener('change', () => {
      const isNew = sel.value === '__new__';
      newWrap.style.display = isNew ? 'flex' : 'none';
      if (isNew) newInput.focus();
    });

    const btnRow = el('div', { class: 'rgnf-row' });
    const close = () => backdrop.remove();
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip', text: 'Cancel', onclick: close,
    }));
    btnRow.appendChild(el('button', {
      class: 'rgnf-chip rgnf-on', text: 'OK',
      onclick: () => {
        const folder = sel.value === '__new__' ? newInput.value.trim() : sel.value;
        const name = nameInput ? nameInput.value.trim() : '';
        if (nameField && !name) { nameInput.focus(); return; }
        close();
        onPick(nameField ? { name, folder } : folder);
        return;
      },
    }));
    box.appendChild(btnRow);

    backdrop.appendChild(box);
    (panel || document.body).appendChild(backdrop);
    (nameInput || sel).focus();
  }

  function buildUI() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el('button', { class: 'rgnf-fab', title: 'Name Forge (Alt+N) — drag to move', text: '🎨' });
    const panel = el('div', { class: 'rgnf-panel' });
    const commitAfterEvent = () => queueMicrotask(() => commitForgeHistory());
    panel.addEventListener('input', commitAfterEvent);
    panel.addEventListener('click', commitAfterEvent);
    panel.addEventListener('pointerup', commitAfterEvent);


    const savedPos = loadJSON(FABPOS_KEY, null);
    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyFabPos(fab, savedPos.left, savedPos.top);
    }

    // keep the FAB on-screen when the window shrinks
    window.addEventListener('resize', () => clampFab(fab));

    makeFabDraggable(fab, panel);

    fab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(fab, panel); }
    });

    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.code === 'KeyN' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // when embedded in ATLAS, route the shortcut through the HUD tab
        // (opening the flyout would yank it into a fixed overlay)
        if (_mountedIn) {
          const hudEl = document.getElementById('rgHUD');
          const bodyEl = document.getElementById('rgBody');
          const forgeView = document.getElementById('rgForgeView');
          if (hudEl) setAutoVisible(true);
          if (bodyEl) bodyEl.style.display = 'block';
          const minimize = document.getElementById('rgMinimize');
          if (minimize) {
            minimize.textContent = '–';
            minimize.title = 'Minimize';
          }
          if (!forgeView || forgeView.style.display === 'none') {
            document.getElementById('rgForgeBtn')?.click();
          }
          return;
        }
        togglePanel(fab, panel);
      }
    });
    document.body.appendChild(fab);
    document.body.appendChild(panel);
_rgnfFab = fab; _rgnfPanel = panel;
    fab.style.display = 'none'; // header 🎨 button replaces the floating bubble
    panel.style.display = 'none';
    clampFab(fab);

    render(panel);
  }

  // flips sides/vertical as needed to stay on-screen
  function positionPanel(fab, panel) {
    const f = fab.getBoundingClientRect();
    const gap = 12;
    const pw = 360;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    // left-align with FAB, flip if it would overflow the right edge
    let left = f.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, f.right - pw);
    // open upward, fall back to downward if there's no room
    const ph = Math.min(window.innerHeight * 0.78, 640);
    let top = f.top - gap - ph;
    if (top < 8) top = Math.min(window.innerHeight - ph - 8, f.bottom + gap);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function togglePanel(fab, panel) {
    const willOpen = !panel.classList.contains('rgnf-open');
    if (willOpen) positionPanel(fab, panel);
    panel.classList.toggle('rgnf-open');
  }

  function applyFabPos(fab, left, top) {
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
  }

  function clampFab(fab) {
    const r = fab.getBoundingClientRect();
    // still anchored via right/bottom (never moved) -> leave alone
    if (fab.style.left === '' || fab.style.left === 'auto') return;
    const maxLeft = window.innerWidth - r.width - 6;
    const maxTop = window.innerHeight - r.height - 6;
    const left = Math.max(6, Math.min(r.left, maxLeft));
    const top = Math.max(6, Math.min(r.top, maxTop));
    applyFabPos(fab, left, top);
  }

  function makeFabDraggable(fab, panel) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    const DRAG_THRESHOLD = 4;

    const onDown = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      const rect = fab.getBoundingClientRect();
      sx = pt.clientX; sy = pt.clientY; ox = rect.left; oy = rect.top;
      applyFabPos(fab, ox, oy); // switch from right/bottom anchoring to left/top
      fab.style.cursor = 'grabbing';
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - sx, dy = pt.clientY - sy;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      let left = ox + dx, top = oy + dy;
      const r = fab.getBoundingClientRect();
      left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
      top = Math.max(6, Math.min(top, window.innerHeight - r.height - 6));
      applyFabPos(fab, left, top);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      fab.style.cursor = 'pointer';
      const r = fab.getBoundingClientRect();
      if (moved) {
        saveJSON(FABPOS_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
        // if the panel is open, keep it glued to the button's new spot
        if (panel.classList.contains('rgnf-open')) positionPanel(fab, panel);
      } else {
        togglePanel(fab, panel); // treat as a click
      }
    };

    fab.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    fab.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }


  // among-us role reveal on name steal. pointer-events:none, self-removes.
  function showImposterReveal(raw) {
    if (!document.getElementById('rgnfImposterKf')) {
      const st = document.createElement('style');
      st.id = 'rgnfImposterKf';
      st.textContent = '@keyframes rgnfImpIn { 0% { opacity:0; transform:scale(.6); letter-spacing:.45em; } 20% { opacity:1; transform:scale(1.06); letter-spacing:.1em; } 30% { transform:scale(1); } 84% { opacity:1; } 100% { opacity:0; } } '
        + '@keyframes rgnfImpBg { 0% { opacity:0; } 10% { opacity:1; } 84% { opacity:1; } 100% { opacity:0; } }';
      document.head.appendChild(st);
    }
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(4,6,12,.88);pointer-events:none;animation:rgnfImpBg 2.5s ease forwards;';
    const title = document.createElement('div');
    title.textContent = 'ඞ You are the Imposter';
    title.style.cssText = 'color:#ef4444;font:800 34px/1.2 -apple-system,"Segoe UI",Roboto,sans-serif;text-shadow:0 0 26px rgba(239,68,68,.85);animation:rgnfImpIn 2.5s ease forwards;';
    ov.appendChild(title);
    const sub = document.createElement('div');
    sub.style.cssText = 'margin-top:12px;font-size:18px;animation:rgnfImpIn 2.5s ease forwards;';
    sub.appendChild(renderRawTMP(raw));
    ov.appendChild(sub);
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 2550);
  }

  const ART_PREVIEW_FONT = 'Arial, Helvetica, "Liberation Sans", sans-serif';

  // Arial's period is way bigger than the game's, and assuming it filled the cell
  // is what smeared the preview rows into vertical bars.
  const _inkCache = new Map();
  function glyphInk(ch, font) {
    const key = ch + '|' + font;
    if (_inkCache.has(key)) return _inkCache.get(key);
    const REF = 100;
    let ink = { adv: 0.278, w: 0.09, h: 0.09 };
    try {
      const c = document.createElement('canvas').getContext('2d');
      c.font = REF + 'px ' + font;
      const m = c.measureText(ch);
      const w = ((m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0)) / REF;
      const h = ((m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0)) / REF;
      if (m.width > 0) {
        ink = { adv: m.width / REF, w: w > 0 ? w : m.width / REF * 0.3, h: h > 0 ? h : m.width / REF * 0.3 };
      }
    } catch (e) { /* no canvas: fall back to Arial period metrics */ }
    _inkCache.set(key, ink);
    return ink;
  }

  function artFirstGlyph(text) {
    const bare = String(text ?? '').replace(/<[^>]*>/g, '').replace(/[\s\u00A0]/g, '');
    return bare ? bare[0] : '.';
  }

  // Shrink the font until the ink fits the cell, then space it back out to pitch.
  function artCellStyle(glyph, cellW, cellH) {
    const ink = glyphInk(glyph, ART_PREVIEW_FONT);
    const px = Math.max(1, 0.9 * Math.min(cellW / ink.w, cellH / ink.h));
    return { px, letter: cellW - ink.adv * px, line: cellH };
  }

  function renderRawTMP(raw, opts = {}) {
    const root = document.createElement('div');
    root.className = 'rgnf-preview-inner';
    const art = isAsciiArtText(raw);
    const previewPx = Math.max(10, Math.round(18 * (previewZoom || 1)));
    // TMP applies these to the whole block, so grab them before we draw anything.
    const artTag = re => { const m = raw.match(re); return m ? Number(m[1]) : null; };
    const artSizePct = artTag(/<size=(\d+(?:\.\d+)?)\s*%/i);
    const artLineEm = artTag(/<line-height=(-?\.?\d*\.?\d+)\s*em/i);
    const artCspaceEm = artTag(/<cspace=(-?\.?\d*\.?\d+)\s*em/i);
    const artPx = Math.max(1.5, previewPx * (artSizePct ? artSizePct / 100 : 1));
    // cspace goes tighter than a monospace cell, so we need the game's own font.
    const artFont = artCspaceEm != null ? ART_PREVIEW_FONT : 'ui-monospace, Menlo, Consolas, monospace';
    let artCell = null;
    if (art && artCspaceEm != null) {
      const glyph = artFirstGlyph(raw);
      const ink = glyphInk(glyph, ART_PREVIEW_FONT);
      artCell = artCellStyle(
        glyph,
        (ink.adv + artCspaceEm) * artPx,
        (artLineEm != null ? artLineEm : 1) * artPx
      );
    }
    const applyArtLine = (el) => {
      el.style.whiteSpace = 'pre';
      el.style.fontFamily = artFont;
      if (artCell) {
        el.style.fontSize = artCell.px.toFixed(3) + 'px';
        el.style.letterSpacing = artCell.letter.toFixed(3) + 'px';
        el.style.lineHeight = artCell.line.toFixed(3) + 'px';
      } else if (artCspaceEm != null) {
        el.style.letterSpacing = (artCspaceEm * artPx).toFixed(3) + 'px';
      }
    };
    const paintName = opts.paintName != null ? String(opts.paintName) : "";
    const paintFrom = Number(opts.paintFrom) || 0;
    const paintTo = opts.paintTo != null ? Number(opts.paintTo) : (paintName ? raw.length : -1);
    let nameCursor = 0;
    const inPaintRegion = (index) => paintName && index >= paintFrom && index < paintTo;
    const tagPaintChar = (el, index, ch) => {
      if (!inPaintRegion(index) || nameCursor >= paintName.length) return;
      if ((ch === " " || ch === "\u00A0")
          && paintName[nameCursor] !== " "
          && paintName[nameCursor] !== "\u00A0") {
        return;
      }
      if (paintName.startsWith("<sprite=", nameCursor)) {
        const close = paintName.indexOf(">", nameCursor);
        const end = close >= 0 ? close + 1 : nameCursor + 1;
        el.dataset.forgeStart = String(nameCursor);
        el.dataset.forgeEnd = String(end);
        nameCursor = end;
        return;
      }
      const len = String.fromCodePoint(paintName.codePointAt(nameCursor)).length;
      el.dataset.forgeI = String(nameCursor);
      nameCursor += len;
    };
    const tagPaintBreak = (index) => {
      if (!inPaintRegion(index) || nameCursor >= paintName.length) return;
      if (paintName[nameCursor] === "\n") nameCursor += 1;
    };
    let mspaceEm = null;
    if (art) {
      root.classList.add('rgnf-ascii');
      root.style.minWidth = 'max-content';
      root.style.width = 'max-content';
      root.style.textAlign = 'left';
      root.style.fontSize = artPx + 'px';
      root.style.lineHeight = artLineEm != null ? String(artLineEm) : '1.12';
      applyArtLine(root);
      if (artCell) root.style.fontSize = artCell.px.toFixed(3) + 'px';
    } else {
      root.style.lineHeight = '1.35';
    }
    const st = {
      color: null,
      colorStack: [],
      bold: false,
      italic: false,
      sub: false,
      sup: false,
      sizePct: 100,
      rotate: 0,
      mark: null,
      voffsetEm: 0,
    };
    const startLine = () => {
      const next = document.createElement('div');
      if (art) applyArtLine(next);
      return next;
    };
    let line = startLine();
    root.appendChild(line);
    // Append target — flips to a stacked layer when <pos> opens one.
    let currentContainer = line;
    let i = 0;
    const spriteEmoji = n => (SPRITES.find(x => x.n === n) || {}).e || '❔';
    while (i < raw.length) {
      const rest = raw.slice(i);
      let m;
      if ((m = rest.match(/^<br\s*\/?\s*>/i)) || rest[0] === '\n') {
        tagPaintBreak(i);
        line = startLine();
        root.appendChild(line);
        currentContainer = line;
        i += m ? m[0].length : 1;
        continue;
      }
      if (rest[0] === '\r') { i += 1; continue; }
      if ((m = rest.match(/^<#00000000>\./))) {
        const pad = document.createElement('span');
        pad.textContent = '.';
        pad.style.color = 'transparent';
        if (art && mspaceEm) {
          pad.style.display = 'inline-block';
          pad.style.width = mspaceEm + 'em';
        }
        currentContainer.appendChild(pad);
        i += m[0].length;
        continue;
      }
      // TMP accepts 3/4/6/8-char hex shortcuts; match all so the preview lines
      // up with what the game actually renders (was 6/8 only).
      if ((m = rest.match(/^<(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/))) { st.color = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<color\s*=\s*(["']?)(#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f])?|#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)\1\s*>/i))) {
        st.colorStack.push(st.color);
        st.color = m[2];
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/color\s*>/i))) {
        st.color = st.colorStack.length ? st.colorStack.pop() : null;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<b>/i)))   { st.bold = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/b>/i))) { st.bold = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<i>/i)))   { st.italic = true;  i += m[0].length; continue; }
      if ((m = rest.match(/^<\/i>/i))) { st.italic = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sub>/i)))   { st.sub = true; st.sup = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sub>/i))) { st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<sup>/i)))   { st.sup = true; st.sub = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/sup>/i))) { st.sup = false; i += m[0].length; continue; }
      if ((m = rest.match(/^<space=([\d.]+)em>/i))) {
        const pad = document.createElement('span');
        pad.style.display = 'inline-block';
        pad.style.width = m[1] + 'em';
        pad.style.height = '1em';
        currentContainer.appendChild(pad);
        i += m[0].length;
        continue;
      }
      // <pos=X> starts a stacked layer so names with multiple <pos=0> passes
      // overlay instead of drawing side-by-side.
      if ((m = rest.match(/^<pos=(-?[\d.]+)(em|px|%)?>/i))) {
        line.style.position = 'relative';
        line.style.display = 'inline-block';
        const layer = document.createElement('span');
        layer.style.position = 'absolute';
        layer.style.left = m[1] + (m[2] || 'em');
        layer.style.top = '0';
        layer.style.whiteSpace = 'nowrap';
        line.appendChild(layer);
        currentContainer = layer;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/pos>/i))) { currentContainer = line; i += m[0].length; continue; }
      // TMP voffset: positive is up, so invert for CSS translateY.
      if ((m = rest.match(/^<voffset=(-?[\d.]+)em>/i))) {
        st.voffsetEm = Number(m[1]) || 0;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/voffset>/i))) { st.voffsetEm = 0; i += m[0].length; continue; }
      if ((m = rest.match(/^<mspace=([\d.]+)em>/i))) {
        mspaceEm = Number(m[1]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/mspace>/i))) { i += m[0].length; continue; }
      if ((m = rest.match(/^<line-height=([\d.]+)(?:em|%)?>/i))) {
        if (art && artLineEm == null) root.style.lineHeight = /em/i.test(m[0]) ? String(m[1]) : '1.12';
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/line-height>/i))) { i += m[0].length; continue; }
      if ((m = rest.match(/^<size=(\d+)%?>/i))) {
        // Cap preview at 300% so a stray <size=9999> doesn't push
        // the editor off-screen. In-game render is untouched.
        // Art ignores this for layout — <size=32%> as 7px plus flex wrap
        // is what made the sticky preview go tall and skinny.
        const parsedSize = Number(m[1]);
        st.sizePct = Math.min(Number.isFinite(parsedSize) ? parsedSize : 100, 300);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<\/size>/i))) { st.sizePct = 100; i += m[0].length; continue; }
      if ((m = rest.match(/^<rotate=(-?\d+)>/i))) { st.rotate = Number(m[1]) || 0; i += m[0].length; continue; }
      if ((m = rest.match(/^<mark=(#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8}))>/i))) { st.mark = m[1]; i += m[0].length; continue; }
      if ((m = rest.match(/^<\/mark>/i))) { st.mark = null; i += m[0].length; continue; }
      if ((m = rest.match(/^<sprite=(\d+)>/i))) {
        const sp = document.createElement('span');
        sp.textContent = spriteEmoji(Number(m[1]));
        tagPaintChar(sp, i, m[0]);
        currentContainer.appendChild(sp); i += m[0].length; continue;
      }
      if ((m = rest.match(/^<[^>]*>/))) { i += m[0].length; continue; } // unknown tag
      const ch = raw[i];
      const span = document.createElement('span');
      span.textContent = ch;
      if (st.color) span.style.color = st.color;
      if (st.bold) span.style.fontWeight = '700';
      if (st.italic) span.style.fontStyle = 'italic';
      if (st.mark) span.style.background = st.mark;
      let size = 18 * (st.sizePct / 100) * (previewZoom || 1);
      if (st.sub || st.sup) {
        size *= 0.65;
        span.style.verticalAlign = st.sup ? 'super' : 'sub';
      }
      if (st.sizePct <= 0) {
        span.style.display = 'none';
      } else {
        span.style.fontSize = (art ? (artCell ? artCell.px : artPx) : Math.max(7, size)) + 'px';
        if (art && mspaceEm) {
          span.style.display = 'inline-block';
          span.style.width = mspaceEm + 'em';
          span.style.textAlign = 'center';
        }
        const transforms = [];
        if (st.rotate) transforms.push('rotate(' + st.rotate + 'deg)');
        if (st.voffsetEm) transforms.push('translateY(' + (-st.voffsetEm) + 'em)');
        if (transforms.length) {
          span.style.display = 'inline-block';
          span.style.transform = transforms.join(' ');
        }
      }
      tagPaintChar(span, i, ch);
      currentContainer.appendChild(span);
      i++;
    }
    return root;
  }

  function attachLayerOverlays(baseDom, s) {
    if (!Array.isArray(s?.layers) || !s.layers.length) return baseDom;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block;';
    wrap.appendChild(baseDom);
    for (const L of s.layers) {
      const text = String(L?.text || '') || String(s.name || '');
      if (!text) continue;
      const x = Number(L.x) || 0;
      const y = Number(L.y) || 0;
      const c = String(L.color || '#ffffff').toUpperCase();
      let inner = text;
      if (y) inner = `<voffset=${y}em>${inner}</voffset>`;
      if (L.bold) inner = `<b>${inner}</b>`;
      const snippet = `${x ? `<space=${x}em>` : ''}<color=${c}>${inner}</color>`;
      const overlay = renderRawTMP(snippet);
      overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
      wrap.appendChild(overlay);
    }
    return wrap;
  }

  function renderRawPreview(raw, s, opts = {}) {
    const pfx = opts.skipPrefix ? '' : _prefix();
    const body = typeof s?.rawCode === "string" ? s.rawCode : String(raw ?? "");
    const shownPfx = artPreviewText(pfx);
    const shownBody = artPreviewText(body);
    const hasLayers = !opts.skipLayers && Array.isArray(s?.layers) && s.layers.length;
    const layerOpts = { noPrefixOffset: hasLayers && !!pfx };
    const layeredBody = hasLayers ? spliceLayersOnFirstLine(shownBody, s, layerOpts) : shownBody;
    const shownTail = s?.scoredMode === "hide" ? "" : scoredSuffix(s) + " Scored!";
    const nameLineChars = (/<br\s*\/?\s*>/i.exec(shownBody) || { index: shownBody.length }).index;
    let inner;
    if (hasLayers && pfx) {
      // Prefix as its own sibling so layer <pos=0> resets to the body's start,
      // not the line start (which would land on top of the tag).
      inner = document.createElement('div');
      inner.style.cssText = 'display:inline-flex;align-items:baseline;white-space:nowrap;';
      inner.appendChild(renderRawTMP(shownPfx));
      inner.appendChild(renderRawTMP(layeredBody + shownTail, {
        paintName: s?.name,
        paintFrom: 0,
        paintTo: nameLineChars,
      }));
    } else {
      inner = renderRawTMP(shownPfx + layeredBody + shownTail, {
        paintName: s?.name,
        paintFrom: shownPfx.length,
        paintTo: shownPfx.length + (hasLayers ? nameLineChars : shownBody.length),
      });
    }


    // Width 100% stack keeps the flex preview from collapsing to one
    // character (min-content of per-glyph spans) and going tall/skinny.
    const stack = document.createElement("div");
    stack.className = "rgnf-preview-stack";
    stack.appendChild(makePaintBar());
    stack.appendChild(inner);
    wirePreviewPaint(inner);
    paintPreviewSelection(stack);
    return stack;
  }

  function captureForgeScroll(panel) {
    const saved = [];
    for (let node = panel; node; node = node.parentElement) {
      if (node === panel || node.id === 'rgForgeView' || node.id === 'rgBody') {
        saved.push({
          node,
          top: node.scrollTop,
          left: node.scrollLeft,
        });
      }
      if (node.id === 'rgHUD') break;
    }
    return saved;
  }

  function restoreForgeScroll(saved) {
    saved.forEach(({ node, top, left }) => {
      node.scrollTop = top;
      node.scrollLeft = left;
    });
  }

  function render(panel) {
    // Catch legacy states persisted before decodeLayeredRaw existed: if we
    // still have a layered rawCode sitting alongside an empty Layers array,
    // decode it once so the editor lands with the right base + layer cards.
    if (typeof state?.rawCode === 'string' && /<pos=/i.test(state.rawCode)
        && (!Array.isArray(state.layers) || !state.layers.length)) {
      const decoded = decodeLayeredRaw(state.rawCode);
      if (decoded) {
        state.rawCode = null;
        if (decoded.baseName) state.name = decoded.baseName;
        state.layers = decoded.layers;
      }
    }
    // Rescue states where an earlier decoder version left a concatenated
    // base name behind. If every layer's text is the same string and
    // state.name is that string repeated, collapse it back to one copy.
    if (Array.isArray(state?.layers) && state.layers.length && typeof state.name === 'string') {
      const explicitTexts = state.layers.map(L => L?.text).filter(t => typeof t === 'string' && t.length);
      if (explicitTexts.length && explicitTexts.every(t => t === explicitTexts[0])) {
        const one = explicitTexts[0];
        if (state.name !== one && state.name.length % one.length === 0
            && state.name === one.repeat(state.name.length / one.length)) {
          state.name = one;
          for (const L of state.layers) if (L?.text === one) L.text = '';
        }
      }
    }
    commitForgeHistory();
    const savedScroll = captureForgeScroll(panel);
    panel.innerHTML = '';
    saveJSON(stateKey(), state);

    // ---- header (draggable in fly-out mode; inert inside HUD tab) ----
    const head = el('div', { class: 'rgnf-head' });
    head.appendChild(el('b', { text: 'Name Forge' }));
    const historyActions = el('div', { class: 'rgnf-row' });
    historyActions.style.margin = '0';
    const undoBtn = el('button', {
      class: 'rgnf-chip', text: '↶', title: 'Undo (Ctrl/Cmd+Z)',
      'data-rgnf-undo': '',
      onclick: undoForge,
    });
    const redoBtn = el('button', {
      class: 'rgnf-chip', text: '↷', title: 'Redo (Ctrl/Cmd+Shift+Z)',
      'data-rgnf-redo': '',
      onclick: redoForge,
    });
    historyActions.appendChild(undoBtn);
    historyActions.appendChild(redoBtn);
    head.appendChild(historyActions);
    makeDraggable(panel, head);
    panel.appendChild(head);

    // touch-to-exit raw mode. wired once, fires only on real user input.
    // touching a styling control clears the raw snapshot so that handler wins.
    if (!panel._rgnfRawExitWired) {
      panel._rgnfRawExitWired = true;
      const exitRawIfStylingTouch = (e) => {
        if (!state.rawCode) return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('.rgnf-modebar') || t.closest('.rgnf-actions-sec')
            || t.closest('.rgnf-preview-sec') || t.closest('.rgnf-preview')
            || t.closest('.rgnf-presets-sec') || t.closest('.rgnf-imposter-sec')
            || t.closest('.rgnf-scored-sec') || t.closest('.rgnf-raw-text-safe')
            || t.closest('.rgnf-head')) return;
        absorbRawIntoPaintState();
        saveJSON(stateKey(), state);
        const bar = panel.querySelector('.rgnf-modebar');
        if (bar) bar.remove();
      };
      panel.addEventListener('pointerdown', exitRawIfStylingTouch, true);
      panel.addEventListener('keydown', exitRawIfStylingTouch, true);
    }

    // ---- preview + code ----
    // preview goes directly on the panel so sticky's parent is the full
    // scrollable body. header/code/meta stay in secPreview and scroll.
    const previewArt = isAsciiArtText(state.rawCode || "") || isAsciiArtText(state.name);
    const pv = el('div', {
      class: `rgnf-preview rgnf-align-${previewArt ? "left" : normalizeForgeAlign(state.align)}`,
    });
    pv.style.justifyContent = previewArt ? "flex-start" : forgeAlignJustify(state.align);
    if (state.rawCode) {
      pv.appendChild(renderRawPreview(_prefix() + state.rawCode, state));
    } else if (Array.isArray(state.layers) && state.layers.length) {
      const bodyOnly = buildCode({ ...state, layers: [] });
      const suffix = scoredSuffix(state);
      const bodyClean = suffix && bodyOnly.endsWith(suffix) ? bodyOnly.slice(0, -suffix.length) : bodyOnly;
      pv.appendChild(renderRawPreview(bodyClean, state));
    } else {
      pv.appendChild(renderPreview(state));
    }
    panel.appendChild(pv);

    const secPreview = el('div', { class: 'rgnf-sec rgnf-preview-sec' });
    // "Preview" label + ↺ reset to the current in-game name
    {
      const hrow = el('div', {});
      hrow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;';
      const h4 = el('h4', { text: 'Preview' });
      h4.style.margin = '0';
      hrow.appendChild(h4);
      if (_lastRawNickname) {
        hrow.appendChild(el('button', {
          class: 'rgnf-chip', text: '↺',
          title: 'Reset to my current in-game name',
          onclick: () => { setRawSnapshot(_lastRawNickname); render(panel); },
        }));
      }
      secPreview.appendChild(hrow);
    }
    // hand-editing either mode captures the text as rawCode and flips to raw
    // so subsequent rebuilds don't clobber the edit
    const rawEdit = el('textarea', { class: 'rgnf-code' });
    rawEdit.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-height:34px;resize:none;overflow-y:auto;background:var(--rgnf-panel);border:1px solid var(--rgnf-line);border-radius:8px;padding:8px;font:11px/1.5 ui-monospace, Menlo, Consolas, monospace;color:var(--rgnf-code);';
    // reset to auto first, scrollHeight won't shrink below the current height
    const autosizeRawEdit = () => {
      rawEdit.style.height = 'auto';
      rawEdit.style.height = (rawEdit.scrollHeight + 2) + 'px';
    };
    rawEdit.addEventListener('input', () => {
      autosizeRawEdit();
      // capturing text as rawCode flips us into raw mode (refreshPreview keys off it)
      setRawSnapshot(rawEdit.value);
      const renderedNameInput = panel.querySelector('.rgnf-name-input');
      if (renderedNameInput && renderedNameInput.value !== state.name) renderedNameInput.value = state.name;
      const rawPfx = _prefix();
      const rawEffective = rawPfx + effectiveForgeCode(state);
      pv.replaceChildren(renderRawPreview(rawPfx + state.rawCode, state));
      charSpan.textContent = `${rawEffective.length} chars`;
      const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
      letterSpan.textContent = `${[...plainLetters].length} letters`;
      saveJSON(stateKey(), state);
    });
    secPreview.appendChild(rawEdit);
    const charSpan = el('span', { text: '' });
    const letterSpan = el('span', { text: '' });
    secPreview.appendChild(el('div', { class: 'rgnf-meta' }, [charSpan, letterSpan]));
    const artHint = el('div', { text: '' });
    artHint.style.cssText = 'color:var(--rgnf-muted);font-size:11px;margin-top:4px;';
    secPreview.appendChild(artHint);
    panel.appendChild(secPreview);

    // update preview/code/meta without rebuilding the panel, so the name field
    // keeps focus and cursor position while typing
    const refreshArtHint = (src, packedLen) => {
      if (!isAsciiArtText(src)) {
        artHint.textContent = packedLen > 450
          ? "This name is long — the game may cut it off."
          : "";
        return;
      }
      const { height, width } = artLineStats(src);
      const size = artFitSizePct(height, width);
      const bits = [];
      if (isBrailleArtText(src)) {
        bits.push("Game font has no braille — converted to # . : art.");
      }
      if (size < 100) bits.push(`Scaled to ${size}% so the whole piece fits the nameplate.`);
      if (packedLen > 450) bits.push("Still long — the game may cut the bottom.");
      artHint.textContent = bits.join(" ");
    };
    const refreshPreview = () => {
      if (state.rawCode) {
        // clan-tag prefix applies in raw mode too. old hardcoded tags in the raw
        // name will preview doubled, fix by deleting them in the textarea.
        const rawPfx = _prefix();
        const rawEffective = rawPfx + effectiveForgeCode(state);
        pv.replaceChildren(renderRawPreview(rawPfx + state.rawCode, state));
        if (rawEdit.value !== state.rawCode) rawEdit.value = state.rawCode;
        const renderedNameInput = panel.querySelector('.rgnf-name-input');
        if (renderedNameInput && renderedNameInput.value !== state.name) renderedNameInput.value = state.name;
        autosizeRawEdit();
        charSpan.textContent = `${rawEffective.length} chars`;
        const plainLetters = state.rawCode.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
        letterSpan.textContent = `${[...plainLetters].length} letters`;
        refreshArtHint(state.rawCode, rawEffective.length);
        saveJSON(stateKey(), state);
        return;
      }
      // rebuild mode: store without the prefix so a subsequent hand-edit's
      // rawCode capture has no baked-in tag
      const built = buildCode(state);
      const code = _prefix() + built;
      if (Array.isArray(state.layers) && state.layers.length) {
        const bodyOnly = buildCode({ ...state, layers: [] });
        const suffix = scoredSuffix(state);
        const bodyClean = suffix && bodyOnly.endsWith(suffix) ? bodyOnly.slice(0, -suffix.length) : bodyOnly;
        pv.replaceChildren(renderRawPreview(bodyClean, state));
      } else {
        pv.replaceChildren(renderPreview(state));
      }
      if (rawEdit.value !== built) rawEdit.value = built;
      autosizeRawEdit();
      const codeBytes = new TextEncoder().encode(code).length;
      charSpan.textContent = `${code.length} chars · ${codeBytes.toLocaleString()}B`;
      charSpan.style.color = codeBytes > NICKNAME_BYTE_LIMIT ? '#ef4444'
        : codeBytes > NICKNAME_BYTE_WARN ? '#f59e0b' : '';
      charSpan.title = codeBytes > NICKNAME_BYTE_WARN
        ? `Quantum's frame buffer is 49152 bytes. Over ~${NICKNAME_BYTE_LIMIT.toLocaleString()} risks crashing the client.`
        : '';
      letterSpan.textContent = `${[...state.name].length} letters`;
      refreshArtHint(state.name, code.length);
      saveJSON(stateKey(), state);
    };
    refreshForgePreview = () => {
      const top = pv.scrollTop;
      const left = pv.scrollLeft;
      refreshPreview();
      pv.scrollTop = top;
      pv.scrollLeft = left;
    };
    refreshPreview();

    // ---- Name ----
    const secName = el('div', { class: 'rgnf-sec' });
    secName.appendChild(el('h4', { text: 'Name' }));
    const nameInput = el('textarea', {
      class: 'rgnf-name-input rgnf-raw-text-safe',
      rows: '4',
      placeholder: 'Type your name, or paste ASCII art…',
      oninput: (e) => {
        const next = e.target.value;
        if (next !== state.name) {
          state.colorSpans = [];
          namePaintSel = { start: 0, end: 0 };
        }
        state.name = next;
        if (typeof state.rawCode === 'string') {
          const keepScored = state.scoredMode;
          if (isAsciiArtText(next) || isAsciiArtText(state.rawCode)) {
            setRawSnapshot(next);
            state.scoredMode = keepScored;
          } else {
            state.rawCode = replaceRawNameText(state.rawCode, next);
          }
        }
        refreshPreview();
      },
    });
    nameInput.value = state.name;
    ["mouseup", "keyup", "select"].forEach((evt) => {
      nameInput.addEventListener(evt, () => rememberNamePaintSel(nameInput));
    });
    secName.appendChild(el('div', { class: 'rgnf-row' }, [
      nameInput,
      el('button', {
        class: 'rgnf-chip', text: '✕ Clear', title: 'Clear the name field',
        onclick: () => { state.name = ''; state.colorSpans = []; namePaintSel = { start: 0, end: 0 }; nameInput.value = ''; refreshPreview(); nameInput.focus(); },
      }),
    ]));

    // sprite inserter
    secName.appendChild(el('h4', { text: 'Insert emoji sprite (0–15)' }));
    const spriteGrid = el('div', { class: 'rgnf-sprites' });
    SPRITES.forEach((sp) => {
      const btn = el('button', {
        text: sp.e,
        title: `${sp.n}: ${sp.label} — <sprite=${sp.n}>`,
        onclick: () => {
          const tag = `<sprite=${sp.n}>`;
          const start = nameInput.selectionStart ?? state.name.length;
          const end = nameInput.selectionEnd ?? state.name.length;
          state.name = state.name.slice(0, start) + tag + state.name.slice(end);
          if (typeof state.rawCode === 'string') {
            state.rawCode = replaceRawNameText(state.rawCode, state.name);
          }
          state.colorSpans = [];
          namePaintSel = { start: 0, end: 0 };
          nameInput.value = state.name;
          const pos = start + tag.length;
          nameInput.focus();
          nameInput.setSelectionRange(pos, pos);
          refreshPreview();
        },
      });
      if (sp.broken) btn.classList.add('rgnf-sprite-broken');
      spriteGrid.appendChild(btn);
    });
    secName.appendChild(spriteGrid);
    panel.appendChild(secName);

    // ---- Color ----
    const secColor = el('div', { class: 'rgnf-sec' });
    secColor.appendChild(el('h4', { text: 'Color' }));
    secColor.appendChild(el('p', {
      class: 'rgnf-hint',
      text: namePaintRange()
        ? 'Painting the highlighted text only.'
        : 'Drag on the sticky preview to pick a slice. Then change Color. No highlight paints everything.',
    }));
    const modeRow = el('div', { class: 'rgnf-row' });
    ['none', 'solid', 'gradient'].forEach((m) => {
      modeRow.appendChild(el('button', {
        class: `rgnf-chip ${state.colorMode === m ? 'rgnf-on' : ''}`,
        text: m[0].toUpperCase() + m.slice(1),
        onclick: () => { commitNameColor(() => { state.colorMode = m; }); render(panel); },
      }));
    });
    secColor.appendChild(modeRow);

    if (state.colorMode === 'solid') {
      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.solidColor, oninput: (e) => { commitNameColor(() => { state.solidColor = e.target.value; }); render(panel); } }),
        el('label', { text: 'Opacity' }, [
          el('input', { type: 'range', min: 32, max: 255, value: state.solidAlpha ?? 255,
            oninput: (e) => { commitNameColor(() => { state.solidAlpha = Number(e.target.value); }); refreshPreview(); },
            style: 'width:80px;margin-left:6px;',
          }),
        ]),
      ]));
    }

    if (state.colorMode === 'gradient') {
      const stopsWrap = el('div', { class: 'rgnf-stops' });
      state.stops.forEach((c, idx) => {
        const stop = el('div', { class: 'rgnf-stop' }, [
          el('input', { type: 'color', value: c, oninput: (e) => { commitNameColor(() => { state.stops[idx] = e.target.value; }); render(panel); } }),
        ]);
        if (state.stops.length > 2) {
          stop.appendChild(el('button', { text: '✕', onclick: () => { commitNameColor(() => { state.stops.splice(idx, 1); }); render(panel); } }));
        }
        stopsWrap.appendChild(stop);
      });
      if (state.stops.length < 5) {
        stopsWrap.appendChild(el('button', {
          class: 'rgnf-chip', text: '+ stop',
          onclick: () => { commitNameColor(() => { state.stops.push(state.stops[state.stops.length - 1]); }); render(panel); },
        }));
      }
      secColor.appendChild(stopsWrap);
      const bar = el('div', { class: 'rgnf-gradbar' });
      bar.style.background = `linear-gradient(90deg, ${state.stops.join(',')})`;
      secColor.appendChild(bar);

      // one-click palettes + tools
      const palRow = el('div', { class: 'rgnf-row' });
      PALETTES.forEach((p) => {
        palRow.appendChild(el('button', {
          class: 'rgnf-chip', text: p.label, title: p.stops.join(' → '),
          onclick: () => { commitNameColor(() => { state.stops = [...p.stops]; }); render(panel); },
        }));
      });
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '⇄ Reverse', title: 'Flip gradient direction',
        onclick: () => { commitNameColor(() => { state.stops.reverse(); }); render(panel); },
      }));
      palRow.appendChild(el('button', {
        class: 'rgnf-chip', text: '🎲 Random', title: 'Roll a random vivid gradient',
        onclick: () => { commitNameColor(() => { state.stops = randomStops(); }); render(panel); },
      }));
      secColor.appendChild(palRow);

      secColor.appendChild(el('div', { class: 'rgnf-row' }, [
        el('button', {
          class: `rgnf-chip ${state.skipSpaces ? 'rgnf-on' : ''}`,
          text: 'Skip spaces (fewer tags)',
          onclick: () => { state.skipSpaces = !state.skipSpaces; render(panel); },
        }),
      ]));
    }
    panel.appendChild(secColor);

    // ---- Styles ----
    const secStyle = el('div', { class: 'rgnf-sec' });
    secStyle.appendChild(el('h4', { text: 'Style' }));
    const styleRow = el('div', { class: 'rgnf-row' });
    const toggles = [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['strike', 'S']];
    toggles.forEach(([key, label]) => {
      styleRow.appendChild(el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; render(panel); },
      }));
    });
    secStyle.appendChild(styleRow);

    const alignRow = el('div', { class: 'rgnf-row' });
    [['left', 'Left'], ['center', 'Center'], ['right', 'Right']].forEach(([value, label]) => {
      alignRow.appendChild(el('button', {
        class: `rgnf-chip ${normalizeForgeAlign(state.align) === value ? 'rgnf-on' : ''}`,
        text: label,
        title: `Align the name ${value} on the nameplate`,
        onclick: () => {
          state.align = value;
          writeAlignDefault(value);
          if (typeof state.rawCode === 'string') {
            const art = isAsciiArtText(state.rawCode) || isAsciiArtText(state.name);
            state.rawCode = art
              ? packAsciiArt(state.rawCode, value)
              : applyAlignToRaw(state.rawCode, value);
          }
          render(panel);
        },
      }));
    });
    secStyle.appendChild(alignRow);

    secStyle.appendChild(sliderRow(panel, 'Size', 'sizePct', 10, 500, '%'));
    secStyle.appendChild(sliderRow(panel, 'Rotate', 'rotateDeg', -45, 45, '°'));

    const waveRow = el('div', { class: 'rgnf-row' });
    waveRow.appendChild(el('button', {
      class: `rgnf-chip ${state.waveOn ? 'rgnf-on' : ''}`,
      text: '〰 Wave letters',
      title: 'Alternates each letter\'s tilt — overrides Rotate while on',
      onclick: () => { state.waveOn = !state.waveOn; render(panel); },
    }));
    secStyle.appendChild(waveRow);
    if (state.waveOn) {
      secStyle.appendChild(sliderRow(panel, 'Tilt', 'waveAmp', 3, 35, '°'));
    }

    const markRow = el('div', { class: 'rgnf-row' });
    markRow.appendChild(el('button', {
      class: `rgnf-chip ${state.markOn ? 'rgnf-on' : ''}`, text: 'Highlight',
      onclick: () => { state.markOn = !state.markOn; render(panel); },
    }));
    if (state.markOn) {
      markRow.appendChild(el('input', { type: 'color', value: state.markColor, oninput: (e) => { state.markColor = e.target.value; render(panel); } }));
      markRow.appendChild(el('input', {
        type: 'range', min: 16, max: 255, value: state.markAlpha,
        oninput: (e) => { state.markAlpha = Number(e.target.value); render(panel); },
      }));
    }
    secStyle.appendChild(markRow);
    panel.appendChild(secStyle);

    // ---- Layers ----
    if (!Array.isArray(state.layers)) state.layers = [];
    const secLayers = el('div', { class: 'rgnf-sec' });
    secLayers.appendChild(el('h4', { text: 'Layers' }));
    secLayers.appendChild(el('div', {
      style: 'opacity:.7;font-size:11px;margin:-4px 0 6px;',
      text: 'Stack copies of your name on top with color and offset — shadows, outlines, ghost letters.',
    }));

    const addLayerRow = el('div', { class: 'rgnf-row' });
    const addLayerBtn = el('button', {
      class: 'rgnf-chip',
      text: `➕ Add layer${state.layers.length ? ` (${state.layers.length}/10)` : ''}`,
      onclick: () => {
        if (state.layers.length >= 10) return;
        const prev = state.layers[state.layers.length - 1];
        const seed = prev
          ? {
              text: prev.text || '',
              color: prev.color || '#ffffff',
              x: (Number(prev.x) || 0) + 0.05,
              y: Number(prev.y) || 0,
              sizePct: Number(prev.sizePct) || 100,
              bold: !!prev.bold,
            }
          : { text: '', color: '#ffffff', x: 0.05, y: 0, sizePct: 100, bold: false };
        state.layers.push(seed);
        render(panel);
      },
    });
    if (state.layers.length >= 10) addLayerBtn.setAttribute('disabled', 'true');
    addLayerRow.appendChild(addLayerBtn);
    if (state.layers.length) {
      addLayerRow.appendChild(el('button', {
        class: 'rgnf-chip', text: 'Clear all',
        onclick: () => { state.layers = []; render(panel); },
      }));
    }
    secLayers.appendChild(addLayerRow);

    const fmt = (n) => (Number(n) || 0).toFixed(2);
    state.layers.forEach((L, idx) => {
      const card = el('div', {
        style: 'border:1px solid var(--rgnf-line);border-radius:8px;padding:12px;margin-top:8px;display:flex;flex-direction:column;gap:8px;background:rgba(34,211,238,0.04);',
      });

      // header: label · color · bold · remove
      const header = el('div', {
        class: 'rgnf-layer-head',
        style: 'display:flex;align-items:center;gap:8px;',
      });
      header.appendChild(el('span', {
        text: `Layer ${idx + 1}`, style: 'font-size:12px;opacity:.8;flex:1;',
      }));
      const moveEarlier = el('button', {
        class: 'rgnf-chip', text: '↑', title: 'Move earlier in the stack (behind)',
        onclick: () => {
          if (idx <= 0) return;
          [state.layers[idx - 1], state.layers[idx]] = [state.layers[idx], state.layers[idx - 1]];
          render(panel);
        },
      });
      if (idx === 0) moveEarlier.disabled = true;
      header.appendChild(moveEarlier);
      const moveLater = el('button', {
        class: 'rgnf-chip', text: '↓', title: 'Move later in the stack (in front)',
        onclick: () => {
          if (idx >= state.layers.length - 1) return;
          [state.layers[idx], state.layers[idx + 1]] = [state.layers[idx + 1], state.layers[idx]];
          render(panel);
        },
      });
      if (idx === state.layers.length - 1) moveLater.disabled = true;
      header.appendChild(moveLater);
      const colorInput = el('input', {
        type: 'color', value: L.color || '#ffffff', title: 'Color',
        style: 'width:32px;height:24px;padding:0;cursor:pointer;',
      });
      const setLayerColor = (v) => {
        const layer = state.layers[idx];
        if (!layer) return;
        layer.color = v;
        refreshPreview();
      };
      colorInput.addEventListener('input', (e) => setLayerColor(e.target.value));
      colorInput.addEventListener('change', (e) => setLayerColor(e.target.value));
      header.appendChild(colorInput);
      header.appendChild(el('button', {
        class: `rgnf-chip ${L.bold ? 'rgnf-on' : ''}`, text: 'B', title: 'Bold',
        onclick: (e) => {
          L.bold = !L.bold;
          e.currentTarget.classList.toggle('rgnf-on', L.bold);
          refreshPreview();
        },
      }));
      header.appendChild(el('button', {
        class: 'rgnf-chip', text: '⌫', title: 'Remove layer',
        onclick: () => { state.layers.splice(idx, 1); render(panel); },
      }));
      card.appendChild(header);

      // text
      card.appendChild(el('input', {
        type: 'text', value: L.text || '', placeholder: 'Layer text (defaults to your name)',
        style: 'width:100%;box-sizing:border-box;',
        oninput: (e) => { L.text = e.target.value; refreshPreview(); },
      }));

      // x offset slider
      const xRow = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
      xRow.appendChild(el('span', { text: 'X', style: 'width:14px;opacity:.7;font-size:11px;' }));
      const xVal = el('span', { text: fmt(L.x) + 'em', style: 'width:60px;text-align:right;opacity:.8;font-size:11px;' });
      xRow.appendChild(el('input', {
        type: 'range', min: '-3', max: '3', step: '0.01', value: L.x || 0,
        style: 'flex:1;',
        oninput: (e) => {
          L.x = Number(e.target.value) || 0;
          xVal.textContent = fmt(L.x) + 'em';
          refreshPreview();
        },
      }));
      xRow.appendChild(xVal);
      card.appendChild(xRow);

      // y offset slider
      const yRow = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
      yRow.appendChild(el('span', { text: 'Y', style: 'width:14px;opacity:.7;font-size:11px;' }));
      const yVal = el('span', { text: fmt(L.y) + 'em', style: 'width:60px;text-align:right;opacity:.8;font-size:11px;' });
      yRow.appendChild(el('input', {
        type: 'range', min: '-0.5', max: '0.5', step: '0.01', value: L.y || 0,
        style: 'flex:1;',
        oninput: (e) => {
          L.y = Number(e.target.value) || 0;
          yVal.textContent = fmt(L.y) + 'em';
          refreshPreview();
        },
      }));
      yRow.appendChild(yVal);
      card.appendChild(yRow);

      // size slider (% of base font)
      if (typeof L.sizePct !== 'number') L.sizePct = 100;
      const sRow = el('div', { style: 'display:flex;align-items:center;gap:8px;' });
      sRow.appendChild(el('span', { text: 'S', style: 'width:14px;opacity:.7;font-size:11px;' }));
      const sVal = el('span', { text: Math.round(L.sizePct) + '%', style: 'width:60px;text-align:right;opacity:.8;font-size:11px;' });
      sRow.appendChild(el('input', {
        type: 'range', min: '10', max: '500', step: '5', value: L.sizePct || 100,
        style: 'flex:1;',
        oninput: (e) => {
          L.sizePct = Number(e.target.value) || 100;
          sVal.textContent = Math.round(L.sizePct) + '%';
          refreshPreview();
        },
      }));
      sRow.appendChild(sVal);
      card.appendChild(sRow);

      secLayers.appendChild(card);
    });
    panel.appendChild(secLayers);

    // ---- Title ----
    const secTitle = el('div', { class: 'rgnf-sec' });
    secTitle.appendChild(el('h4', { text: 'Title (line under name)' }));
    const tRow = el('div', { class: 'rgnf-row' });
    tRow.appendChild(el('button', {
      class: `rgnf-chip ${state.titleOn ? 'rgnf-on' : ''}`, text: state.titleOn ? 'On' : 'Off',
      onclick: () => { state.titleOn = !state.titleOn; render(panel); },
    }));
    secTitle.appendChild(tRow);
    if (state.titleOn) {
      // text input
      secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', {
          class: 'rgnf-raw-text-safe',
          type: 'text',
          placeholder: 'e.g. RGC FINALIST',
          value: state.titleText,
          oninput: (e) => {
            const nextTitle = e.target.value;
            if (typeof state.rawCode === 'string') {
              state.rawCode = replaceRawTitleText(state.rawCode, nextTitle);
            }
            state.titleText = nextTitle;
            refreshPreview();
          },
        }),
      ]));
      // color mode
      const tm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        tm.appendChild(el('button', {
          class: `rgnf-chip ${state.titleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.titleColorMode = v; render(panel); },
        }));
      });
      secTitle.appendChild(tm);
      // opacity is below, applies to solid AND gradient
      if (state.titleColorMode === 'solid') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.titleColor, oninput: (e) => { state.titleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      // own palettes + stops (mirrors Name gradient)
      if (state.titleColorMode === 'gradient') {
        const palRow = el('div', { class: 'rgnf-row' });
        PALETTES.forEach(p => {
          palRow.appendChild(el('button', {
            class: `rgnf-chip ${state.titlePaletteKey === p.label ? 'rgnf-on' : ''}`, text: p.label,
            onclick: () => {
              state.titlePaletteKey = p.label;
              state.titleStops = [...p.stops];
              refreshPreview();
              render(panel);
            },
          }));
        });
        secTitle.appendChild(palRow);
        const tStops = el('div', { class: 'rgnf-row' });
        state.titleStops.forEach((c, idx) => {
          const stop = el('div', { class: 'rgnf-stop' }, [
            el('input', { type: 'color', value: c, oninput: (e) => {
              state.titleStops[idx] = e.target.value;
              state.titlePaletteKey = null;
              refreshPreview();
              // repaint gradient bar
              const bar = document.getElementById('rgnfTitleGradBar');
              if (bar) bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
            } }),
          ]);
          if (state.titleStops.length > 2) {
            stop.appendChild(el('button', { text: '✕', onclick: () => { state.titleStops.splice(idx, 1); state.titlePaletteKey = null; render(panel); } }));
          }
          tStops.appendChild(stop);
        });
        if (state.titleStops.length < 5) {
          tStops.appendChild(el('button', {
            class: 'rgnf-chip', text: '+ stop',
            onclick: () => { state.titleStops.push(state.titleStops[state.titleStops.length - 1]); state.titlePaletteKey = null; render(panel); },
          }));
        }
        secTitle.appendChild(tStops);
        const bar = el('div', { class: 'rgnf-gradbar' });
        bar.id = 'rgnfTitleGradBar';
        bar.style.background = `linear-gradient(90deg, ${state.titleStops.join(',')})`;
        secTitle.appendChild(bar);
      }
      // opacity applies to solid AND gradient via 8-digit hex
      if (state.titleColorMode !== 'inherit') {
        secTitle.appendChild(el('div', { class: 'rgnf-row' }, [
          el('label', { text: 'Opacity' }, [
            el('input', { type: 'range', min: 32, max: 255, value: state.titleAlpha ?? 255,
              oninput: (e) => { state.titleAlpha = Number(e.target.value); refreshPreview(); },
              style: 'width:140px;margin-left:6px;',
            }),
          ]),
        ]));
      }
      secTitle.appendChild(sliderRow(panel, 'Size', 'titleSizePct', 10, 500, '%'));
      secTitle.appendChild(sliderRow(panel, 'Gap', 'titleGapLines', 0, 5, ' ln'));
      const tStyle = el('div', { class: 'rgnf-row' });
      const tToggle = (key, label) => el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; refreshPreview(); render(panel); },
      });
      tStyle.appendChild(tToggle('titleBold', 'B'));
      tStyle.appendChild(tToggle('titleItalic', 'I'));
      tStyle.appendChild(tToggle('titleUnderline', 'U'));
      tStyle.appendChild(tToggle('titleStrike', 'S'));
      tStyle.appendChild(tToggle('titleSub', '<sub>'));
      secTitle.appendChild(tStyle);
    }
    panel.appendChild(secTitle);

    // ---- Subtitle ----
    // Mirrors Title but sits below it with its own gap. Same styling controls.
    const secSub = el('div', { class: 'rgnf-sec' });
    secSub.appendChild(el('h4', { text: 'Subtitle (line under title)' }));
    const stRow = el('div', { class: 'rgnf-row' });
    stRow.appendChild(el('button', {
      class: `rgnf-chip ${state.subtitleOn ? 'rgnf-on' : ''}`, text: state.subtitleOn ? 'On' : 'Off',
      onclick: () => { state.subtitleOn = !state.subtitleOn; render(panel); },
    }));
    secSub.appendChild(stRow);
    if (state.subtitleOn) {
      secSub.appendChild(el('div', { class: 'rgnf-row' }, [
        el('input', {
          class: 'rgnf-raw-text-safe',
          type: 'text',
          placeholder: 'e.g. season 2 finals',
          value: state.subtitleText,
          oninput: (e) => { state.subtitleText = e.target.value; refreshPreview(); },
        }),
      ]));
      const stm = el('div', { class: 'rgnf-row' });
      [['inherit', 'Inherit'], ['solid', 'Solid'], ['gradient', 'Gradient']].forEach(([v, label]) => {
        stm.appendChild(el('button', {
          class: `rgnf-chip ${state.subtitleColorMode === v ? 'rgnf-on' : ''}`, text: label,
          onclick: () => { state.subtitleColorMode = v; render(panel); },
        }));
      });
      secSub.appendChild(stm);
      if (state.subtitleColorMode === 'solid') {
        secSub.appendChild(el('div', { class: 'rgnf-row' }, [
          el('input', { type: 'color', value: state.subtitleColor, oninput: (e) => { state.subtitleColor = e.target.value; refreshPreview(); } }),
        ]));
      }
      if (state.subtitleColorMode === 'gradient') {
        const palRow = el('div', { class: 'rgnf-row' });
        PALETTES.forEach(p => {
          palRow.appendChild(el('button', {
            class: `rgnf-chip ${state.subtitlePaletteKey === p.label ? 'rgnf-on' : ''}`, text: p.label,
            onclick: () => {
              state.subtitlePaletteKey = p.label;
              state.subtitleStops = [...p.stops];
              refreshPreview();
              render(panel);
            },
          }));
        });
        secSub.appendChild(palRow);
        const sStops = el('div', { class: 'rgnf-row' });
        state.subtitleStops.forEach((c, idx) => {
          const stop = el('div', { class: 'rgnf-stop' }, [
            el('input', { type: 'color', value: c, oninput: (e) => {
              state.subtitleStops[idx] = e.target.value;
              state.subtitlePaletteKey = null;
              refreshPreview();
              const bar = document.getElementById('rgnfSubtitleGradBar');
              if (bar) bar.style.background = `linear-gradient(90deg, ${state.subtitleStops.join(',')})`;
            } }),
          ]);
          if (state.subtitleStops.length > 2) {
            stop.appendChild(el('button', { text: '✕', onclick: () => { state.subtitleStops.splice(idx, 1); state.subtitlePaletteKey = null; render(panel); } }));
          }
          sStops.appendChild(stop);
        });
        if (state.subtitleStops.length < 5) {
          sStops.appendChild(el('button', {
            class: 'rgnf-chip', text: '+ stop',
            onclick: () => { state.subtitleStops.push(state.subtitleStops[state.subtitleStops.length - 1]); state.subtitlePaletteKey = null; render(panel); },
          }));
        }
        secSub.appendChild(sStops);
        const bar = el('div', { class: 'rgnf-gradbar' });
        bar.id = 'rgnfSubtitleGradBar';
        bar.style.background = `linear-gradient(90deg, ${state.subtitleStops.join(',')})`;
        secSub.appendChild(bar);
      }
      if (state.subtitleColorMode !== 'inherit') {
        secSub.appendChild(el('div', { class: 'rgnf-row' }, [
          el('label', { text: 'Opacity' }, [
            el('input', { type: 'range', min: 32, max: 255, value: state.subtitleAlpha ?? 255,
              oninput: (e) => { state.subtitleAlpha = Number(e.target.value); refreshPreview(); },
              style: 'width:140px;margin-left:6px;',
            }),
          ]),
        ]));
      }
      secSub.appendChild(sliderRow(panel, 'Size', 'subtitleSizePct', 10, 500, '%'));
      secSub.appendChild(sliderRow(panel, 'Gap', 'subtitleGapLines', 0, 5, ' ln'));
      const stStyle = el('div', { class: 'rgnf-row' });
      const stToggle = (key, label) => el('button', {
        class: `rgnf-chip ${state[key] ? 'rgnf-on' : ''}`, text: label,
        onclick: () => { state[key] = !state[key]; refreshPreview(); render(panel); },
      });
      stStyle.appendChild(stToggle('subtitleBold', 'B'));
      stStyle.appendChild(stToggle('subtitleItalic', 'I'));
      stStyle.appendChild(stToggle('subtitleUnderline', 'U'));
      stStyle.appendChild(stToggle('subtitleStrike', 'S'));
      stStyle.appendChild(stToggle('subtitleSub', '<sub>'));
      secSub.appendChild(stStyle);
    }
    panel.appendChild(secSub);

    // ---- Scored! ----
    const secScored = el('div', { class: 'rgnf-sec rgnf-scored-sec' });
    secScored.appendChild(el('h4', { text: '"Scored!" text' }));
    const sRow = el('div', { class: 'rgnf-row' });
    [['default', 'Default'], ['hide', 'Hide'], ['tiny', 'Tiny'], ['styled', 'Styled']].forEach(([v, label]) => {
      sRow.appendChild(el('button', {
        class: `rgnf-chip ${state.scoredMode === v ? 'rgnf-on' : ''}`, text: label,
        onclick: () => {
          state.scoredMode = v;
          writeScoredDefault(v);
          render(panel);
        },
      }));
    });
    secScored.appendChild(sRow);
    {
      const pref = readScoredDefault();
      const hint = el('div', {
        text: pref === 'hide'
          ? 'Default for other names: Hide'
          : pref === 'tiny'
            ? 'Default for other names: Tiny'
            : pref === 'styled'
              ? 'Default for other names: Styled'
              : pref === 'default'
                ? 'Default for other names: Default'
                : 'This choice is remembered when you load another name.',
      });
      hint.style.cssText = 'color:var(--rgnf-muted);font-size:11px;margin-top:4px;';
      secScored.appendChild(hint);
    }
    if (state.scoredMode === 'styled') {
      secScored.appendChild(el('div', { class: 'rgnf-row' }, [
        el('label', { text: 'Color' }),
        el('input', { type: 'color', value: state.scoredColor, oninput: (e) => { state.scoredColor = e.target.value; render(panel); } }),
      ]));
      secScored.appendChild(sliderRow(panel, 'Size', 'scoredSizePct', 10, 300, '%'));
    }
    panel.appendChild(secScored);

    // ---- imposter ----
    // captured lobby names, rendered with their exact markup. rgnf-imposter-sec
    // marker excludes this from the raw-mode touch-to-exit listener.
    const secImposter = el('div', { class: 'rgnf-sec rgnf-imposter-sec' });
    secImposter.appendChild(el('h4', { text: 'ඞ Imposter (last game lobby)' }));
    const roster = _roster();
    if (!roster.length) {
      const hint = el('div', { text: 'Finish a match and the crew from that lobby shows up here. The Imposter could be anyone... even you. ඞ' });
      hint.style.cssText = 'color:var(--rgnf-muted);font-size:12px;';
      secImposter.appendChild(hint);
    } else {
      // preview shows a stolen name -> flag it
      if (state.rawCode && roster.includes(state.rawCode)) {
        const reveal = el('div', { text: 'You are the Imposter. ඞ' });
        reveal.style.cssText = 'color:#ef4444;font-size:12px;font-weight:700;margin-bottom:6px;';
        secImposter.appendChild(reveal);
      }
      const rosterWrap = el('div', { class: 'rgnf-presets' });
      roster.slice(0, 8).forEach((raw) => {
        const row = el('div', { class: 'rgnf-preset' });
        const nameCell = el('span', { title: raw });
        // capped height so multi-line titles can't blow up the row
        nameCell.style.cssText = 'flex:1;overflow:hidden;max-height:44px;white-space:normal;';
        nameCell.appendChild(renderRawTMP(raw));
        row.appendChild(nameCell);
        row.appendChild(el('button', {
          class: 'rgnf-chip', text: 'ඞ Steal',
          title: 'Steal AND apply instantly',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.textContent = '…';
            b.disabled = true;
            try {
              // one-click: apply first, reveal over a name that's already live
              const stolen = _stripTag(raw);
              const codeApplied = _prefix() + stolen;
              const r = await applyNicknameStable(codeApplied, stolen);
              if (r.ok) {
                // Reveal first so a downstream render() throw can't swallow the
                // whole point of the feature via the outer try/catch.
                try { showImposterReveal(raw); } catch (revealErr) { dbg('imposter reveal failed: ' + getErrMsg(revealErr)); }
                setRawSnapshot(stolen);
                _lastRawNickname = stolen;
                recordRecentApply(codeApplied, raw);
                try { render(panel); } catch (renderErr) { dbg('post-steal render failed: ' + getErrMsg(renderErr)); }
                return;
              }
              b.textContent = '✗';
            } catch (err) { b.textContent = '✗'; }
            b.disabled = false;
            setTimeout(() => { b.textContent = 'ඞ Steal'; }, 1500);
          },
        }));
        rosterWrap.appendChild(row);
      });
      secImposter.appendChild(rosterWrap);
    }
    panel.appendChild(secImposter);

    // ---- presets ----
    // rgnf-presets-sec: excluded from the raw-mode touch-to-exit listener.
    // otherwise "+ Save" in raw mode cleared rawCode before the save ran.
    const secPresets = el('div', { class: 'rgnf-sec rgnf-presets-sec' });
    secPresets.appendChild(el('h4', { text: 'Presets' }));
    let presets = loadJSON(presetKey(), null);
    if (!Array.isArray(presets)) {
      const legacyPresets = loadJSON(STORE_KEY_LEGACY, []);
      presets = Array.isArray(legacyPresets) ? legacyPresets : [];
      if (_currentUserId && presets.length) saveJSON(presetKey(), presets);
    }
    // one-time cleanup for pre-fix saves: presets stored before the save-time
    // fix could carry whatever nickname was in state at save time. re-derive
    // from rawCode so the list, load, and export all agree.
    let presetsDirty = false;
    for (const p of presets) {
      if (p?.state?.rawCode) {
        const derived = editableFieldsFromRaw(p.state.rawCode).name;
        if (derived && p.state.name !== derived) {
          p.state.name = derived;
          presetsDirty = true;
        }
        if (Array.isArray(p.state.colorSpans) && p.state.colorSpans.length) {
          p.state.colorSpans = [];
          presetsDirty = true;
        }
      }
    }
    if (presetsDirty) saveJSON(presetKey(), presets);
    const listWrap = el('div', { class: 'rgnf-presets' });

    // presets with no folder -> "Ungrouped"
    const collapseKey = folderCollapseKey();
    const collapseState = loadJSON(collapseKey, {});
    const groups = {};
    presets.forEach((p, idx) => {
      const f = (p.folder && String(p.folder).trim()) || 'Ungrouped';
      (groups[f] = groups[f] || []).push({ p, idx });
    });
    // alphabetical, Ungrouped last
    const folderNames = Object.keys(groups).sort((a, b) => {
      if (a === 'Ungrouped') return 1;
      if (b === 'Ungrouped') return -1;
      return a.localeCompare(b);
    });

    folderNames.forEach((folder) => {
      const collapsed = collapseState[folder] === true;
      const header = el('div', { class: 'rgnf-row' });
      header.style.cssText = 'user-select:none;align-items:center;gap:6px;font-weight:600;';
      const label = el('span', { text: (collapsed ? '▸' : '▾') + ' 📁 ' + folder + ` (${groups[folder].length})` });
      label.style.cssText = 'cursor:pointer;flex:1;';
      label.onclick = () => {
        collapseState[folder] = !collapsed;
        saveJSON(collapseKey, collapseState);
        render(panel);
      };
      header.appendChild(label);
      // "Ungrouped" is synthetic, nothing to rename
      if (folder !== 'Ungrouped') {
        header.appendChild(el('button', {
          class: 'rgnf-chip', text: '✏️', title: 'Rename folder',
          onclick: () => {
            openFolderPicker(panel, {
              title: 'Rename folder "' + folder + '"',
              nameField: true,
              nameOnly: true,
              nameDefault: folder,
              existing: [],
              current: '',
              onPick: ({ name: newName }) => {
                const nn = (newName || '').trim();
                if (!nn || nn === folder) return;
                presets.forEach(pr => { if ((pr.folder || 'Ungrouped') === folder) pr.folder = nn; });
                if (collapseState[folder] !== undefined) {
                  collapseState[nn] = collapseState[folder];
                  delete collapseState[folder];
                  saveJSON(collapseKey, collapseState);
                }
                saveJSON(presetKey(), presets);
                render(panel);
              },
            });
          },
        }));
        // no "delete folder", folders are derived from membership
      }
      listWrap.appendChild(header);

      if (!collapsed) {
        groups[folder].forEach(({ p, idx }) => {
          const row = el('div', { class: 'rgnf-preset' });
          row.style.marginLeft = '10px';
          row.appendChild(el('span', { text: p.label, title: p.label }));
          row.appendChild(el('button', {
            class: 'rgnf-chip',
            text: 'Load',
            onclick: () => {
              applyLoadedForgeName(p.state);
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '✏️', title: 'Rename preset',
            onclick: () => {
              openFolderPicker(panel, {
                title: 'Rename preset "' + p.label + '"',
                nameField: true,
                nameOnly: true,
                nameDefault: p.label,
                existing: [],
                current: '',
                onPick: ({ name }) => {
                  const nextLabel = String(name || '').trim();
                  if (!nextLabel || nextLabel === p.label) return;
                  if (presets.some((candidate, candidateIdx) =>
                    candidateIdx !== idx && candidate.label === nextLabel)) {
                    alert('A preset with that name already exists.');
                    return;
                  }
                  presets[idx].label = nextLabel;
                  saveJSON(presetKey(), presets);
                  render(panel);
                },
              });
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '📁', title: 'Move to folder',
            onclick: () => {
              openFolderPicker(panel, {
                title: 'Move "' + p.label + '" to folder',
                existing: folderNames,
                current: p.folder || '',
                onPick: (dest) => {
                  presets[idx].folder = dest || undefined;
                  saveJSON(presetKey(), presets);
                  render(panel);
                },
              });
            },
          }));
          row.appendChild(el('button', {
            class: 'rgnf-chip', text: '🗑️', title: 'Delete preset',
            onclick: () => { presets.splice(idx, 1); saveJSON(presetKey(), presets); render(panel); },
          }));
          listWrap.appendChild(row);
        });
      }
    });

    listWrap.appendChild(el('button', {
      class: 'rgnf-chip', text: '+ Save current as preset',
      onclick: () => {
        const snap = JSON.parse(JSON.stringify(state));
        // rawCode wins: state.name can be stale (leftover from a prior nickname
        // or a name-field click) so re-derive the plain-text name from raw
        // before saving. Otherwise stolen presets export with the current
        // in-game nickname baked in. Clan tag stays on the checkbox, not the preset.
        if (snap.rawCode) {
          snap.rawCode = _stripTag(snap.rawCode);
          snap.name = editableFieldsFromRaw(snap.rawCode).name;
          snap.colorSpans = [];
        }
        const defaultName = (snap.name || state.name).replace(/<[^>]*>/g, '').slice(0, 30) || 'Preset';
        openFolderPicker(panel, {
          title: 'Save preset',
          nameField: true,
          nameDefault: defaultName,
          existing: folderNames,
          current: '',
          onPick: ({ name: label, folder }) => {
            if (!label) return;
            const entry = { label, state: snap };
            if (folder) entry.folder = folder;
            const existingIdx = presets.findIndex(x => x.label === label);
            if (existingIdx >= 0) {
              const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
              if (replace) presets[existingIdx] = entry;
              else { entry.label = label + ' (2)'; presets.push(entry); }
            } else {
              presets.push(entry);
            }
            saveJSON(presetKey(), presets);
            render(panel);
          },
        });
      },
    }));
    secPresets.appendChild(listWrap);

    // export/import for sharing — file-based so presets survive a paste round-trip
    secPresets.appendChild(el('div', { class: 'rgnf-row' }, [
      el('button', {
        class: 'rgnf-chip', text: '📤 Export', title: 'Download all presets as a .json file',
        onclick: (e) => {
          const b = e.currentTarget;
          try {
            // deep-clone and re-derive state.name from rawCode so old presets
            // saved before the fix don't leak whatever nickname was in state
            // at save time.
            const exportPresets = presets.map((p) => {
              const clone = JSON.parse(JSON.stringify(p));
              if (clone?.state?.rawCode) {
                clone.state.name = editableFieldsFromRaw(clone.state.rawCode).name;
              }
              return clone;
            });
            const payload = {
              schema: 'atlas.nameforge.presets',
              version: 1,
              exportedAt: new Date().toISOString(),
              count: exportPresets.length,
              presets: exportPresets,
            };
            const stamp = new Date().toISOString().slice(0, 10);
            const url = URL.createObjectURL(new Blob(
              [JSON.stringify(payload, null, 2) + '\n'],
              { type: 'application/json;charset=utf-8' },
            ));
            const link = document.createElement('a');
            link.href = url;
            link.download = `atlas-nameforge-presets-${stamp}.json`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            b.textContent = 'Downloaded ✓';
          } catch (err) { b.textContent = 'Failed'; }
          setTimeout(() => { b.textContent = '📤 Export'; }, 1200);
        },
      }),
      el('button', {
        class: 'rgnf-chip', text: '📥 Import', title: 'Import presets from a .json file',
        onclick: (e) => {
          const b = e.currentTarget;
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.style.display = 'none';
          input.onchange = async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
              const text = await file.text();
              const parsed = JSON.parse(text);
              // accept wrapped {schema,presets:[...]} and legacy bare array
              const incoming = Array.isArray(parsed)
                ? parsed
                : (parsed && Array.isArray(parsed.presets) ? parsed.presets : null);
              if (!incoming) throw new Error('no presets array');
              const clean = incoming.filter(p => p && p.label && p.state);
              if (!clean.length) throw new Error('no valid presets');
              const merged = presets.concat(clean);
              saveJSON(presetKey(), merged);
              b.textContent = `Imported ${clean.length} ✓`;
              setTimeout(() => { b.textContent = '📥 Import'; render(panel); }, 900);
            } catch (err) {
              alert('That JSON was as valid as a screen-door submarine. Import failed.');
            }
          };
          document.body.appendChild(input);
          input.click();
        },
      }),
    ]));

    // last 5 applies. 💾 promotes to a permanent preset before it rotates out.
    const hist = loadJSON(historyKey(), []);
    if (hist.length) {
      secPresets.appendChild(el('h4', { text: 'Recently applied (auto — newest 5 only)' }));
      const histWrap = el('div', { class: 'rgnf-presets' });
      hist.forEach((h) => {
        const recentPreview = el('span', { title: h.code });
        recentPreview.style.cssText = 'flex:1;overflow:hidden;max-height:44px;white-space:normal;';
        recentPreview.appendChild(renderRawTMP(String(h.code || '')));
        const recentCode = () => {
          let code = _stripTag(h.rawCode || h.code);
          const pfx = _prefix();
          if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
          return code;
        };
        recentPreview.style.cursor = 'pointer';
        recentPreview.title = (h.code || '') + ' — click to load in preview';
        recentPreview.onclick = () => applyLoadedForgeName(recentCode());
        histWrap.appendChild(el('div', { class: 'rgnf-preset' }, [
          recentPreview,
          el('button', {
            class: 'rgnf-chip', text: 'Load', title: 'Show this name in the preview',
            onclick: () => applyLoadedForgeName(recentCode()),
          }),
          el('button', {
            class: 'rgnf-chip', text: '💾', title: 'Save this as a permanent preset',
            onclick: () => {
              // strip the clan-tag prefix, the checkbox owns it
              let code = _stripTag(h.rawCode || h.code);
              const pfx = _prefix();
              if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
              const snap = Object.assign(defaultState(), { rawCode: code });
              // seed name from raw so the exported preset carries the actual
              // stolen name, not defaultState().name.
              snap.name = editableFieldsFromRaw(code).name;
              openFolderPicker(panel, {
                title: 'Save preset',
                nameField: true,
                nameDefault: h.plain.slice(0, 30) || 'Preset',
                existing: folderNames,
                current: '',
                onPick: ({ name: label, folder }) => {
                  if (!label) return;
                  const entry = { label, state: snap };
                  if (folder) entry.folder = folder;
                  const existingIdx = presets.findIndex(x => x.label === label);
                  if (existingIdx >= 0) {
                    const replace = confirm('A preset named "' + label + '" already exists.\nOK = replace it, Cancel = keep both.');
                    if (replace) presets[existingIdx] = entry;
                    else { entry.label = label + ' (2)'; presets.push(entry); }
                  } else {
                    presets.push(entry);
                  }
                  saveJSON(presetKey(), presets);
                  render(panel);
                },
              });
            },
          }),
          el('button', {
            class: 'rgnf-chip', text: 'Re-apply',
            onclick: async (e) => {
              const b = e.currentTarget;
              b.textContent = '…';
              try {
                let code = _stripTag(h.rawCode || h.code);
                const pfx = _prefix();
                if (pfx && code.startsWith(pfx)) code = code.slice(pfx.length);
                setRawSnapshot(code);
                const unprefixed = effectiveForgeCode(state);
                const codeApplied = pfx + unprefixed;
                const r = await applyNicknameStable(codeApplied, unprefixed);
                if (r.ok) {
                  // load what was applied into preview so the screen matches live
                  _lastRawNickname = unprefixed;
                  recordRecentApply(codeApplied, unprefixed);
                  render(panel);
                  return;
                }
                b.textContent = '✗';
              } catch (err) { b.textContent = '✗'; }
              setTimeout(() => { b.textContent = 'Re-apply'; }, 1500);
            },
          }),
        ]));
      });
      histWrap.appendChild(el('button', {
        class: 'rgnf-chip', text: 'Clear history',
        onclick: () => { saveJSON(historyKey(), []); render(panel); },
      }));
      secPresets.appendChild(histWrap);
    }
    panel.appendChild(secPresets);

    // ---- Actions ----
    const secActions = el('div', { class: 'rgnf-sec rgnf-actions-sec' });
    const statusLine = el('div', { class: 'rgnf-status' });
    const applyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-apply', text: 'Apply nickname',
      title: 'Apply nickname (Ctrl/Cmd+Enter)',
      onclick: async () => {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
        statusLine.className = 'rgnf-status';
        statusLine.textContent = '';
        try {
          const unprefixedCode = _stripTag(effectiveForgeCode(state));
          const codeApplied = _prefix() + unprefixedCode;
          // reset target is unprefixed, checkbox owns the tag (double-tag fix)
          _lastRawNickname = unprefixedCode;
          const result = await applyNicknameStable(codeApplied, _lastRawNickname);
          if (result.ok) {
            recordRecentApply(codeApplied, _lastRawNickname);
            render(panel);
            const refreshedStatus = panel.querySelector('.rgnf-status');
            if (refreshedStatus) {
              refreshedStatus.className = 'rgnf-status ok';
              refreshedStatus.textContent = '✓ Nickname updated';
            }
          } else {
            statusLine.className = 'rgnf-status err';
            statusLine.textContent = `✗ ${result.status}: ${result.body.slice(0, 120)}`;
          }
        } catch (e) {
          statusLine.className = 'rgnf-status err';
          statusLine.textContent = `✗ ${e.message}`;
        } finally {
          applyBtn.disabled = false;
          applyBtn.textContent = 'Apply nickname';
        }
      },
    });
    const copyBtn = el('button', {
      class: 'rgnf-btn rgnf-btn-ghost', text: 'Copy code',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(_prefix() + effectiveForgeCode(state));
          showTempFeedback(copyBtn, 'Copied ✓', 1200, 'Copy code');
        } catch (e) {
          showTempFeedback(copyBtn, 'Copy failed', 1200, 'Copy code');
        }
      },
    });
    secActions.appendChild(el('div', { class: 'rgnf-row' }, [applyBtn, copyBtn]));
    secActions.appendChild(statusLine);
    panel.appendChild(secActions);
    restoreForgeScroll(savedScroll);
    syncForgeHistoryButtons(panel);
  }

  function sliderRow(panel, label, key, min, max, unit) {
    const row = el('div', { class: 'rgnf-row' });
    row.appendChild(el('label', { text: label }));
    row.appendChild(el('input', {
      type: 'range', min, max, value: state[key],
      oninput: (e) => {
        state[key] = Number(e.target.value);
        row.querySelector('.rgnf-val').textContent = state[key] + unit;
      },
      onchange: () => render(panel),
    }));
    row.appendChild(el('span', { class: 'rgnf-val', text: state[key] + unit }));
    return row;
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + 'px';
      panel.style.top = (oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  // ------------------------------------------------------------------
  // Input capture guard — MUST register before the game's handlers.
  // rocketgoal.io binds control keys at window capture and preventDefaults them.
  // We run at document-start, register first, and stopImmediatePropagation
  // for events aimed at our UI so the game never sees them.
  // ------------------------------------------------------------------
  function installInputGuard() {
    const inUI = (t) => t && t.closest && (t.closest('.rgnf-panel') || t.closest('.rgnf-fab'));
    const isTextField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

    // we take over editing for our own fields, mutate value ourselves and
    // fire a synthetic input event. works no matter what the game does.
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!inUI(t)) return;
      if (e.altKey && e.code === 'KeyN') return; // let the global toggle through

      // always hide the event from the game's global handlers
      e.stopImmediatePropagation();

      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'Enter') {
        e.preventDefault();
        const apply = t.closest('.rgnf-panel')?.querySelector('.rgnf-btn-apply');
        if (apply && !apply.disabled) apply.click();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redoForge();
        else undoForge();
        return;
      }

      if (!isTextField(t) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;

      const start = t.selectionStart ?? t.value.length;
      const end = t.selectionEnd ?? t.value.length;
      let handled = false;

      if (e.key.length === 1) {
        // printable char (browser already handled shift/case)
        t.value = t.value.slice(0, start) + e.key + t.value.slice(end);
        const p = start + 1; t.setSelectionRange(p, p); handled = true;
      } else if (e.key === 'Backspace') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else if (start > 0) { t.value = t.value.slice(0, start - 1) + t.value.slice(end); t.setSelectionRange(start - 1, start - 1); }
        handled = true;
      } else if (e.key === 'Delete') {
        if (start !== end) { t.value = t.value.slice(0, start) + t.value.slice(end); t.setSelectionRange(start, start); }
        else { t.value = t.value.slice(0, start) + t.value.slice(end + 1); t.setSelectionRange(start, start); }
        handled = true;
      }
      // arrows/home/end/tab fall through, browser caret still works
      if (handled) {
        e.preventDefault();
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, true);

    // keep keyup/keypress away from the game too
    ['keyup', 'keypress'].forEach((evt) => {
      window.addEventListener(evt, (e) => {
        const t = e.target;
        if (!inUI(t)) return;
        if (e.altKey && e.code === 'KeyN') return;
        e.stopImmediatePropagation();
      }, true);
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  installInputGuard();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }
      let _mountedIn = null;
      // HUD sets this to getClanTagPrefix so Forge stays clan-agnostic
      let _prefixProvider = null;
      // HUD sets this to a function returning "name" | "title" so the tag
      // can attach to either. Defaults to "name" for backward compat.
      let _prefixTargetProvider = null;
      function _prefixTargetFor() {
        try { return _prefixTargetProvider ? _prefixTargetProvider() : "name"; }
        catch { return "name"; }
      }
      function _prefix(target) {
        // Called with no arg = "name" position (all legacy call sites). If the
        // user picked "title" as tag position, name-targeted callers get "" so
        // the tag isn't double-prepended; the composer inserts it into the
        // title instead via _prefix("title").
        const wanted = target || "name";
        if (_prefixTargetFor() !== wanted) return "";
        try { return _prefixProvider ? _prefixProvider() : ""; } catch { return ""; }
      }
      let _tagStripper = null;
      function _stripTag(raw) {
        try { return _tagStripper ? _tagStripper(raw) : String(raw ?? ""); }
        catch { return String(raw ?? ""); }
      }
      // HUD supplies last game's names (raw TMP, own name filtered)
      let _rosterProvider = null;
      function _roster() { try { return _rosterProvider ? _rosterProvider() : []; } catch { return []; } }
      return {
        setPrefixProvider(fn) { _prefixProvider = fn; },
        setPrefixTargetProvider(fn) { _prefixTargetProvider = fn; },
        setTagStripper(fn) { _tagStripper = fn; },
        setRosterProvider(fn) { _rosterProvider = fn; },
        // HUD calls this from /login response too, not just Forge open.
        // fixes the "steal, refresh, receipt expires before Forge opens" case.
        verifyStolenName(rawNickname) { verifyPendingSteal(rawNickname); },
        refresh() { if (_rgnfPanel) render(_rgnfPanel); },
        // called on Forge open and on account switch. per-account state wins;
        // otherwise seed from the current account's live nickname (no cross-account leak).
        syncToCurrentPlayer(userId, displayName, rawNickname) {
          if (!userId) return;
          if (rawNickname) _lastRawNickname = String(rawNickname);
          const prevId = _currentUserId;
          _currentUserId = userId;
          // must run BEFORE the same-account early return. verification fires
          // on every boot, not just account switches (inner latch makes repeat calls cheap).
          verifyPendingSteal(rawNickname);
          if (prevId !== userId) {
            const perUser = loadJSON(stateKey(), null);
            if (perUser) {
              loadStateSnapshot(perUser);
            } else if (rawNickname) {
              // First time on this account: show the live nameplate.
              // Later opens keep the saved draft (including highlight / paint).
              state = defaultState();
              setRawSnapshot(_stripTag(String(rawNickname)));
              namePaintSel = { start: 0, end: 0 };
              saveJSON(stateKey(), state);
            } else {
              state = defaultState();
              if (displayName) state.name = String(displayName).trim();
              saveJSON(stateKey(), state);
            }
            resetForgeHistory();
          }
          // Same account: do not overwrite with the live nameplate. That
          // flipped the editor into raw TMP and dropped highlight / paint
          // after a game. ↺ and applyLoadedForgeName still load on demand.

          // render unconditionally. panel DOM exists from page load, and sync
          // runs before mountIn on first open — gating on _mountedIn would
          // strand the swapped state off-screen.
          if (_rgnfPanel) render(_rgnfPanel);
        },
        // re-parent the panel into the HUD tab; scroll lives on the container
        mountIn(container) {
          if (!_rgnfPanel || _mountedIn === container) return;
          _rgnfPanel.style.position = 'static';
          _rgnfPanel.style.transform = 'none';
          _rgnfPanel.style.left = _rgnfPanel.style.top = _rgnfPanel.style.right = _rgnfPanel.style.bottom = '';
          _rgnfPanel.style.width = '100%';
          _rgnfPanel.style.maxWidth = '100%';
          _rgnfPanel.style.maxHeight = 'none';
          _rgnfPanel.style.overflow = 'visible';
          _rgnfPanel.style.padding = '8px 10px';
          _rgnfPanel.style.border = 'none';
          _rgnfPanel.style.boxShadow = 'none';
          _rgnfPanel.style.background = 'transparent';
          _rgnfPanel.style.display = 'block';
          _rgnfPanel.classList.remove('rgnf-open');
          container.appendChild(_rgnfPanel);
          _mountedIn = container;
        },
      };

}
