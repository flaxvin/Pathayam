/**
 * The rastered icons, read once at startup.
 *
 * The manifest has named `/assets/icon-192.png` and its siblings since F21.1 was
 * built, and the static middleware served the stylesheet, the script and the
 * SVG — then threw NotFound for anything else under `/assets/`. So every icon
 * the manifest pointed at 404'd, and Chrome requires at least one that loads
 * before it will offer to install: the app has been un-installable for as long
 * as it has had a manifest.
 *
 * The files are generated from `icon.ts` by `npm run icons` and committed. They
 * are read from disk once here rather than embedded as base64, because a diff
 * full of base64 is a diff nobody reads. The path is resolved from this module,
 * so it works the same from `src/` under the type-stripper and from `dist/`
 * after a build — both are two directories below the repository root.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

function load(name: string): Buffer {
  return readFileSync(join(ASSETS, name));
}

/** Served under `/assets/<name>`, with the type a browser needs to accept it. */
export const ICON_FILES: Record<string, Buffer> = {
  "icon-192.png": load("icon-192.png"),
  "icon-512.png": load("icon-512.png"),
  "icon-maskable.png": load("icon-maskable.png"),
  "apple-touch-icon.png": load("apple-touch-icon.png"),
  "favicon-32.png": load("favicon-32.png"),
  "favicon-16.png": load("favicon-16.png"),
};
