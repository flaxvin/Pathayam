/**
 * TAX-AIS · The Tax page's AIS upload, end to end: a synthetic encrypted AIS
 * PDF posted the way a browser posts it, read with the password worked out
 * from the member's saved PAN and date of birth, shown, and offered into the
 * form without saving anything.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { setIdentity } from "../import/identity.ts";
import { aisPdf, sampleAis, AIS_PAN, AIS_DOB, AIS_PASSWORD } from "../import/ais.test-data.ts";
import { freshDb, seedMember, startTestApp, type TestApp, type TestConfigOverrides } from "./harness.test-data.ts";

function upload(app: TestApp, pdf: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("fy", "2025");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("statement", new Blob([pdf], { type: "application/pdf" }), "ais.pdf");
  return app.get("/tax/ais", { method: "POST", body: form, headers: { Origin: app.baseUrl } });
}

async function withApp(
  run: (app: TestApp) => Promise<void>,
  opts: { pan?: string | null; memberId?: string; config?: TestConfigOverrides } = {},
) {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  seedMember(db, "p", "Priya");
  if (opts.pan !== null) {
    setIdentity(db, { memberId: "m", source: "ui" }, { name: "Ravi", pan: opts.pan ?? AIS_PAN, dob: AIS_DOB });
  }
  const app = await startTestApp(db, { memberId: opts.memberId ?? "m", config: opts.config });
  try {
    await run(app);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
}

const tdsField = (page: string) => /id="tds" name="tds"[^>]*value="([^"]+)"/.exec(page)?.[1];
const grossField = (page: string) => /id="gross" name="gross"[^>]*value="([^"]+)"/.exec(page)?.[1];
const lines = (app: TestApp) => queryOne<{ n: number }>(app.db, `SELECT COUNT(*) AS n FROM ais_lines`)!.n;

describe("TAX-AIS · uploading an AIS on the Tax page", () => {
  test("the page offers the upload", async () => {
    await withApp(async (app) => {
      const page = await (await app.get("/tax?fy=2025")).text();
      assert.match(page, /action="\/tax\/ais" enctype="multipart\/form-data"/);
    });
  });

  test("opens with the saved PAN and date of birth, and shows what it read", async () => {
    await withApp(async (app) => {
      const res = await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      assert.equal(res.status, 303);
      assert.match(res.headers.get("location")!, /^\/tax\?fy=2025/);
      const page = await (await app.get("/tax?fy=2025")).text();
      assert.match(page, /EXAMPLE SOFTWARE LTD/);
      assert.match(page, /₹85,800/);
      assert.match(page, /Its PAN matched/);
      assert.match(page, /Rent received/);
      // Shown, not applied: the form's TDS is still what was saved (nothing).
      assert.equal(tdsField(page), "0.00");
    });
  });

  test("a typed password works too", async () => {
    await withApp(async (app) => {
      const res = await upload(app, aisPdf(sampleAis(), AIS_PASSWORD), { password: AIS_PASSWORD });
      assert.equal(res.status, 303);
      assert.ok(lines(app) > 0);
    }, { pan: null });
  });

  test("a wrong password is said plainly, and nothing is stored", async () => {
    await withApp(async (app) => {
      const page = await (await upload(app, aisPdf(sampleAis(), AIS_PASSWORD), { password: "wrong" })).text();
      assert.match(page, /did not open it/);
      assert.equal(lines(app), 0);
    });
  });

  test("another person's AIS is refused", async () => {
    await withApp(async (app) => {
      const page = await (await upload(app, aisPdf(sampleAis({ pan: "ZYXWV9876A" })), {})).text();
      assert.match(page, /not the PAN saved for you/);
      assert.equal(lines(app), 0);
    });
  });

  test("with no saved PAN it is imported, with a warning", async () => {
    await withApp(async (app) => {
      const res = await upload(app, aisPdf(sampleAis()));
      assert.equal(res.status, 303);
      assert.match(decodeURIComponent(res.headers.get("location")!), /could not be checked as yours/);
    }, { pan: null });
  });

  test("a year with no slabs in the app is refused", async () => {
    await withApp(async (app) => {
      const form = new FormData();
      form.set("fy", "2024");
      form.set("statement", new Blob([aisPdf(sampleAis({ fy: "2024-25" }))], { type: "application/pdf" }), "ais.pdf");
      const page = await (await app.get("/tax/ais", { method: "POST", body: form, headers: { Origin: app.baseUrl } })).text();
      assert.equal(lines(app), 0);
      assert.match(page, /The rates for 2024-25 are not in this app/);
    });
  });

  test("a file for another year than the page's is refused", async () => {
    await withApp(async (app) => {
      const page = await (await upload(app, aisPdf(sampleAis({ fy: "2026-27" })))).text();
      assert.match(page, /Switch to FY 2026-27 above/);
      assert.equal(lines(app), 0);
    });
  });

  test("uploading the same AIS twice leaves the same lines", async () => {
    await withApp(async (app) => {
      await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      const once = lines(app);
      await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      assert.equal(lines(app), once);
    });
  });
});

describe("TAX-AIS · using its figures", () => {
  test("fills TDS and gross in the form, saves nothing until Save", async () => {
    await withApp(async (app) => {
      await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      const page = await (await app.get("/tax?fy=2025&from=ais")).text();
      assert.equal(tdsField(page), "85800.00");
      assert.equal(grossField(page), "1262200.00");
      assert.match(page, /Nothing is saved until you press Save/);
      assert.equal(queryOne(app.db, `SELECT 1 FROM tax_declarations`), null);

      await app.post("/tax", { fy: "2025", gross: "1262200.00", tds: "85800.00", s80c: "0", s80d: "0", other: "0" });
      assert.equal(tdsField(await (await app.get("/tax?fy=2025")).text()), "85800.00");
    });
  });

  test("forgetting it removes the figures and leaves the saved form alone", async () => {
    await withApp(async (app) => {
      await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      await app.post("/tax", { fy: "2025", gross: "100", tds: "5", s80c: "0", s80d: "0", other: "0" });
      const res = await app.post("/tax/ais/delete", { fy: "2025" });
      assert.equal(res.status, 303);
      assert.equal(lines(app), 0);
      assert.equal(tdsField(await (await app.get("/tax?fy=2025")).text()), "5.00");
    });
  });
});

describe("TAX-AIS · privacy and the demo", () => {
  test("another member's Tax page shows none of it, and cannot forget it", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    seedMember(db, "p", "Priya");
    setIdentity(db, { memberId: "m", source: "ui" }, { name: "Ravi", pan: AIS_PAN, dob: AIS_DOB });
    const ravi = await startTestApp(db, { memberId: "m" });
    const priya = await startTestApp(db, { memberId: "p" });
    try {
      await upload(ravi, aisPdf(sampleAis(), AIS_PASSWORD));
      for (const path of ["/tax?fy=2025", "/tax?fy=2025&from=ais"]) {
        const page = await (await priya.get(path)).text();
        assert.doesNotMatch(page, /EXAMPLE SOFTWARE|₹85,800|Forget this AIS/);
        assert.equal(tdsField(page), "0.00");
      }
      await priya.post("/tax/ais/delete", { fy: "2025" });
      assert.ok(lines(ravi) > 0);
      assert.deepEqual([...ravi.failures, ...priya.failures], []);
    } finally {
      await ravi.close();
      await priya.close();
    }
  });

  test("the demo refuses the upload and stores nothing", async () => {
    await withApp(async (app) => {
      const page = await (await app.get("/tax?fy=2025")).text();
      assert.doesNotMatch(page, /action="\/tax\/ais"/);
      const res = await upload(app, aisPdf(sampleAis(), AIS_PASSWORD));
      assert.equal(res.status, 403);
      assert.equal(lines(app), 0);
    }, { config: { demoMode: true } });
  });
});
