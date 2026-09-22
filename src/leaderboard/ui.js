
// ---------- Leaderboard opponent popup ----------
// slides in when a match starts against someone in the leaderboard cache.
// cache + config live in their own localStorage keys so the existing
// near-real-time rank stuff is untouched.

export const RG_LB_CACHE_KEY_LEGACY = "rgHudLbCache_v1";

export const RG_LB_CACHE_KEY_PREFIX = "rgHudLbCache_v4";

export const RG_LB_CONFIG_KEY = "rgHudRemoteConfig_v1";

export const RG_LB_CONFIG_TTL_MS = 60 * 60 * 1000;

export const RG_LB_MODES = ["Competitive1v1", "Competitive2v2", "Competitive3v3"];

// leaderboard docs store playlist as "1v1"/"2v2"/"3v3", not the mode name
export const RG_LB_MODE_TO_PLAYLIST = { Competitive1v1: "1v1", Competitive2v2: "2v2", Competitive3v3: "3v3" };

export const RG_LB_TOP_N = 100;

export const STREAK_SNIPE_MIN = 3;

export const RG_LB_DEFAULT_CONFIG = {
    popupDurationMs: 6000,
    popupEnabled: true,
    cacheRefreshHours: 3,
    minRankToShow: 100,
    streakSnipeMin: STREAK_SNIPE_MIN,
    // Remote flag: prefer leaderboard_cache/{playlist} (1 read) when true.
    useLeaderboardCache: false,
};

export const RANKED_POPUP_PREFERENCES = Object.freeze({
    popupShowOpponents: true,
    popupShowTeammates: true,
    popupMaxRank: 100,
    popupDurationMs: 0,
    popupPosition: "top-right",
});

export const OPPONENT_STREAK_CACHE_KEY = "rgHudOpponentStreak_v1";


export const REAL_LEADERBOARD_COLLECTION = "leaderboard";

export const LEADERBOARD_CACHE_COLLECTION = "leaderboard_cache";


export function ensureLbPopupStyles() {
    if (document.getElementById("rgLbPopupStyle")) return;
    const style = document.createElement("style");
    style.id = "rgLbPopupStyle";
    style.textContent = `
#rgLbPopupStack {
  position: fixed; top: 20px; right: 20px;
  display: flex; flex-direction: column; gap: 10px;
  z-index: 999999998; pointer-events: none;
}
.rg-lb-popup {
  width: 300px;
  background: linear-gradient(180deg, rgba(28,43,58,0.96), rgba(13,20,27,0.96));
  border: 1px solid #00bfff;
  border-radius: 10px;
  padding: 12px 14px;
  color: #d7f3ff;
  font-family: Arial, sans-serif;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,191,255,0.15), 0 0 24px rgba(0,191,255,0.25);
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateX(24px) translateY(-4px);
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(.16,.9,.28,1.15);
  pointer-events: auto;
}
.rg-lb-popup.show { opacity: 1; transform: translateX(0) translateY(0); }
.rg-lb-popup::before {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 12px var(--tier-color, #00bfff);
}
.rg-lb-header {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: bold;
  color: var(--tier-color, #00bfff);
  letter-spacing: 1.4px; text-transform: uppercase;
  margin-bottom: 8px;
  text-shadow: 0 0 8px var(--tier-color, #00bfff);
}
.rg-lb-header .rg-lb-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--tier-color, #00bfff);
  box-shadow: 0 0 8px var(--tier-color, #00bfff);
  animation: rg-lb-pulse 1.6s ease-in-out infinite;
}
@keyframes rg-lb-pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50% { opacity: .5; transform: scale(.85); }
}
.rg-lb-body { display: flex; align-items: center; gap: 12px; }
.rg-lb-rank {
  flex: 0 0 auto; min-width: 58px; height: 58px; padding: 0 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.15));
  border: 2px solid var(--tier-color, #00bfff);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: inset 0 0 12px rgba(0,0,0,0.4);
}
.rg-lb-rank .rg-lb-hash {
  font-size: 10px; color: var(--tier-color, #00bfff);
  line-height: 1; opacity: .8; margin-bottom: 2px; font-weight: bold;
}
.rg-lb-rank .rg-lb-num {
  font-size: 22px; font-weight: 900;
  color: var(--tier-color, #00bfff);
  line-height: 1;
  font-family: "SF Mono", Consolas, monospace;
  letter-spacing: -1px;
}
.rg-lb-info { flex: 1 1 auto; min-width: 0; }
.rg-lb-name {
  font-size: 15px; font-weight: bold; color: #ffffff;
  line-height: 1.2;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 180px;
}
.rg-lb-mode {
  display: inline-block; margin-top: 4px; padding: 2px 8px;
  font-size: 10px; font-weight: bold; letter-spacing: .5px;
  background: rgba(0,191,255,0.12);
  border: 1px solid #00bfff88;
  color: #00bfff;
  border-radius: 999px;
}
.rg-lb-streak {
  margin-top: 6px; color: #ffb020; font-size: 11px; font-weight: 900;
  letter-spacing: .7px; text-transform: uppercase;
  text-shadow: 0 0 10px rgba(255,176,32,.55);
}
.rg-lb-teammate {
  margin-top: 10px; padding-top: 8px;
  border-top: 1px solid rgba(0,191,255,0.15);
  font-size: 11px; color: #a8c3d3;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.rg-lb-teammate .rg-lb-lbl { opacity: .7; text-transform: uppercase; letter-spacing: 1px; font-size: 9px; }
.rg-lb-teammate .rg-lb-tname {
  color: #fff; font-weight: bold; max-width: 140px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rg-lb-teammate .rg-lb-trank {
  padding: 1px 6px; border-radius: 4px; font-weight: bold; font-size: 10px;
  background: rgba(0,0,0,0.35);
}
@media (prefers-reduced-motion: reduce) {
  .rg-lb-popup { transition: none; transform: none; }
  .rg-lb-header .rg-lb-dot { animation: none; }
}
`;
    document.head.appendChild(style);
}


export function showLbOpponentPopup({ rank, name, mode, isTeammate, winStreak, config, preferences }) {
    try {
        const cfg = config || RG_LB_DEFAULT_CONFIG;
        const prefs = normalizePopupPreferences(
            preferences || RANKED_POPUP_PREFERENCES
        );
        if (!rankedPopupAllowed(rank, isTeammate, cfg, prefs)) return;
        ensureLbPopupStyles();
        const dur = rankedPopupDuration(cfg, prefs);
        let stack = document.getElementById("rgLbPopupStack");
        if (!stack) {
            stack = document.createElement("div");
            stack.id = "rgLbPopupStack";
            document.body.appendChild(stack);
        }
        Object.assign(stack.style, popupStackPositionStyle(prefs.position));
        stack.dataset.position = prefs.position;
        const el = document.createElement("div");
        el.className = "rg-lb-popup";
        el.style.setProperty("--tier-color", tierColorForRank(rank));
        el.dataset.rank = String(rank);
        el.dataset.role = isTeammate === true ? "teammate" : isTeammate === false ? "opponent" : "player";
        const headerLabel = isTeammate === true ? "LEADERBOARD TEAMMATE"
                          : isTeammate === false ? "LEADERBOARD OPPONENT"
                          : "LEADERBOARD PLAYER";
        const safeStreak = isTeammate === false
            ? Math.max(0, Math.trunc(Number(winStreak) || 0))
            : 0;
        const streakHtml = safeStreak > 0
            ? `<div class="rg-lb-streak">🔥 ${safeStreak} win streak</div>`
            : "";
        el.innerHTML = `
            <div class="rg-lb-header"><span class="rg-lb-dot"></span>${headerLabel}</div>
            <div class="rg-lb-body">
                <div class="rg-lb-rank">
                    <div class="rg-lb-hash">RANK</div>
                    <div class="rg-lb-num">#${rank}</div>
                </div>
                <div class="rg-lb-info">
                    <div class="rg-lb-name">${escapeHtml(name)}</div>
                    <div class="rg-lb-mode">${modeLabel(mode)}</div>
                    ${streakHtml}
                </div>
            </div>
        `;
        stack.appendChild(el);
        requestAnimationFrame(() => el.classList.add("show"));
        setTimeout(() => {
            el.classList.remove("show");
            setTimeout(() => el.remove(), prefersReducedPopupMotion() ? 0 : 320);
        }, dur);
    } catch (e) {
        dbg("showLbOpponentPopup threw: " + getErrMsg(e));
    }
}


