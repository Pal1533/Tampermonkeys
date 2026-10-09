# ATLAS 🏔️

A free Tampermonkey script that turns [Rocket Goal](https://rocketgoal.io) into a live service game - stats HUD, community leaderboard, clans with events, and a full custom name editor. The devs stopped updating, so we did it ourselves.

[Install ATLAS](https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/rg_hud.user.js)
· [Player board](https://pal1533.github.io/rg_player_leaderboard/)
· [Clan Clash](https://pal1533.github.io/RG_Clan_Leaderboard/)
· [Discord](https://discord.gg/MDz7hsrh9m)
· [Contributing](CONTRIBUTING.md)

This guide assumes you've never used Tampermonkey before. Just follow the steps in order. Full feature list is at the [bottom](#whats-actually-in-this-thing) if you want to see everything it does first.

---

## Step 1: Install the Tampermonkey extension

Tampermonkey is a free browser extension that lets you run small scripts (like this one) on websites. You only need to do this once, ever.

Pick your browser below and click the link:

- **Chrome**: [Tampermonkey on the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Edge**: [Tampermonkey on the Edge Add-ons store](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- **Firefox**: [Tampermonkey on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)

Click **Add to Chrome** (or **Add to Edge** / **Add to Firefox**), then confirm by clicking **Add extension** in the popup that appears.

---

## Step 2: Pin the extension so you can see it

1. Click the puzzle-piece icon (🧩) in your browser's toolbar, near the top right.
2. Find **Tampermonkey** in the list.
3. Click the pin icon 📌 next to it.

You should now see a little Tampermonkey icon (two black circles) in your toolbar at all times. This lets you quickly check if the script is running.

---

## Step 3: Turn on Developer Mode and Allow User Scripts (Chrome and Edge only)

Chrome and Edge require two extra settings for userscripts to actually work. Skip this step if you're using Firefox.

**Developer mode**

1. Go to `chrome://extensions` (or `edge://extensions` on Edge) by typing it into your address bar.
2. Look for a toggle labeled **Developer mode** in the top-right corner of the page.
3. Turn it **on**.

**Allow User Scripts**

1. Right-click the Tampermonkey icon in your toolbar and click **Manage extension**.
2. Find the **Allow User Scripts** toggle and turn it **on**.

Don't worry, this doesn't make your browser less safe. It just allows extensions like Tampermonkey to run scripts you install yourself.

---

## Step 4: Install ATLAS

1. Click this link: **[Install ATLAS](https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/rg_hud.user.js)**
2. Tampermonkey opens a new tab showing the script's details and an **Install** button. Click **Install**.
   - If you already have ATLAS, the button says **Reinstall** instead. That's fine, click it.
3. Nothing gets downloaded to your computer and nothing visible happens after you click. That's normal. The tab may close or send you back to where you were.

**Check that it installed:** click the Tampermonkey icon in your toolbar. You should see **Enabled** with **ATLAS** listed under it and its toggle switched on (green). Your browser's Downloads folder will stay empty, ATLAS lives inside Tampermonkey.

![Tampermonkey menu showing ATLAS enabled](atlas/tampermonkey-menu.png)

---

## Step 5: Allow the script to actually run on rocketgoal.io

The first time you visit [rocketgoal.io](https://rocketgoal.io) after installing, your browser may show a small popup asking whether to allow Tampermonkey (or the script itself) to run on that site. If you don't approve this, the HUD will silently never appear, with no error message telling you why.

- If you see a popup mentioning **rocketgoal.io** and asking to allow the extension, click **Allow**.
- If you don't see a popup at all, you likely won't need to do anything, some browsers don't ask. Just move on to Step 6 and confirm it's working.

If it still doesn't show up later, there's one more place to check:

1. Right-click the Tampermonkey icon in your toolbar and choose **Manage Extension** (wording may vary slightly by browser).
2. Look for a **Site access** section.
3. Make sure it's set to **On all sites** or specifically includes `rocketgoal.io`, not **On click** or **Restricted**.

---

## Step 6: Turn on frequent auto-updates

This makes sure you automatically get bug fixes and new features as soon as they're pushed, without having to reinstall anything yourself.

1. Click the Tampermonkey icon in your toolbar.
2. Click **Dashboard**.
3. Click the **Settings** tab at the top.
4. Scroll down to the **Userscript Update** section.
5. Set **Check Interval** to **Every 6 Hours**.
6. Check both boxes underneath it:
   - **Automatic installation**
   - **Update disabled scripts**

That's it, Tampermonkey will now silently check every 6 hours and install any updates on its own.

If you ever want to check for an update right now instead of waiting:

1. Tampermonkey icon → **Dashboard**
2. Click the **Utilities** tab at the top
3. Click **Check for userscript updates**

If that doesn't grab the newest version (Tampermonkey can be stubborn), just click the [install link](https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/rg_hud.user.js) again and hit **Reinstall**. Always works.

---

## Step 7: Confirm it's working

1. Go to [rocketgoal.io](https://rocketgoal.io) and log in.
2. You should see a small box in the top-right corner labeled **ATLAS**.
3. It'll say "Waiting for data..." for a second, then fill in with your ratings and stats.

If you don't see the box at all:

- Click the Tampermonkey icon - it should show a number badge if a script is active on the current page. If it doesn't, the script may not have installed correctly; try Step 4 again.
- Make sure you only have **one** copy of the script installed. Go to Tampermonkey Dashboard → Installed Userscripts, and if you see more than one entry (old "Rocket Goal HUD" or standalone "Name Forge" copies count), delete all but the newest ATLAS entry (trash can icon on the right).

---

## Step 8: Get on the allowlist (required for the board and clans)

The leaderboard and clans are invite-only. Installing ATLAS is not enough. RIS3N has to add your Firebase id before you can sync stats or use clans.

1. Go to [rocketgoal.io](https://rocketgoal.io) and log in so ATLAS is showing your stats.
2. Click the **⚙** settings button on the ATLAS box.
3. Find the **Firebase id** row. Wait until it shows a long id instead of `signing in…`.
4. Click **Copy ids** (shown below). It puts both ids on the clipboard as:

       Firebase ID: …
       Device ID: …

   ![Firebase id and Device id rows with the Copy ids button](atlas/copy-ids.png)

5. DM **he_is_ris3n** on Discord and paste that. Ask to be added to the allowlist. Do not post your ids in the [Championship Discord](https://discord.gg/MDz7hsrh9m) or any public channel.

If the Firebase id still says `signing in…`, wait a few seconds, or close and reopen settings. Do not send a screenshot of someone else's id, and do not reuse an id from an old install after a full cache wipe. That mints a new Firebase id and you would need to be added again.

---

## Changing your name

ATLAS has two separate name settings, and they do different things:

![ATLAS box with the Name Forge palette button (1) and Rename button (2) marked](atlas/hud-buttons.png)

1. **🎨 Name Forge** (palette button, top of the box): changes the name other players see **in game**, with colors, gradients and emoji.
2. **✏️ Rename** (bottom of the box): changes your name on the **leaderboard only**. It does not change your in-game name.

If you want a new name in game, use Name Forge (or press **Alt+N**). Inside it, the live preview (1) shows how your name will look, and you type your name in the **Name** box (2):

![Name Forge with the live preview (1) and Name box (2) marked](atlas/name-forge.png)

---

## Found a bug or have a suggestion?

[Open an issue](https://github.com/Pal1533/Tampermonkeys/issues/new/choose) or ping Pal / JesusDied4U in the [Championship Discord](https://discord.gg/MDz7hsrh9m).

---
---

# What's actually in this thing

Everything below ships in the one script. No paid tiers, no premium unlock, none of that. It's all free and community-run.

## 📊 Stats HUD

- Live ratings + win rates for 3v3 / 2v2 / 1v1 / casual
- Session +/- so you know exactly how much MMR you've gained (or donated) since you sat down
- Streak badges - 🔥 when you're hot, ❄️ when it's rough
- Your live rank on the leaderboard per playlist. Hover it to see exactly how much MMR you need to pass the player above you
- Hold any #1 and your title turns into **👑 Rocket Goal KING**. Get passed and you get a dethroned alert
- The title also reacts to your session: *Heating Up* → *ON FIRE* → *Flow State* when you're locked in, *Ice Cold* when you're not. There's a couple easter eggs in there too
- RGB glow you can customize (colors, speed, brightness) - and it speeds up when you're on fire
- Miss the old 🚀 Rocket Goal HUD title? There's an **OG Title** toggle in settings
- Optional network RTT tracker that updates while you play without covering the scoreboard
- Drag it anywhere, minimize it, and it hides itself during matches automatically

## 🏆 Community Leaderboard

- Your stats auto-sync to the [community leaderboard](https://pal1533.github.io/rg_player_leaderboard/) after every match - nothing to do manually
- Pick your own display name, rename whenever
- The anti-cheat is real: server-side rules, device blacklisting, forged-stat detection, and old exploited versions get force-updated

## 🎯 Ranked Player Popups

- Shows ranked teammates and opponents when a match starts
- Separate teammate and opponent toggles
- Choose the maximum rank, how long each card stays up, and which screen corner it uses
- Handles 1v1, 2v2, 3v3, late roster messages, and back-to-back matches
- Follows your browser's reduced-motion setting

## 🛡️ Clans

- Create one (name + 2-4 letter tag), browse the directory, request to join, leaders approve
- Full roles: **Leader / Co-leader / Elder / Member** - promote, demote, kick (with an optional message), transfer leadership
- Tiered permissions like a real clan game: you can only kick or manage people below your own rank, nobody touches the leader, and leadership only changes hands through an actual transfer
- Role permissions are server-controlled, so what each role can do (styling the tag, kicking, approving joins, etc.) can be adjusted without anyone updating their script
- If you get kicked, you actually get told in your HUD instead of just wondering
- Clan tag styling: gradients, palettes, custom colors, bracket colors, bold/italic, wave and rotate effects. Whoever's allowed to designs it, every member can opt in to wear it in-game
- The clan view is **live** - when your clanmate finishes a match, you see their contribution change on your screen within seconds. Hover a number to see when they last synced

## ⚔️ Clan Clash Events

- Scheduled clan vs clan events with a live countdown
- Your baseline locks on your first match of the event - clan score = everyone's MMR gained since
- Live standings, leader vs challenger view, per-member contribution tracking
- **👑 Leading the Clash** title while your clan is on top
- Event rules (joins, leaves, kicks, roster locks, clan size) are controlled server-side, so they can be adjusted mid-event without anyone needing to update

## 🎨 Name Forge

- Full in-game name editor with a live preview - what you see is what the game shows
- Gradients with up to 5 stops, one-click palettes (Fire, Ocean, Rainbow, Sunset, Toxic, Ice), random roller, reverse
- Solid colors with opacity
- Bold, italic, underline, strikethrough, size, rotate, wave letters, highlight
- The game's emoji sprites (0-15) - drop them anywhere in your name
- A **title line** under your name with its own completely separate styling: own gradient, own palette, own bold/italic, size up to 180%, opacity. Your title doesn't have to match your name anymore
- Control the "Scored!" text: hide it, shrink it, or style it
- **Raw mode** pulls in your exact current name so you can edit the markup directly. The box auto-sizes to whatever you paste in
- ↺ button resets to your current in-game name any time
- Clan tag prepends automatically when you opt in - no double tags
- Presets: save your designs, load them, export/import JSON to share with friends. Overwrite protection so you can't lose one by accident
- Organize presets into folders (collapsible), rename or move them around whenever your library gets messy
- History of recently applied names with one-click re-apply, and you can save any of them as a preset
- Per-account, so alt accounts don't leak names into each other
- **Alt+N** opens it anywhere

## ඞ Imposter

- Grabs the exact names of everyone from your last match (teammates and opponents)
- One click steals their name and applies it instantly - their exact colors, gradients, everything
- Yes, there's an Among Us role reveal when you do it
- Profane names get filtered out, and you can't accidentally steal your own name

## 🧰 Support and diagnostics

- ATLAS keeps debug logging enabled so problems leave useful clues
- Settings → **Download debug bundle** saves a `.txt` file you can attach to a bug report
- Support downloads remove your persistent device ID, player ID, and full browser user agent
- The bundle still includes the ATLAS version, screen size, recent warnings, errors, and match state

---

*Update from the [install link](https://raw.githubusercontent.com/Pal1533/Tampermonkeys/refs/heads/main/rg_hud.user.js) and go make a name so shiny the other team scores on themselves.* 🏔️

---

## Community

ATLAS is a fan project. It is not affiliated with Rocket Goal.

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [MIT License](LICENSE)
- [Privacy](https://pal1533.github.io/rg_player_leaderboard/privacy.html)
- [Terms](https://pal1533.github.io/rg_player_leaderboard/terms.html)
