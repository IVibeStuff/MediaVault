# MediaVault v1.6.4

A sleek desktop media manager for Windows with TMDB/OMDB metadata, poster art, episode tracking, watchlist, and streaming availability.

---

## Running from source

**Prerequisites:** [Node.js](https://nodejs.org/) v18 or newer

```
npm install
npm start
```

---

## Building the Windows installer (.exe)

### Step 1 — Create the app icon

electron-builder requires `assets/icon.ico` for the Windows installer.
An SVG source is already at `assets/icon.svg`.

Convert it to `.ico` at one of these free sites:
- https://convertico.com
- https://icoconvert.com

Save the result as `assets/icon.ico` (256×256 multi-resolution recommended).

### Step 2 — Install dependencies

```
npm install
```

### Step 3 — Build

```
npm run build
```

Output:
```
dist/
  MediaVault-Setup-1.6.4.exe
```

### Step 4 — Install

Run `MediaVault-Setup-1.6.4.exe`. The installer lets you choose the install
directory, creates a Desktop shortcut and a Start Menu entry under MediaVault.

---

## What the installer includes
- Installs to `C:\Program Files\MediaVault\` (or your chosen path)
- Desktop shortcut + Start Menu shortcut
- Standard Add/Remove Programs uninstaller
- Writes `HKCU\Software\MediaVault` version key (removed on uninstall)

## User data location
```
C:\Users\<you>\.mediavault\
  library.json      ← library, watchlist, settings
  cache\            ← poster art, headshots, metadata
```
This folder is never touched by the installer or uninstaller.

---

## API Keys
- **TMDB** (free): https://www.themoviedb.org/settings/api
- **OMDB** (free): https://www.omdbapi.com/apikey.aspx

Enter both in Settings → API Keys after first launch.

---

## Quick start
1. Launch MediaVault
2. Settings → API Keys → enter TMDB and OMDB keys
3. Click **Add Folder** → select your Movies folder, then TV Shows folder
4. Metadata and poster art download automatically in the background

---

## Build troubleshooting

**"icon.ico not found"** → Create `assets/icon.ico` (Step 1 above)

**"cannot find module electron"** → Run `npm install` first

**Build fails on macOS/Linux targeting Windows** → Install Wine:
- macOS: `brew install wine`
- Ubuntu: `sudo apt install wine`
- Then run: `npm run build -- --win`

**App opens and immediately closes** → Run from terminal to see the error:
`"C:\Program Files\MediaVault\MediaVault.exe"`