export function ensureStreakSnipeStyles() {
    if (document.getElementById("rgStreakSnipeStyle")) return;
    const style = document.createElement("style");
    style.id = "rgStreakSnipeStyle";
    style.textContent = `
@keyframes rgSnipeOverlay {
  0% { opacity: 0; }
  4%, 96.5% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes rgSnipeLens {
  0% { opacity: 0; transform: scale(1.45); filter: blur(6px); }
  8%, 88% { opacity: 1; transform: scale(1); filter: blur(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
@keyframes rgSnipeSway {
  0%, 4% { transform: translate(12px,-9px) rotate(-1.2deg); }
  10% { transform: translate(-9px,7px) rotate(.9deg); }
  16% { transform: translate(5px,-4px) rotate(-.5deg); }
  22% { transform: translate(-2px,2px) rotate(.2deg); }
  28%, 100% { transform: translate(0,0) rotate(0); }
}
@keyframes rgSnipeCompass {
  0%, 3% { opacity: 0; }
  6%, 29% { opacity: 1; }
  34%, 100% { opacity: 0; }
}
@keyframes rgSnipeBreath {
  0%, 3% { opacity: 0; }
  6%, 29% { opacity: 1; }
  34%, 100% { opacity: 0; }
}
@keyframes rgSnipeBreathDrain {
  0%, 6% { transform: scaleX(1); }
  29%, 100% { transform: scaleX(.06); }
}
@keyframes rgSnipeMuzzle {
  0%, 29% { opacity: 0; transform: scale(.35); }
  31% { opacity: .98; transform: scale(1.18); }
  35%, 100% { opacity: 0; transform: scale(1.65); }
}
@keyframes rgSnipeKick {
  0%, 29% { transform: translateY(0) rotate(0); }
  32% { transform: translateY(-34px) rotate(-2.8deg); }
  39% { transform: translateY(5px) rotate(.5deg); }
  44%, 100% { transform: translateY(0) rotate(0); }
}
@keyframes rgSnipeHit {
  0%, 33% { opacity: 0; transform: scale(.55); }
  36% { opacity: 1; transform: scale(1.35); }
  41% { opacity: 1; transform: scale(1); }
  48%, 100% { opacity: 0; }
}
@keyframes rgSnipeFinishRing {
  0%, 36% { opacity: 0; transform: scale(1.65) rotate(14deg); }
  43% { opacity: .95; transform: scale(.96) rotate(0); }
  96.5% { opacity: .72; transform: scale(1) rotate(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
@keyframes rgSnipeFinishCard {
  0%, 39.5% { opacity: 0; transform: scale(.84); filter: blur(8px); }
  45%, 96.5% { opacity: 1; transform: scale(1); filter: blur(0); }
  100% { opacity: 0; transform: scale(1.04); }
}
#rgStreakSnipe {
  position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  display: grid; place-items: center; overflow: hidden;
  background:
radial-gradient(circle at center, rgba(34,211,238,.07), transparent 42%),
rgba(2,6,12,.96);
  animation: rgSnipeOverlay 7.2s ease forwards;
}
#rgStreakSnipe .rg-snipe-vignette {
  position: absolute; inset: -4%;
  background: radial-gradient(circle at center, transparent 0 34%, rgba(2,6,12,.28) 48%, #010308 72%);
}
#rgStreakSnipe .rg-snipe-compass {
  position: absolute; top: 8%; left: 50%; z-index: 7;
  display: flex; gap: 18px; transform: translateX(-50%);
  color: rgba(174,184,196,.52);
  font: 800 10px/1 "IBM Plex Mono","SF Mono",Menlo,monospace;
  letter-spacing: .18em; animation: rgSnipeCompass 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-kick {
  position: absolute; inset: 0; display: grid; place-items: center;
  animation: rgSnipeKick 7.2s cubic-bezier(.2,.7,.2,1) both;
}
#rgStreakSnipe .rg-snipe-lens {
  position: relative; width: min(72vmin,720px); aspect-ratio: 1; border-radius: 50%;
  display: grid; place-items: center; overflow: hidden;
  border: 1.5px solid rgba(174,184,196,.46);
  background: radial-gradient(circle at 42% 34%, rgba(255,255,255,.05), transparent 44%), rgba(7,11,18,.44);
  box-shadow: inset 0 0 90px rgba(0,0,0,.62), 0 0 70px rgba(0,0,0,.5);
  animation: rgSnipeLens 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-sway {
  position: absolute; inset: 0; display: grid; place-items: center;
  animation: rgSnipeSway 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-cross-h,
#rgStreakSnipe .rg-snipe-cross-v {
  position: absolute; background: rgba(230,235,240,.78);
  box-shadow: 0 0 10px rgba(230,235,240,.2);
}
#rgStreakSnipe .rg-snipe-cross-h { width: 30%; height: 1px; }
#rgStreakSnipe .rg-snipe-cross-v { width: 1px; height: 30%; }
#rgStreakSnipe .rg-snipe-hit {
  position: absolute; width: 24px; height: 24px; z-index: 8;
  animation: rgSnipeHit 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-hit::before,
#rgStreakSnipe .rg-snipe-hit::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 16px; height: 2px; background: #d64545;
  box-shadow: 0 0 12px rgba(214,69,69,.7);
}
#rgStreakSnipe .rg-snipe-hit::before { transform: translate(-50%,-50%) rotate(45deg); }
#rgStreakSnipe .rg-snipe-hit::after { transform: translate(-50%,-50%) rotate(-45deg); }
#rgStreakSnipe .rg-snipe-muzzle {
  position: absolute; z-index: 6; width: min(66vmin,620px); aspect-ratio: 1; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,.98) 0 5%, rgba(255,176,32,.48) 16%, transparent 55%);
  animation: rgSnipeMuzzle 7.2s ease-out both;
}
#rgStreakSnipe .rg-snipe-breath {
  position: absolute; left: 50%; bottom: 9%; z-index: 8;
  width: min(310px,70vw); transform: translateX(-50%);
  color: #7dd3c0; text-align: center;
  font: 800 10px/1 "IBM Plex Mono","SF Mono",Menlo,monospace;
  letter-spacing: .2em; text-transform: uppercase;
  animation: rgSnipeBreath 7.2s ease both;
}
#rgStreakSnipe .rg-snipe-breath-track {
  display: block; height: 2px; margin-top: 10px; overflow: hidden;
  background: rgba(125,211,192,.18);
}
#rgStreakSnipe .rg-snipe-breath-track::after {
  content: ""; display: block; width: 100%; height: 100%;
  transform-origin: left; background: #7dd3c0; box-shadow: 0 0 12px rgba(125,211,192,.65);
  animation: rgSnipeBreathDrain 7.2s linear both;
}
#rgStreakSnipe .rg-snipe-finish {
  position: absolute; inset: 0; z-index: 9;
  display: grid; place-items: center;
}
#rgStreakSnipe .rg-snipe-finish > * { grid-area: 1 / 1; }
#rgStreakSnipe .rg-snipe-finish-ring {
  position: relative; width: min(48vw,460px); aspect-ratio: 1;
  border: 1.5px solid rgba(34,211,238,.78); border-radius: 50%;
  box-shadow: 0 0 50px rgba(34,211,238,.18), inset 0 0 40px rgba(34,211,238,.08);
  animation: rgSnipeFinishRing 7.2s cubic-bezier(.2,.8,.2,1) both;
}
#rgStreakSnipe .rg-snipe-finish-ring::before,
#rgStreakSnipe .rg-snipe-finish-ring::after {
  content: ""; position: absolute; border-radius: 50%;
}
#rgStreakSnipe .rg-snipe-finish-ring::before {
  inset: 16%; border: 1px dashed rgba(34,211,238,.3);
}
#rgStreakSnipe .rg-snipe-finish-ring::after {
  inset: 47% -14%; border-top: 1px solid rgba(34,211,238,.75);
  border-bottom: 1px solid rgba(34,211,238,.75);
}
#rgStreakSnipe .rg-snipe-card {
  position: relative; width: min(700px,84vw); padding: clamp(28px,4vw,48px);
  color: #f8fafc; text-align: center; border: 1px solid rgba(34,211,238,.65);
  background: rgba(3,10,20,.92);
  box-shadow: 0 0 0 1px rgba(255,255,255,.04), 0 0 70px rgba(34,211,238,.2);
  animation: rgSnipeFinishCard 7.2s cubic-bezier(.16,.9,.28,1.05) both;
}
#rgStreakSnipe .rg-snipe-kicker {
  color: #67e8f9; font: 900 12px/1.2 Arial,sans-serif;
  letter-spacing: .28em; text-transform: uppercase;
}
#rgStreakSnipe .rg-snipe-title {
  max-width: 100%; margin-top: 14px; color: #fff;
  font: 900 clamp(28px,5vw,56px)/1.02 Arial,sans-serif;
  overflow-wrap: anywhere; word-break: break-word;
  text-shadow: 0 0 26px rgba(255,255,255,.2);
}
#rgStreakSnipe .rg-snipe-value {
  margin-top: 18px; color: #ffb020; font: 900 clamp(24px,4vw,44px)/1 Arial,sans-serif;
  letter-spacing: .04em; text-shadow: 0 0 26px rgba(255,176,32,.6);
}
#rgStreakSnipe .rg-snipe-foot {
  margin-top: 18px; color: #94a3b8; font: 800 12px/1 Arial,sans-serif;
  letter-spacing: .24em; text-transform: uppercase;
}
#rgStreakSnipe .rg-snipe-actions {
  margin-top: 26px; display: inline-flex; gap: 10px; flex-wrap: wrap;
  justify-content: center; opacity: 0;
  animation: rgSnipeFinishActions 7.2s cubic-bezier(.16,.9,.28,1.05) both;
}
#rgStreakSnipe .rg-snipe-action {
  pointer-events: auto; cursor: pointer;
  padding: 10px 18px; border-radius: 999px;
  font: 800 11px/1 Arial,sans-serif; letter-spacing: .18em; text-transform: uppercase;
  border: 1px solid; transition: transform .15s ease, background .15s ease, color .15s ease;
}
#rgStreakSnipe .rg-snipe-save {
  background: rgba(34,211,238,.16); border-color: rgba(34,211,238,.65); color: #67e8f9;
  text-shadow: 0 0 12px rgba(34,211,238,.4);
}
#rgStreakSnipe .rg-snipe-save:hover { background: rgba(34,211,238,.32); color: #fff; transform: translateY(-1px); }
#rgStreakSnipe .rg-snipe-save[disabled] { opacity: .6; cursor: default; transform: none; }
#rgStreakSnipe .rg-snipe-close {
  background: transparent; border-color: rgba(148,163,184,.35); color: #94a3b8;
}
#rgStreakSnipe .rg-snipe-close:hover { border-color: rgba(148,163,184,.65); color: #cbd5e1; }
@keyframes rgSnipeFinishActions {
  0%, 62% { opacity: 0; transform: translateY(6px); }
  70%, 96.5% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(0); }
}
@media (max-width: 560px) {
  #rgStreakSnipe .rg-snipe-lens { width: min(84vmin,520px); }
  #rgStreakSnipe .rg-snipe-finish-ring { width: min(78vw,420px); }
  #rgStreakSnipe .rg-snipe-card { width: 90vw; padding: 26px 18px; }
  #rgStreakSnipe .rg-snipe-kicker { font-size: 10px; letter-spacing: .2em; }
  #rgStreakSnipe .rg-snipe-foot { font-size: 10px; letter-spacing: .16em; }
  #rgStreakSnipe .rg-snipe-action { padding: 9px 14px; font-size: 10px; letter-spacing: .14em; }
}
@media (prefers-reduced-motion: reduce) {
  #rgStreakSnipe { animation-duration: 4.8s; }
  #rgStreakSnipe .rg-snipe-vignette,
  #rgStreakSnipe .rg-snipe-compass,
  #rgStreakSnipe .rg-snipe-kick,
  #rgStreakSnipe .rg-snipe-muzzle,
  #rgStreakSnipe .rg-snipe-breath { display: none; }
  #rgStreakSnipe .rg-snipe-finish-ring { animation: none; opacity: .55; }
  #rgStreakSnipe .rg-snipe-card {
animation: none; opacity: 1; transform: none; filter: none;
  }
}
`;
    document.head.appendChild(style);
}


