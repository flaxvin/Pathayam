import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { readBody, fileField } from "./router.ts";

/** A request whose body is exactly these bytes. */
function request(contentType: string, body: Buffer): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers["content-type"] = contentType;
  req.push(body);
  req.push(null);
  return req;
}

function multipart(parts: { name: string; filename?: string; body: Buffer | string }[]): {
  contentType: string; body: Buffer;
} {
  const boundary = "----BudgetAppTest7f3a";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename !== undefined
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

describe("multipart uploads", () => {
  test("text fields come through as a normal body", async () => {
    const { contentType, body } = multipart([
      { name: "account_id", body: "acc-1" },
      { name: "password", body: "ABCDE1234F" },
    ]);
    const parsed = await readBody(request(contentType, body));
    assert.equal(parsed.account_id, "acc-1");
    assert.equal(parsed.password, "ABCDE1234F");
  });

  test("a binary file survives byte for byte", async () => {
    // The failure this guards against: decoding a PDF as UTF-8 replaces every
    // invalid byte with U+FFFD, which destroys the file while looking like it
    // worked. 0x80–0xFF are exactly the bytes that would be lost.
    const pdf = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
      0x80, 0x81, 0xfe, 0xff, 0x00, 0x0d, 0x0a, 0xc3, 0x28,
    ]);
    const { contentType, body } = multipart([
      { name: "account_id", body: "acc-1" },
      { name: "statement", filename: "cas.pdf", body: pdf },
    ]);

    const req = request(contentType, body);
    await readBody(req);

    const file = fileField(req, "statement");
    assert.ok(file, "the file part should be readable");
    assert.equal(file!.filename, "cas.pdf");
    assert.deepEqual(Buffer.from(file!.bytes), pdf);
  });

  test("an empty file input is not an upload", async () => {
    const { contentType, body } = multipart([
      { name: "statement", filename: "", body: "" },
    ]);
    const req = request(contentType, body);
    await readBody(req);
    assert.equal(fileField(req, "statement"), null);
  });

  test("a urlencoded body still parses", async () => {
    const parsed = await readBody(
      request("application/x-www-form-urlencoded", Buffer.from("a=1&b=two&b=three")),
    );
    assert.equal(parsed.a, "1");
    assert.deepEqual(parsed.b, ["two", "three"]);
  });

  test("B51 · a part with filename before name keeps the real field name", async () => {
    // Browsers send name before filename, but a hand-built client (the Gmail
    // and API multipart paths need not be browsers) may reverse them. The name
    // regex used to match the `name="…"` inside `filename="…"`, capturing the
    // filename as the field name and losing the upload.
    const boundary = "----BudgetAppTestReversed";
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x80, 0xff]);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          // filename FIRST, then name — the order that used to break it.
          `Content-Disposition: form-data; filename="cas.pdf"; name="statement"\r\n\r\n`,
      ),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = request(`multipart/form-data; boundary=${boundary}`, body);
    await readBody(req);

    const file = fileField(req, "statement");
    assert.ok(file, "the field name should be 'statement', not 'cas.pdf'");
    assert.equal(file!.filename, "cas.pdf");
    assert.deepEqual(Buffer.from(file!.bytes), pdf);
  });
});
