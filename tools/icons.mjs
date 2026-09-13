/**
 * Raster the app icon, from the one drawing that defines it.
 *
 * `src/web/icon.ts` is the source: a browser gets the SVG, and everything that
 * cannot take an SVG — a home-screen tile, an iOS bookmark, an old tab bar —
 * gets a PNG made here. Committing the PNGs rather than rendering them at boot
 * keeps the app dependency-free; regenerating them is one command, so the two
 * cannot drift as long as whoever changes the drawing runs it.
 *
 *   npm run icons
 *
 * Needs ImageMagick (`magick`), which is a build-time tool, not a dependency of
 * the running app.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ICON_SVG, APP_ICON_MASKABLE_SVG, APP_ICON_SMALL_SVG } from "../src/web/icon.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = join(ROOT, "assets");
const work = mkdtempSync(join(tmpdir(), "pathayam-icons-"));

/**
 * Each output, and which drawing it comes from. The small mark is for the two
 * sizes where the full one turns to mush; the maskable one is drawn smaller so
 * Android's circular crop lands on colour (F21.1).
 */
const OUTPUTS = [
  { file: "icon-512.png", svg: APP_ICON_SVG, size: 512 },
  { file: "icon-192.png", svg: APP_ICON_SVG, size: 192 },
  { file: "apple-touch-icon.png", svg: APP_ICON_SVG, size: 180 },
  { file: "icon-maskable.png", svg: APP_ICON_MASKABLE_SVG, size: 512 },
  { file: "favicon-32.png", svg: APP_ICON_SMALL_SVG, size: 32 },
  { file: "favicon-16.png", svg: APP_ICON_SMALL_SVG, size: 16 },
];

try {
  mkdirSync(OUT, { recursive: true });
  for (const { file, svg, size } of OUTPUTS) {
    const source = join(work, file.replace(".png", ".svg"));
    writeFileSync(source, svg);
    execFileSync("magick", [
      "-background", "none",
      "-density", "600",            // rasterise the vector large, then resample
      source,
      "-resize", `${size}x${size}`,
      "-strip",                      // no timestamps, so a rerun is a no-op in git
      join(OUT, file),
    ]);
    process.stdout.write(`  ${file}  ${size}×${size}\n`);
  }

  // The marketing site shares the mark, so it shares the file.
  writeFileSync(join(ROOT, "website", "img", "icon.svg"), APP_ICON_SVG);
  execFileSync("cp", [join(OUT, "favicon-32.png"), join(ROOT, "website", "favicon.png")]);
  process.stdout.write("  website/img/icon.svg, website/favicon.png\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