export function showStreakSnipeOverlay({ playerName, streak }) {
    if (!document?.body) return;
    ensureStreakSnipeStyles();
    document.getElementById("rgStreakSnipe")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "rgStreakSnipe";
    const vignette = document.createElement("div");
    vignette.className = "rg-snipe-vignette";
    const muzzle = document.createElement("div");
    muzzle.className = "rg-snipe-muzzle";
    const compass = document.createElement("div");
    compass.className = "rg-snipe-compass";
    for (const direction of ["NW", "N", "NE"]) {
        const marker = document.createElement("span");
        marker.textContent = direction;
        compass.appendChild(marker);
    }
    const kick = document.createElement("div");
    kick.className = "rg-snipe-kick";
    const lens = document.createElement("div");
    lens.className = "rg-snipe-lens";
    const sway = document.createElement("div");
    sway.className = "rg-snipe-sway";
    const crossH = document.createElement("div");
    crossH.className = "rg-snipe-cross-h";
    const crossV = document.createElement("div");
    crossV.className = "rg-snipe-cross-v";
    const hit = document.createElement("div");
    hit.className = "rg-snipe-hit";
    sway.append(crossH, crossV, hit);
    lens.appendChild(sway);
    kick.appendChild(lens);
    const breath = document.createElement("div");
    breath.className = "rg-snipe-breath";
    breath.textContent = "Hold breath";
    const breathTrack = document.createElement("span");
    breathTrack.className = "rg-snipe-breath-track";
    breath.appendChild(breathTrack);
    const finish = document.createElement("div");
    finish.className = "rg-snipe-finish";
    const finishRing = document.createElement("div");
    finishRing.className = "rg-snipe-finish-ring";
    const card = document.createElement("div");
    card.className = "rg-snipe-card";
    const kicker = document.createElement("div");
    kicker.className = "rg-snipe-kicker";
    kicker.textContent = "Target streak eliminated";
    const title = document.createElement("div");
    title.className = "rg-snipe-title";
    title.textContent = `You sniped ${String(playerName || "an opponent")}`;
    const value = document.createElement("div");
    value.className = "rg-snipe-value";
    value.textContent = `${Math.max(1, Math.trunc(Number(streak) || 1))}-win streak ended`;
    const foot = document.createElement("div");
    foot.className = "rg-snipe-foot";
    foot.textContent = "Direct hit confirmed";
    const actions = document.createElement("div");
    actions.className = "rg-snipe-actions";
    const savePng = document.createElement("button");
    savePng.type = "button";
    savePng.className = "rg-snipe-action rg-snipe-save";
    savePng.textContent = "📸 Save PNG";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rg-snipe-action rg-snipe-close";
    closeBtn.textContent = "Close";
    actions.append(savePng, closeBtn);
    card.append(kicker, title, value, foot, actions);
    finish.append(finishRing, card);
    overlay.append(vignette, muzzle, compass, kick, breath, finish);
    document.body.appendChild(overlay);

    // Auto-dismiss unless the user reaches for a button. Hovering the card
    // pauses the timer so the fade-out doesn't start under someone's cursor.
    let removeTimer = setTimeout(
        () => overlay.remove(),
        prefersReducedPopupMotion() ? 4850 : 7250,
    );
    const holdOpen = () => {
        if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
        overlay.style.animation = "none";
        overlay.style.opacity = "1";
        card.style.animation = "none";
        card.style.opacity = "1";
        card.style.filter = "none";
        card.style.transform = "none";
        actions.style.animation = "none";
        actions.style.opacity = "1";
    };
    // Pointer events cascade — the overlay is non-interactive by default,
    // so a mouseenter on card would never fire. Instead, hovering either
    // button (which has pointer-events:auto) pauses the auto-dismiss.
    savePng.addEventListener("mouseenter", holdOpen);
    closeBtn.addEventListener("mouseenter", holdOpen);

    savePng.addEventListener("click", async () => {
        holdOpen();
        savePng.disabled = true;
        const original = savePng.textContent;
        savePng.textContent = "Rendering…";
        try {
            const { toPng } = await import("https://esm.sh/html-to-image@1.11.13");
            const dataUrl = await toPng(card, {
                backgroundColor: "#030a14",
                pixelRatio: 2,
                // Hide the action buttons in the saved image so it's clean
                // for sharing — the file is the celebration, not the UI.
                filter: (n) => !n.classList?.contains?.("rg-snipe-actions"),
            });
            const slug = String(playerName || "opponent")
                .replace(/[^\w-]+/g, "")
                .slice(0, 20) || "opponent";
            const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
            const a = document.createElement("a");
            a.href = dataUrl;
            a.download = `atlas-snipe-${slug}-x${Math.trunc(Number(streak) || 1)}-${stamp}.png`;
            a.click();
            savePng.textContent = "Saved ✓";
        } catch (e) {
            console.error("[RG HUD] snipe PNG export failed:", e);
            savePng.textContent = "Save failed — retry";
            savePng.disabled = false;
            return;
        }
        setTimeout(() => { savePng.textContent = original; savePng.disabled = false; }, 2200);
    });

    closeBtn.addEventListener("click", () => {
        if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
        overlay.remove();
    });
}


