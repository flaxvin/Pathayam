/**
 * The envelope select, executed rather than read.
 *
 * `client.test.ts` checks the script parses and avoids the things that have
 * silently broken the asset. This runs one rule in it against a stub DOM,
 * because the rule had a bug no source-level assertion would have found.
 *
 * Under the old form the envelope box above the split section meant nothing
 * once lines were in use, so the script disabled it while somebody typed them.
 * The lines redesign made that box the *first line* — the one that takes
 * whatever the others leave — and the disabling stayed. A disabled select is
 * not submitted, so a ₹5,000 expense with ₹1,200 on the second line reached
 * the server with no first envelope at all and was filed, whole and unsplit,
 * into the second. The forms looked right and the server was right; the bug
 * lived entirely in the two hundred milliseconds between them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_SCRIPT } from "./client.ts";

/**
 * Just enough DOM for the script to load and for one rule to be observable.
 *
 * Everything the script touches and this test does not care about answers with
 * a no-op, so the stub does not have to grow a method every time some unrelated
 * feature is added to the script. The nodes the rule *does* read are real
 * objects, and what it writes to them is what the assertions look at.
 */
function forgiving(real: Record<string, unknown> = {}): any {
  const node: any = new Proxy(real, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop];
      if (prop === "style" || prop === "dataset") return {};
      if (prop === "classList") {
        return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      }
      if (prop === "querySelectorAll" || prop === "children") return () => [];
      if (prop === "querySelector" || prop === "closest") return () => null;
      if (prop === "getAttribute") return () => null;
      if (prop === "hasAttribute") return () => false;
      if (prop === Symbol.toPrimitive || typeof prop === "symbol") return undefined;
      return () => undefined;
    },
    set(target, prop: string, value) { (target as any)[prop] = value; return true; },
  });
  return node;
}

function stubDom(opts: { direction: "in" | "out"; splitAmount: string }) {
  const blankOption = forgiving({ value: "", textContent: "" });
  const direction = forgiving({ name: "direction", value: opts.direction, tagName: "SELECT" });
  const splitAmount = forgiving({ name: "split_amount_1", value: opts.splitAmount, tagName: "INPUT" });

  const attrs = new Set(["data-requires-category"]);
  const envelope = forgiving({
    id: "split_category_0",
    name: "split_category_0",
    tagName: "SELECT",
    required: false,
    disabled: false,
    hasAttribute: (a: string) => attrs.has(a),
    querySelector: (sel: string) => (sel.includes('value=""') ? blankOption : null),
  });

  const form = forgiving({
    querySelector: (sel: string) => (sel.includes("direction") ? direction : null),
    querySelectorAll: (sel: string) => (sel.includes("split_amount_") ? [splitAmount] : []),
  });
  envelope.form = form;

  const document = forgiving({
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: (sel: string) =>
      (sel.includes("data-requires-category") ? [envelope] : []),
    createElement: () => forgiving({}),
    body: forgiving({}),
    documentElement: forgiving({}),
    cookie: "",
    readyState: "complete",
  });

  const window = forgiving({
    addEventListener() {},
    matchMedia: () => forgiving({ matches: false }),
    location: forgiving({ href: "http://localhost/add", pathname: "/add", search: "", hash: "" }),
    history: forgiving({}),
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    fetch: () => Promise.resolve(forgiving({ ok: true })),
  });

  return { document, window, envelope, blankOption };
}

function run(opts: { direction: "in" | "out"; splitAmount: string }) {
  const dom = stubDom(opts);
  const fn = new Function(
    "document", "window", "navigator", "fetch", "setTimeout", "clearTimeout",
    "requestAnimationFrame", "MutationObserver", "FormData", "console",
    CLIENT_SCRIPT,
  );
  fn(
    dom.document, dom.window, forgiving({ userAgent: "test" }), dom.window.fetch,
    () => 0, () => {}, dom.window.requestAnimationFrame,
    class { observe() {} disconnect() {} },
    class { entries() { return [][Symbol.iterator](); } get() { return null; } },
    forgiving({}),
  );
  return dom;
}

describe("the envelope select, as the browser leaves it", () => {
  test("stays submittable while a split line carries an amount", () => {
    const dom = run({ direction: "out", splitAmount: "1200" });
    assert.equal(
      dom.envelope.disabled, false,
      "the first line is disabled, so the browser will not send it and the " +
      "remainder will be filed into the second envelope instead",
    );
  });

  test("an expense still has to name it, split or not", () => {
    assert.equal(run({ direction: "out", splitAmount: "" }).envelope.required, true);
    assert.equal(
      run({ direction: "out", splitAmount: "1200" }).envelope.required, true,
      "the remainder line would be left uncategorised, which B99 refuses",
    );
  });

  test("money coming in does not have to name one", () => {
    assert.equal(run({ direction: "in", splitAmount: "" }).envelope.required, false);
  });

  test("the empty option says what choosing nothing means", () => {
    assert.match(run({ direction: "out", splitAmount: "" }).blankOption.textContent, /where it came from/i);
    assert.match(run({ direction: "in", splitAmount: "" }).blankOption.textContent, /Ready to Assign/i);
  });
});
