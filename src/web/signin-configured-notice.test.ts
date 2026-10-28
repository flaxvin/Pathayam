/**
 * With LOCAL_LOGIN=1 on a brand-new household the sign-in page offered the
 * password form and "set it here" for the first password, and under them said
 * "No way to sign in is configured. Set LOCAL_LOGIN=1 …" — telling the person
 * installing it to set the very thing they had set. Found on first run in a
 * browser. The warning belongs only to a server with no door at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startTestApp, testConfig } from "./harness.test-data.ts";

async function signinPage(config: Parameters<typeof testConfig>[0]): Promise<string> {
  const app = await startTestApp(freshDb(), { memberId: null, config: testConfig(config) });
  try {
    return await (await app.get("/signin")).text();
  } finally {
    await app.close();
  }
}

test("local login on: no 'no way to sign in' warning", async () => {
  const page = await signinPage({ localLogin: true });
  assert.match(page, /action="\/auth\/password"/, "the password form is offered");
  assert.doesNotMatch(page, /No way to sign in is configured/);
});

test("nothing configured: the warning is still there", async () => {
  const page = await signinPage({ localLogin: false });
  assert.match(page, /No way to sign in is configured/);
});