export function maybeShowStreakSnipe(prevRatings, nextRatings, opponents, config = _remoteConfigMemo) {
    if (settings.streakSnipeEnabled === false) return null;
    const candidates = streakSnipeCandidates(
        prevRatings,
        nextRatings,
        opponents,
        streakSnipeMinimum(config),
    );
    if (!candidates.length) return null;
    const target = candidates[0];
    dbg(`streak snipe: ended ${target.name}'s ${target.streak} win streak`);
    showStreakSnipeOverlay({
        playerName: target.name,
        streak: target.streak,
    });
    return target;
}


export function resetMatchPopupState() {
    _matchPopupGeneration++;
    _matchFormat = null;
    _matchPlayerCount = 0;
    _selfTeam = null;
    _shownPopupsThisMatch = new Set();
    _matchOpponentStreaks = new Map();
    _deferredMatch = null;
    _rosterFired = false;
    _rosterFiring = false;
    if (_rosterFireTimer) { clearTimeout(_rosterFireTimer); _rosterFireTimer = null; }
}


export function snapshotDeferredRoster() {
    _deferredMatch = {
        players: _liveRoster.map(player => ({ ...player })),
    };
}


// called when a real-uid roster entry lands. we wait until the full roster
// is in before firing anything, because the photon Team: field is
// sometimes stale (game rebalances after the init lines) and we need to
// see the whole split to know if we can trust it.
export async function onRosterEntry(entry) {
    try {
        const selfUid = lastKnownPlayerData?.Id;
        if (selfUid && entry.uid === selfUid && entry.team) _selfTeam = entry.team;
        if (!_matchFormat) {
            // Missing/late "Starting game" line: retain the complete roster
            // and classify it only after self + final teams are known.
            snapshotDeferredRoster();
            return;
        }
        scheduleRankedRosterPopups();
    } catch (e) {
        dbg("onRosterEntry threw: " + getErrMsg(e));
    }
}


export async function fireAllRankedPopups() {
    const generation = _matchPopupGeneration;
    try {
        if (_rosterFired || _rosterFiring) return;
        const selfUid = lastKnownPlayerData?.Id;
        if (!selfUid || !_matchFormat) return;
        _rosterFiring = true;
        if (_rosterFireTimer) { clearTimeout(_rosterFireTimer); _rosterFireTimer = null; }
        const roster = _liveRoster.map(player => ({ ...player }));
        const matchFormat = _matchFormat;
        const matchPlayerCount = _matchPlayerCount;
        // count each team so we can tell if the photon Team labels line up
        // with a real match split (3v3 = 3+3, 2v2 = 2+2, 1v1 = 1+1)
        const { counts, teamsBalanced, selfTeam } =
            trustedTeamContext(roster, selfUid, matchPlayerCount);
        if (!teamsBalanced) {
            dbg(`team split ${counts.Orange || 0}O/${counts.Blue || 0}B doesn't match a legit ${matchPlayerCount}-player split — using neutral labels`);
        }
        const cache = await getLeaderboardCache(matchFormat);
        if (generation !== _matchPopupGeneration) return;
        if (!cache) { dbg("popup skip: no leaderboard cache available"); return; }
        const cfg = await getRemoteConfig();
        if (generation !== _matchPopupGeneration) return;
        const prefs = normalizePopupPreferences(RANKED_POPUP_PREFERENCES);
        _rosterFired = true;
        for (const entry of roster) {
            if (entry.uid === selfUid) continue;
            if (_shownPopupsThisMatch.has(entry.uid)) continue;
            const hit = lookupInCache(cache, entry.uid, matchFormat);
            if (!hit) {
                dbg(`popup skip: "${entry.name}" (${entry.uid.slice(0,8)}...) not in ${matchFormat} top ${RG_LB_TOP_N}`);
                continue;
            }
            let isTeammate = null; // null = don't know, use neutral label
            if (teamsBalanced && selfTeam && entry.team) {
                isTeammate = entry.team === selfTeam;
            }
            if (!rankedPopupAllowed(hit.rank, isTeammate, cfg, prefs)) {
                dbg(`popup skip: "${entry.name}" hidden by rank or role settings`);
                continue;
            }
            let winStreak = 0;
            if (isTeammate === false) {
                const streakInfo = await resolveOpponentStreak(entry.uid);
                if (generation !== _matchPopupGeneration) return;
                if (streakInfo.confident && streakInfo.streak > 0) {
                    winStreak = streakInfo.streak;
                    _matchOpponentStreaks.set(entry.uid, {
                        uid: entry.uid,
                        name: hit.name || entry.name,
                        streak: winStreak,
                        confident: true,
                        isTeammate: false,
                    });
                }
            }
            _shownPopupsThisMatch.add(entry.uid);
            const displayName = hit.name || entry.name;
            const role = isTeammate === true ? "teammate" : isTeammate === false ? "opponent" : "player";
            dbg(`popup fire: #${hit.rank} ${role} "${displayName}" in ${matchFormat}`);
            showLbOpponentPopup({
                rank: hit.rank,
                name: displayName,
                mode: matchFormat,
                isTeammate,
                winStreak,
                config: cfg,
                preferences: prefs,
            });
        }
    } catch (e) {
        dbg("fireAllRankedPopups threw: " + getErrMsg(e));
    } finally {
        if (generation === _matchPopupGeneration) _rosterFiring = false;
    }
}


