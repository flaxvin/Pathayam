/**
 * td-UI-15 · "Skip to content" was the fourth or fifth Tab stop: it came after
 * the header's logo, Add, theme and name links (and after the demo or
 * impersonation banner's controls), so a keyboard user tabbed through the
 * header to reach the link that exists to skip the header. It is now the
 * first focusable thing in the body.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { page } from "./layout.ts";
import { raw } from "../http/html.ts";

const firstFocusable = (doc: string): string => {
  const body = doc.slice(doc.indexOf("<body"));
  const m = body.match(/<(a|button|input|select|textarea)\b[^>]*>/);
  return m ? m[0] : "";
};

test("the skip link is the first focusable element on a full page", () => {
  const full = page({ title: "Budget", theme: "system", memberName: "Meera", devMode: true } as Parameters<typeof page>[0], raw("<p>hello</p>"));
  assert.match(firstFocusable(full), /class="skip-link" href="#main"/);
  assert.ok(full.indexOf('class="skip-link"') < full.indexOf('class="app-header"'), "before the header");
});

test("and on a bare page", () => {
  const bare = page({ title: "Sign in", theme: "system", bare: true, demoMode: true } as Parameters<typeof page>[0], raw("<p>hello</p>"));
  assert.match(firstFocusable(bare), /class="skip-link" href="#main"/);
});
