/**
 * UIQ-4 · The theme toggle does something on the first press, whatever the
 * phone is set to.
 *
 * A member's theme starts as "system". The server cannot see the device's
 * preference, so the header offered "Switch to dark theme" (☾) to everybody on
 * "system" — and on a phone already in dark mode, pressing it stored "dark" and
 * changed nothing on screen. The palette's "Toggle theme" did the same. The
 * client now reads the device's preference into the header control, and tells
 * the palette's toggle what is actually on screen.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp, type TestApp } from "./harness.test-data.ts";
import { CLIENT_SCRIPT } from "./client.ts";

const theme = (app: TestApp) =>
  queryOne<{ theme: string }>(app.db, `SELECT theme FROM members WHERE id = ?`, RAVI)!.theme;

describe("UIQ-4 · toggling away from 'system'", () => {
  let app: TestApp;
  before(async () => {
    const db = freshHousehold();
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    app = await startTestApp(db, { memberId: RAVI });
  });
  after(() => app.close());

  const reset = () => execute(app.db, `UPDATE members SET theme = 'system' WHERE id = ?`, RAVI);

  test("a device showing dark asks the palette toggle for light", async () => {
    reset();
    const res = await app.post("/settings/theme-toggle", { return_to: "/", seen: "dark" });
    assert.equal(res.status, 303);
    assert.equal(theme(app), "light");
  });

  test("a device showing light gets dark", async () => {
    reset();
    await app.post("/settings/theme-toggle", { return_to: "/", seen: "light" });
    assert.equal(theme(app), "dark");
  });

  test("a stored theme still flips as before, whatever is claimed", async () => {
    execute(app.db, `UPDATE members SET theme = 'dark' WHERE id = ?`, RAVI);
    await app.post("/settings/theme-toggle", { return_to: "/", seen: "dark" });
    assert.equal(theme(app), "light");
  });

  test("the client reads the device preference into the header toggle, on load and after a swap", () => {
    assert.match(CLIENT_SCRIPT, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
    assert.ok((CLIENT_SCRIPT.match(/syncThemeToggle\(\)/g) ?? []).length >= 2, "called on load and after the header is swapped");
    assert.match(CLIENT_SCRIPT, /name = "seen"/, "the palette's toggle says what is on screen");
  });
});