// If the Starting line was missing, defer until the ratings delta reveals
// the playlist. Capture everything before the first await so match-end can
// safely reset global popup state for the next match.
export async function firePostmortemPopupsIfDeferred(prevRatings) {
    const generation = _matchPopupGeneration;
    const deferred = _deferredMatch;
    _deferredMatch = null;
    const players = deferred?.players?.map(player => ({ ...player })) ?? [];
    const selfUid = lastKnownPlayerData?.Id;
    const alreadyShown = new Set(_shownPopupsThisMatch);
    const g = lastKnownPlayerData?.ModesGlicko || {};
    const changedRanked = RG_LB_MODES.filter(mode => {
        const before = prevRatings?.[mode];
        const after = g[mode]?.displayRating;
        return typeof after === "number" && typeof before === "number" && after !== before;
    });
    try {
        if (!deferred || !selfUid || !players.length || changedRanked.length !== 1) return;
        const mode = changedRanked[0];
        const cache = await getLeaderboardCache(mode);
        if (!cache) return;
        if (_matchPopupGeneration > generation + 1 || _inMatch) return;
        const cfg = await getRemoteConfig();
        if (_matchPopupGeneration > generation + 1 || _inMatch) return;
        const prefs = normalizePopupPreferences(RANKED_POPUP_PREFERENCES);
        const { teamsBalanced, selfTeam } =
            trustedTeamContext(players, selfUid, players.length);
        for (const player of players) {
            if (player.uid === selfUid || alreadyShown.has(player.uid)) continue;
            alreadyShown.add(player.uid);
            const hit = lookupInCache(cache, player.uid, mode);
            if (!hit) continue;
            const isTeammate = teamsBalanced && selfTeam && player.team
                ? player.team === selfTeam
                : null;
            if (!rankedPopupAllowed(hit.rank, isTeammate, cfg, prefs)) continue;
            const streakInfo = isTeammate === false
                ? await resolveOpponentStreak(player.uid)
                : { streak: 0, confident: false };
            if (_matchPopupGeneration > generation + 1 || _inMatch) return;
            showLbOpponentPopup({
                rank: hit.rank,
                name: hit.name || player.name,
                mode,
                isTeammate,
                winStreak: streakInfo.confident ? streakInfo.streak : 0,
                config: cfg,
                preferences: prefs,
            });
        }
    } catch (e) {
        dbg("firePostmortemPopupsIfDeferred threw: " + getErrMsg(e));
    }
}


export function scheduleRankedRosterPopups() {
    if (_rosterFired || _rosterFiring || !_matchFormat || !_liveRoster.length) return;
    if (!lastKnownPlayerData?.Id) return;
    if (_matchPlayerCount && _liveRoster.length >= _matchPlayerCount) {
        fireAllRankedPopups();
        return;
    }
    // Safety net: if inits stop coming, fire a neutral partial-roster
    // result after three seconds instead of missing the match entirely.
    if (_rosterFireTimer) clearTimeout(_rosterFireTimer);
    _rosterFireTimer = setTimeout(() => fireAllRankedPopups(), 3000);
}


export function saveOpponentStreakCache() {
    try {
        const entries = Object.entries(opponentStreakCache)
            .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
            .slice(0, 200);
        opponentStreakCache = Object.fromEntries(entries);
        localStorage.setItem(
            OPPONENT_STREAK_CACHE_KEY,
            JSON.stringify(opponentStreakCache)
        );
    } catch (e) {
        dbg("opponent streak cache save failed");
    }
}


export async function fetchRemoteConfig() {
    try {
        const fb = await initFirebase();
        if (!fb) return null;
        const snap = await fb.getDoc(fb.doc(fb.db, "atlas_config", "hud"));
        if (!snap.exists()) return null;
        const raw = snap.data() || {};
        return { ...RG_LB_DEFAULT_CONFIG, ...raw, fetchedAt: Date.now() };
    } catch (e) {
        dbg("remote config fetch failed: " + getErrMsg(e));
        return null;
    }
}


export async function getRemoteConfig() {
    if (_remoteConfigMemo && Date.now() - _remoteConfigMemo.fetchedAt < RG_LB_CONFIG_TTL_MS) {
        return _remoteConfigMemo;
    }
    try {
        const cached = JSON.parse(localStorage.getItem(RG_LB_CONFIG_KEY) || "null");
        if (cached && Date.now() - cached.fetchedAt < RG_LB_CONFIG_TTL_MS) {
            _remoteConfigMemo = cached;
            return cached;
        }
    } catch (e) {}
    const fresh = await fetchRemoteConfig();
    if (fresh) {
        _remoteConfigMemo = fresh;
        try { localStorage.setItem(RG_LB_CONFIG_KEY, JSON.stringify(fresh)); } catch (e) {}
        return fresh;
    }
    return { ...RG_LB_DEFAULT_CONFIG, fetchedAt: 0 };
}


export async function fetchLeaderboardCacheFromAggregate(fb, mode, playlist, ttlMs) {
    const snap = await fb.getDoc(
        fb.doc(fb.db, LEADERBOARD_CACHE_COLLECTION, playlist)
    );
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    const builtAt = Date.parse(data.builtAt || "")
        || Number(data.builtAt)
        || 0;
    if (!builtAt || Date.now() - builtAt > ttlMs) {
        dbg(`leaderboard aggregate stale (${playlist})`);
        return null;
    }
    const entries = normalizeAggregateEntries(data.rows);
    if (!entries.length) return null;
    dbg(`leaderboard cache aggregate (${playlist}:${entries.length})`);
    return {
        modes: { [mode]: entries },
        fetchedAt: Date.now(),
        source: "aggregate",
    };
}


export async function fetchLeaderboardCacheDirect(fb, mode, playlist) {
    // Overfetch so we can drop soft-deleted rows client-side and still
    // end up with RG_LB_TOP_N live entries. The site's published JSON
    // does the same filter, so the popup ranks match the leaderboard.
    const q = fb.query(
        fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
        fb.where("playlist", "==", playlist),
        fb.orderBy("mmr", "desc"),
        fb.limit(Math.max(RG_LB_TOP_N + 25, Math.ceil(RG_LB_TOP_N * 1.2))),
    );
    const snap = await fb.getDocs(q);
    const entries = [];
    snap.forEach(doc => {
        const d = doc.data();
        if (d.deleted === true) return;
        const rgPlayerId = typeof d.rgPlayerId === "string" ? d.rgPlayerId.trim() : "";
        entries.push({
            uid: d.sourceUserId,
            ...(rgPlayerId ? { rgPlayerId } : {}),
            name: d.name,
            mmr: d.mmr,
        });
    });
    // Assign ranks after filtering so popup #s match the site's JSON.
    const capped = entries.slice(0, RG_LB_TOP_N).map((e, i) => ({ ...e, rank: i + 1 }));
    dbg(`leaderboard cache refreshed (${mode.replace("Competitive", "")}:${capped.length})`);
    // empty usually means transient offline; don't poison the cache
    if (!capped.length) return null;
    return {
        modes: { [mode]: capped },
        fetchedAt: Date.now(),
        source: "query",
    };
}


