/**
 * WEB-5 · A request body is a bag of fields and nothing else.
 *
 * The parsed body was a plain `{}`. A repeated `__proto__` form key, or a JSON
 * `"__proto__": [...]`, went through the `__proto__` setter and made the body
 * an array; and a name nobody sent — `constructor`, `toString` — read back as
 * Object.prototype's function instead of absent. No route reads one today, so
 * it was harmless, but `field()` should never see anything the client did not
 * send. The body is now built on a null prototype.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { readBody, field } from "./router.ts";

function request(contentType: string, body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers["content-type"] = contentType;
  req.push(Buffer.from(body));
  req.push(null);
  return req;
}

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";

describe("WEB-5 · a body has no prototype to change", () => {
  test("a repeated __proto__ form key is a field, not a prototype", async () => {
    const body = await readBody(request(FORM, "__proto__=a&__proto__=b&name=x"));
    assert.equal(Object.getPrototypeOf(body), null);
    assert.deepEqual(body["__proto__"], ["a", "b"]);
    assert.equal(field(body, "name"), "x");
  });

  test("a JSON __proto__ array is a field, not a prototype", async () => {
    const body = await readBody(request(JSON_TYPE, `{"__proto__":["a","b"],"name":"x"}`));
    assert.equal(Object.getPrototypeOf(body), null);
    assert.equal(field(body, "length"), undefined);
    assert.equal(field(body, "name"), "x");
  });

  test("a name nobody sent reads as absent, on every kind of body", async () => {
    const multipart = "----WebFiveBoundary";
    const bodies = await Promise.all([
      readBody(request(FORM, "name=x")),
      readBody(request(FORM, "")),
      readBody(request(JSON_TYPE, `{"name":"x"}`)),
      readBody(request(JSON_TYPE, "[1,2]")),
      readBody(request(
        `multipart/form-data; boundary=${multipart}`,
        `--${multipart}\r\nContent-Disposition: form-data; name="name"\r\n\r\nx\r\n--${multipart}--\r\n`,
      )),
    ]);
    for (const body of bodies) {
      assert.equal(Object.getPrototypeOf(body), null);
      for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
        assert.equal(field(body, name), undefined, name);
      }
    }
  });
});
