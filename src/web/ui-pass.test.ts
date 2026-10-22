/**
 * UI-PASS · What a second browser sweep, driving every form, turned up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CLIENT_SCRIPT } from "./client.ts";

describe("UI-PASS-1 · a destructive form asks first, under the CSP", () => {
  test("no template carries an inline event handler the CSP would refuse", () => {
    const dir = new URL("./pages/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const name of ["../../app.ts", "../layout.ts"]) files.push(name);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      assert.doesNotMatch(source, /\son(submit|click|change|input)="/, `${file} has an inline handler`);
    }
  });

  test("the client asks the form's data-confirm question before it posts", () => {
    assert.match(CLIENT_SCRIPT, /form\.dataset\.confirm && !window\.confirm\(form\.dataset\.confirm\)/);
    const manage = readFileSync(new URL("./pages/manage.ts", import.meta.url), "utf8");
    assert.match(manage, /action="\/categories\/\$\{c\.id\}\/delete"\s+data-confirm="/);
  });
});