export async function fetchLeaderboardCache(mode) {
    try {
        if (firestoreReadBudgetPassed()) {
            dbg("leaderboard cache fetch skipped: read budget passed");
            return null;
        }
        const fb = await initFirebase();
        if (!fb) return null;
        const playlist = RG_LB_MODE_TO_PLAYLIST[mode];
        if (!playlist) return null;
        const cfg = await getRemoteConfig();
        const ttlMs = (cfg.cacheRefreshHours || 24) * 60 * 60 * 1000;
        if (cfg.useLeaderboardCache) {
            try {
                const aggregate = await fetchLeaderboardCacheFromAggregate(
                    fb,
                    mode,
                    playlist,
                    ttlMs,
                );
                if (aggregate) return aggregate;
            } catch (e) {
                dbg("leaderboard aggregate failed, falling back to query");
            }
        }
        if (firestoreReadBudgetPassed()) {
            dbg("leaderboard cache query skipped: read budget passed");
            return null;
        }
        return await fetchLeaderboardCacheDirect(fb, mode, playlist);
    } catch (e) {
        dbg("leaderboard cache fetch failed: " + getErrMsg(e));
        return null;
    }
}


export async function getLeaderboardCache(mode) {
    if (!RG_LB_MODE_TO_PLAYLIST[mode]) return null;
    const cfg = await getRemoteConfig();
    const ttl = (cfg.cacheRefreshHours || 24) * 60 * 60 * 1000;
    const memo = _lbCacheMemo.get(mode);
    if (memo && Date.now() - memo.fetchedAt < ttl) return memo;
    try {
        const cached = JSON.parse(
            localStorage.getItem(leaderboardCacheKey(mode)) || "null"
        );
        if (cached && Date.now() - cached.fetchedAt < ttl) {
            _lbCacheMemo.set(mode, cached);
            return cached;
        }
        // Keep a warm cache across the v16 upgrade, then store only the
        // requested playlist in the new key.
        const legacy = JSON.parse(
            localStorage.getItem(RG_LB_CACHE_KEY_LEGACY) || "null"
        );
        if (legacy?.modes?.[mode] && Date.now() - legacy.fetchedAt < ttl) {
            const migrated = {
                modes: { [mode]: legacy.modes[mode] },
                fetchedAt: legacy.fetchedAt,
            };
            _lbCacheMemo.set(mode, migrated);
            try {
                localStorage.setItem(
                    leaderboardCacheKey(mode),
                    JSON.stringify(migrated)
                );
            } catch (e) {}
            return migrated;
        }
    } catch (e) {}
    // back off if we just failed — usually a missing index or perms issue,
    // no point hammering the same broken query for every roster entry.
    if (Date.now() < (_lbCacheFailUntil.get(mode) || 0)) return null;
    // share one in-flight fetch so 4 roster entries don't spawn 4 requests
    if (_lbCacheInFlight.has(mode)) return _lbCacheInFlight.get(mode);
    const inFlight = (async () => {
        try {
            const fresh = await fetchLeaderboardCache(mode);
            if (fresh) {
                _lbCacheMemo.set(mode, fresh);
                try {
                    localStorage.setItem(
                        leaderboardCacheKey(mode),
                        JSON.stringify(fresh)
                    );
                } catch (e) {}
                return fresh;
            }
            _lbCacheFailUntil.set(
                mode,
                Date.now() + RG_LB_FAIL_COOLDOWN_MS
            );
            return null;
        } finally {
            _lbCacheInFlight.delete(mode);
        }
    })();
    _lbCacheInFlight.set(mode, inFlight);
    return inFlight;
}

export async function fetchSiteLeaderboardRows(playlist) {
    const hit = siteJsonCache.get(playlist);
    if (hit && Date.now() - hit.fetchedAt < SITE_JSON_TTL_MS) return hit.rows;
    try {
        const res = await fetch(`${SITE_JSON_BASE}/${playlist}.json`, { cache: "default" });
        if (!res.ok) return null;
        const data = await res.json();
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        siteJsonCache.set(playlist, { rows, fetchedAt: Date.now() });
        return rows;
    } catch (e) { return null; }
}

export function rankCacheKey(uid) { return `rgHudRankCache_${uid}`; }


export function hydrateRankCache(uid) {
    if (!uid) return false;
    try {
        const raw = localStorage.getItem(rankCacheKey(uid));
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (!parsed?.ranks || typeof parsed.savedAt !== "number") return false;
        if (Date.now() - parsed.savedAt > RANK_CACHE_TTL_MS) return false;
        for (const [playlist, entry] of Object.entries(parsed.ranks)) {
            if (typeof entry?.rank === "number") cachedRanks.set(playlist, entry.rank);
            if (typeof entry?.mmr === "number") lastRankedMMR.set(playlist, entry.mmr);
            if (typeof entry?.gap === "number") cachedMmrToNext.set(playlist, entry.gap);
            if (typeof entry?.queriedAt === "number") lastRankedAt.set(playlist, entry.queriedAt);
        }
        return true;
    } catch { return false; }
}


export function persistRankCache(uid) {
    if (!uid) return;
    try {
        const ranks = {};
        for (const [playlist, rank] of cachedRanks) {
            ranks[playlist] = {
                rank,
                mmr: lastRankedMMR.get(playlist),
                gap: cachedMmrToNext.get(playlist),
                queriedAt: lastRankedAt.get(playlist),
            };
        }
        localStorage.setItem(rankCacheKey(uid), JSON.stringify({ ranks, savedAt: Date.now() }));
    } catch {}
}


export function resetAccountRankState() {
    cachedRanks.clear();
    cachedMmrToNext.clear();
    prevRanks.clear();
    lastRankedMMR.clear();
    lastRankedAt.clear();
    ranksFetchedThisSession = false;
}


export async function submitToLeaderboard(data) {
    try {
        const lockKey = data.Id;
        const previous = submitLocks.get(lockKey) || Promise.resolve();
        // swallow inner rejects so the lock chain keeps working
        const current = previous.then(() => submitToLeaderboardInner(data)).catch(e => {
            dbg("submitToLeaderboardInner threw: " + getErrMsg(e));
        });
        submitLocks.set(lockKey, current);
        await current;
    } catch (e) {
        dbg("submitToLeaderboard threw: " + getErrMsg(e));
    }
}


