import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { html, raw, escape, when, classes, jsonScript } from "./html.ts";

describe("escaping", () => {
  test("escapes interpolated values by default", () => {
    const evil = '<script>alert("x")</script>';
    assert.equal(
      html`<p>${evil}</p>`.value,
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
  });

  test("escapes attribute-breaking characters", () => {
    const breakout = '" onload="evil()';
    assert.equal(
      html`<a title="${breakout}">x</a>`.value,
      '<a title="&quot; onload=&quot;evil()">x</a>',
    );
    assert.equal(escape("it's"), "it&#39;s");
  });

  test("passes through only what is explicitly marked safe", () => {
    assert.equal(html`<p>${raw("<b>bold</b>")}</p>`.value, "<p><b>bold</b></p>");
  });

  test("escapes each item of an array", () => {
    assert.equal(html`${["<a>", "<b>"]}`.value, "&lt;a&gt;&lt;b&gt;");
  });

  test("renders nested templates without double-escaping", () => {
    const inner = html`<b>${"a & b"}</b>`;
    assert.equal(html`<p>${inner}</p>`.value, "<p><b>a &amp; b</b></p>");
  });

  test("renders null, undefined and false as nothing", () => {
    assert.equal(html`[${null}${undefined}${false}]`.value, "[]");
  });

  test("renders zero, which is a real value and not emptiness", () => {
    assert.equal(html`${0}`.value, "0");
  });
});

describe("helpers", () => {
  test("when renders only on a truthy condition", () => {
    assert.equal(when(true, () => html`<b>yes</b>`).value, "<b>yes</b>");
    assert.equal(when(false, () => html`<b>yes</b>`).value, "");
    assert.equal(when(0, () => html`<b>yes</b>`).value, "");
  });

  test("classes drops falsy parts", () => {
    assert.equal(classes("a", false, null, "b", undefined), "a b");
  });

  test("jsonScript neutralises a closing script tag", () => {
    assert.equal(jsonScript({ x: "</script>" }).value, '{"x":"\\u003c/script>"}');
  });
});
