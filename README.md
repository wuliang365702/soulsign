# soulsign

`soulsign` is a continued-maintenance build of the original `soulsign-chrome` browser extension.

Original project:

- `keg1255/soulsign-chrome`: https://github.com/keg1255/soulsign-chrome

## Project Status

This repository is maintained after the original project stopped active updates.

The original project was built around Manifest V2. Since current Chromium-based browsers no longer support Manifest V2, this repository continues the project by adapting it to Manifest V3 so it can keep running on newer browser versions.

In short:

- original upstream: Manifest V2
- this repository: Manifest V3
- current maintained version: `2.6.1`

## Overview

This repository contains a ready-to-load browser extension package, including:

- `manifest.json`: extension manifest
- `popup.html`: popup UI
- `options.html`: main management page
- `offscreen.html`: offscreen page
- `sandbox.html`: sandbox page
- `js/`: extension scripts
- `icons/`: extension icons
- `static/`: static assets
- `tools/`: verification scripts and manual regression checklist

## Local Load

1. Open `chrome://extensions` or the Edge extensions page.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select this project directory.

## Development Notes

- The extension version is defined in `manifest.json`.
- The visible app version in the options page should stay aligned with the manifest version.
- After UI or script changes, review `tools/manual-regression-checklist.md`.

## Verification

You can run the included verification scripts with Node.js:

```powershell
node .\tools\verify-offscreen-pure.js
node .\tools\verify-options-pure.js
node .\tools\verify-all.js
```

## Release

Current tag:

```text
v2.6.1
```