export async function submitToLeaderboardInner(data) {
  try {
    if (!hasPlayedAnything(data)) return;

    const fb = await initFirebase();
    if (!fb) return;
    if (!(await atlasMutationAllowed(fb, "leaderboard submission"))) return;
    if (!firebaseAuthUid) {
        dbg("submitToLeaderboardInner skipped: firebaseAuthUid not ready");
        return;
    }

    // Check the write caps before we spend any Firestore budget. If the
    // cap was already tripped on a prior tick, block. If this tick is the
    // one that trips it, fall through so the server-side doc gets the
    // reviewFlagged=true marker admins can see and clear.
    const winLimitsModes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    const winLimitsTotalWins = winLimitsModes.reduce((s, m) => s + (data.ModesData?.[m]?.wins ?? 0), 0);
    const wasFlaggedBefore = isFlaggedLocally(data.Id);
    const winLimits = evaluateWinLimits(data.Id, winLimitsTotalWins);
    const docRef = fb.doc(fb.db, LEADERBOARD_COLLECTION, firebaseAuthUid);

    // ask for display name once per player unless Rename forces it.
    // Memory dies on refresh; Tampermonkey storage and the public board
    // keep the same in-game account from getting the first-run prompt
    // after a new Firebase id.
    let existingDisplayName = cachedDisplayNames.get(data.Id) ?? null;
    if (!existingDisplayName) {
        existingDisplayName = readStoredDisplayName(atlasTmStorage(), data.Id) || null;
    }

    // if local says flagged, always re-check server so admin clears propagate
    let serverClearedFlag = false;
    if (wasFlaggedBefore || !existingDisplayName || forceRenamePrompt) {
        try {
            const existing = await fb.getDoc(docRef);
            if (existing.exists()) {
                const existingData = existing.data() || {};
                if (existingData.displayName && !existingDisplayName) {
                    existingDisplayName = existingData.displayName;
                }
                const serverFlagged = existingData.reviewFlagged === true;
                reconcileFlagFromServer(data.Id, serverFlagged);
                if (serverFlagged) {
                    showError("Under review by admin. Writes paused until cleared.");
                    dbg("submitToLeaderboardInner blocked: server-side review flag");
                    return;
                }
                if (wasFlaggedBefore) serverClearedFlag = true;
            } else if (wasFlaggedBefore) {
                // row is gone, treat as cleared
                reconcileFlagFromServer(data.Id, false);
                serverClearedFlag = true;
            }
        } catch (e) {
            dbg("submitToLeaderboardInner: prior displayName read failed");
        }
    }

    if (!serverClearedFlag && wasFlaggedBefore && winLimits?.reviewFlagged) {
        showError(`Under review (${winLimits.flaggedReason || "cap exceeded"}). Writes paused.`);
        dbg(`submitToLeaderboardInner blocked: ${winLimits.flaggedReason}`);
        return;
    }

    if (!existingDisplayName && !forceRenamePrompt) {
        existingDisplayName = await lookupDisplayNameFromBoard(fb, data.Id) || null;
    }

    let displayName = (!forceRenamePrompt && existingDisplayName) ? existingDisplayName : null;
    const isRename = forceRenamePrompt && !!existingDisplayName;
    forceRenamePrompt = false;

    if (!displayName) {
        const cleaned = cleanName(data.Nickname).slice(0, 15);
        const suggestion = (cleaned && cleaned.toLowerCase() !== "player") ? cleaned : "";
        if (suggestion && !isRename) {
            const taken = await isNameTaken(fb, suggestion, firebaseAuthUid, data.Id);
            if (!taken) displayName = suggestion;
        }
        if (!displayName) {
            displayName = await askDisplayName(suggestion, isRename, fb, firebaseAuthUid, data.Id);
            if (!displayName) return;
        }
    }

    cachedDisplayNames.set(data.Id, displayName);
    writeStoredDisplayName(atlasTmStorage(), data.Id, displayName);

    // Full Glicko snapshot per playlist: rating, displayRating, rd,
    // vol. snapshotKey below only hashes displayRating + stats so
    // this doesn't change how often we sync. `ratings` stays for
    // anything that already reads the flat displayRating map.
    const glickoFor = (mode) => {
        const g = data.ModesGlicko?.[mode] || {};
        return {
            rating: typeof g.rating === "number" ? g.rating : null,
            displayRating: typeof g.displayRating === "number" ? g.displayRating : null,
            rd: typeof g.rd === "number" ? g.rd : null,
            vol: typeof g.vol === "number" ? g.vol : null,
        };
    };
    const payload = {
        nickname: (data.Nickname ?? "").slice(0, 500),
        displayName,
        ratings: {
            Competitive3v3: data.ModesGlicko?.Competitive3v3?.displayRating ?? null,
            Competitive2v2: data.ModesGlicko?.Competitive2v2?.displayRating ?? null,
            Competitive1v1: data.ModesGlicko?.Competitive1v1?.displayRating ?? null,
            Casual: data.ModesGlicko?.Casual?.displayRating ?? null,
        },
        glicko: {
            Competitive3v3: glickoFor("Competitive3v3"),
            Competitive2v2: glickoFor("Competitive2v2"),
            Competitive1v1: glickoFor("Competitive1v1"),
            Casual: glickoFor("Casual"),
        },
        stats: {
            Competitive3v3: data.ModesData?.Competitive3v3 ?? null,
            Competitive2v2: data.ModesData?.Competitive2v2 ?? null,
            Competitive1v1: data.ModesData?.Competitive1v1 ?? null,
            Casual: data.ModesData?.Casual ?? null,
        },
        currentStreak: streakData?.accountId === data.Id
            ? Math.trunc(Number(streakData.streak) || 0)
            : 0,
        xp: data.AccountXp ?? 0,
        equippedSkinId: data.EquippedSkinId ?? null,
        lastUpdated: new Date().toISOString(),
        sourceUserId: firebaseAuthUid,
        rgPlayerId: data.Id,
        deviceId: getDeviceId(),
        scriptVersion: SCRIPT_VERSION,
        versionNum: SCRIPT_VERSION_NUM,
        // Last 5 match snapshots for cheap "recent form" reads. Full
        // per-match history lives in match_snapshots/{authUid}_{matchId}.
        recentMatches: (_recentMatchesRing || []).slice(-RECENT_MATCHES_CAP),
        dailyWins: winLimits?.dailyWins || null,
        hourlyWins: winLimits?.hourlyWins || null,
        // reread post-reconcile, winLimits was captured before the clear
        reviewFlagged: isFlaggedLocally(data.Id),
        newMatchIds: (_pendingNewMatchIds || []).slice(-5),
        lastWriteAt: fb.serverTimestamp(),
    };

    // Tag for the snapshot key. Off-event we do not touch clan docs —
    // use whatever is already in memory from the clan panel.
    if (!clanLoaded || clanLoadedForAccount !== data.Id) {
        await loadEventConfig(fb);
        if (eventPhase() === "active") await loadClanData(true);
    }

    // clan tag lives in the snapshot key so a tag change alone forces
    // a resync. Rename always bypasses the "unchanged" skip.
    const currentClanTag = (clanLoadedForAccount === data.Id && myClan) ? (myClan.tag ?? "") : "";
    const snapshotKey = JSON.stringify({
        displayName, ratings: payload.ratings, stats: payload.stats,
        currentStreak: payload.currentStreak,
        xp: payload.xp, equippedSkinId: payload.equippedSkinId,
        clanTag: currentClanTag,
    });
    const now = Date.now();
    const unchanged = lastSyncSnapshot.get(data.Id) === snapshotKey;
    const withinCooldown = (now - (lastSyncTime.get(data.Id) ?? 0)) < SYNC_COOLDOWN_MS;

    if (!isRename && (unchanged || withinCooldown)) {
        // still refresh ranks once per session
        refreshRanks(fb, data);
        return;
    }

    let writeOk = false;
    try {
        writeOk = await atlasSetDoc(
            fb,
            "script_submissions",
            docRef,
            payload,
            { merge: true }
        );
        // cache AFTER success, otherwise a rejected write looks "unchanged"
        // next time and never retries
        if (!writeOk) return;
        _pendingNewMatchIds = [];
        lastSyncTime.set(data.Id, now);
        clearError();
    } catch (e) {
        console.error("[RG HUD] Leaderboard submission failed:", e);
        showError("Stats submission failed -- check console");
    }

    // don't publish partial state; leave cooldown open for a retry
    if (!writeOk) return;
    await syncToRealLeaderboard(fb, data, displayName, { winLimits, wasFlaggedBefore });
    // Cache the snapshot only after the public board write. A
    // submissions-only success used to skip later retries when the
    // board owner check bailed out.
    lastSyncSnapshot.set(data.Id, snapshotKey);
    refreshRanks(fb, data, true);
    refreshClanViewIfOpen();
    applyTitle(); // clan-lead may have flipped since updateMomentum
  } catch (e) {
    dbg("submitToLeaderboardInner threw: " + getErrMsg(e));
  }
}


export async function syncToRealLeaderboard(fb, data, displayName, opts = {}) {
  try {
    if (!firebaseAuthUid) {
        dbg("syncToRealLeaderboard skipped: firebaseAuthUid not ready");
        return;
    }
    // Let the trip-write through so all 4 leaderboard docs pick up the
    // reviewFlagged marker for the site badge. Subsequent ticks block.
    const winLimits = opts.winLimits || null;
    const wasFlaggedBefore = opts.wasFlaggedBefore === true;
    if (wasFlaggedBefore || (isFlaggedLocally(data.Id) && !winLimits?.reviewFlagged)) {
        dbg("syncToRealLeaderboard blocked: account under review");
        return;
    }
    const sourceUserId = firebaseAuthUid;
    const rgPlayerId = data.Id;

    try {
        const q = fb.query(
            fb.collection(fb.db, REAL_LEADERBOARD_COLLECTION),
            fb.where("rgPlayerId", "==", rgPlayerId),
            fb.limit(8)
        );
        const snap = await fb.getDocs(q);
        const priorUids = snap.docs
            .map((d) => d.data())
            .filter((row) => row && row.playlist !== "tombstone")
            .map((row) => row.sourceUserId)
            .filter(Boolean);
        if (!shouldPublishLeaderboardRow(priorUids, sourceUserId)) {
            dbg(`syncToRealLeaderboard skipped: ${rgPlayerId} already on the board as ${priorUids.join(",")}`);
            return;
        }
    } catch (e) {
        dbg("syncToRealLeaderboard owner check failed: " + getErrMsg(e));
    }

    // piggy-back: refresh this member's MMR in the clan doc, get tag back
    const clanInfo = await queueClanMMRSync(fb, data);
    const cleanDisplayName = clanInfo?.tag
        ? stripClanTagPrefix(displayName, clanInfo.tag)
        : displayName;
    const shownName = clanInfo?.tag ? `[${clanInfo.tag}] ${cleanDisplayName}` : cleanDisplayName;

    const modeToPlaylist = {
        Competitive1v1: "1v1",
        Competitive2v2: "2v2",
        Competitive3v3: "3v3",
    };

    // Same rationale as currentStreak below: publish the per-mode session
    // delta so the public leaderboard can show recent MMR movement the
    // moment it reads the doc, instead of waiting to reconstruct history
    // from live snapshots after every page load. sessionLastSeen lets the
    // site tell when a session is actually still going vs. stale after the
    // HUD stopped writing.
    const sessionOwnedByAccount = sessionStart?.accountId === data.Id;
    const sessionStartedAt = sessionOwnedByAccount
        ? (Number.isFinite(sessionStart?.startedAt) ? sessionStart.startedAt : null)
        : null;
    const sessionLastSeen = sessionOwnedByAccount
        ? (Number.isFinite(sessionStart?.lastSeen) ? sessionStart.lastSeen : null)
        : null;

    // Mirror the streak already tracked for script_submissions so the
    // public leaderboard site and the opponent popup can show it right
    // away instead of having to reconstruct it from wins/matches deltas.
    // Same total-across-modes value goes on every playlist doc so 1v1,
    // 2v2, 3v3, and wins can all show the streak chip without joining
    // sibling docs client-side.
    const publishedStreak = streakData?.accountId === data.Id
        ? Math.trunc(Number(streakData.streak) || 0)
        : 0;

    // Only send the session fields when we actually have real numbers
    // for them. On a fresh install (or right after auto-update),
    // sessionStart isn't set yet and these come back as null.
    // Firestore rejects the whole write if a field is null when the
    // rule expects a number, so we just leave the field off.
    const reviewFlaggedNow = winLimits?.reviewFlagged === true;
    function payloadWithSession(base) {
        const p = { ...base };
        if (Number.isFinite(sessionStartedAt)) p.sessionStartedAt = sessionStartedAt;
        if (Number.isFinite(sessionLastSeen)) p.sessionLastSeen = sessionLastSeen;
        if (reviewFlaggedNow) p.reviewFlagged = true;
        return p;
    }

    for (const [mode, playlist] of Object.entries(modeToPlaylist)) {
        const mmr = data.ModesGlicko?.[mode]?.displayRating;
        if (typeof mmr !== "number") continue; // never played this mode

        // Skip if MMR hasn't changed for this playlist since we last
        // wrote it — session-total fields kept re-triggering writes on
        // every doc even when only one mode was actually played.
        const stateKey = `${sourceUserId}_${playlist}`;
        const priorRaw = lastEntryState.get(stateKey);
        if (priorRaw) {
            let priorMmr = null;
            try { priorMmr = JSON.parse(priorRaw)?.mmr; } catch {}
            if (priorMmr === mmr) continue;
        }

        const sessionBase = sessionOwnedByAccount && typeof sessionStart?.[mode] === "number"
            ? sessionStart[mode]
            : null;
        const sessionMmrDelta = sessionBase === null ? 0 : Math.trunc(mmr - sessionBase);
        // Raw Glicko numbers alongside mmr. Write cadence is unchanged
        // — the mmr skip check above still gates when we sync.
        const glicko = data.ModesGlicko?.[mode] || {};
        await upsertIfChanged(fb, sourceUserId, playlist, payloadWithSession({
            name: shownName,
            mmr,
            rating: typeof glicko.rating === "number" ? glicko.rating : null,
            rd: typeof glicko.rd === "number" ? glicko.rd : null,
            vol: typeof glicko.vol === "number" ? glicko.vol : null,
            sessionMmrDelta,
            currentStreak: publishedStreak,
            rgPlayerId,
        }));
    }

    const modes = ["Competitive3v3", "Competitive2v2", "Competitive1v1", "Casual"];
    const totalWins = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.wins ?? 0), 0);
    const totalMatches = modes.reduce((sum, m) => sum + (data.ModesData?.[m]?.matchesPlayed ?? 0), 0);

    await upsertIfChanged(fb, sourceUserId, "wins", payloadWithSession({
        name: shownName,
        wins: totalWins,
        matches: totalMatches,
        currentStreak: publishedStreak,
        rgPlayerId,
    }));
  } catch (e) {
    dbg("syncToRealLeaderboard threw: " + getErrMsg(e));
  }
}


// Sourced rows have one stable id. merge:true preserves hand-set fields on
// that row, while unrelated manual site rows are never queried or touched.
export async function upsertPlaylistEntry(fb, sourceUserId, playlist, fields) {
    const lockKey = `${sourceUserId}_${playlist}`;
    const previous = upsertLocks.get(lockKey) || Promise.resolve();

    const current = previous.then(async () => {
        // identifying fields on every write so rules can blacklist-check merges
        const fullFields = {
            ...fields,
            sourceUserId,
            playlist,
            deviceId: getDeviceId(),
            scriptVersion: SCRIPT_VERSION,
            versionNum: SCRIPT_VERSION_NUM,
            lastWriteAt: fb.serverTimestamp(),
        };

        try {
            const deterministicId = `${sourceUserId}_${playlist}`;
            const wrote = await atlasSetDoc(
                fb,
                `leaderboard/${playlist}`,
                fb.doc(fb.db, REAL_LEADERBOARD_COLLECTION, deterministicId),
                fullFields,
                { merge: true }
            );
            if (!wrote) return false;
            clearError();
            return true;
        } catch (e) {
            pushError(e, `upsertPlaylistEntry:${playlist}`);
            console.error(`[RG HUD] Real leaderboard sync failed for ${playlist}:`, e);
            showError(`Leaderboard sync failed for ${playlist} -- check console`);
            return false;
        }
    });

    upsertLocks.set(lockKey, current);
    return current;
}


export async function upsertIfChanged(fb, sourceUserId, playlist, fields) {
    try {
        const stateKey = `${sourceUserId}_${playlist}`;
        const newState = JSON.stringify(fields);

        if (lastEntryState.get(stateKey) === newState) {
            return; // unchanged — skip
        }

        const ok = await upsertPlaylistEntry(fb, sourceUserId, playlist, fields);
        // only cache on success, a failed write would poison the cache and
        // prevent any future retry
        if (ok) {
            lastEntryState.set(stateKey, newState);
            saveEntryState();
        }
    } catch (e) {
        dbg("upsertIfChanged threw: " + getErrMsg(e));
    }
}
