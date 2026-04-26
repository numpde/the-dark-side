import test from "node:test";
import assert from "node:assert/strict";

import { buildGpx, wireGpxDownload } from "../web/gpx.mjs";


function sampleRoute(overrides = {}) {
  return {
    id: "route-123",
    coordinates: [
      [36.81, -1.23],
      [36.82, -1.24],
      [36.83, -1.25],
    ],
    elevations_m: [1700.12, 1710.34, 1705.56],
    ...overrides,
  };
}


const startJunction = { id: "a", name: "Family Trail west junction" };
const endJunction = { id: "b", name: "Kiambu-side exit junction" };


test("buildGpx emits GPX with elevation when available", () => {
  const gpx = buildGpx(sampleRoute(), startJunction, endJunction);
  assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1" creator="the-dark-side"/);
  assert.match(gpx, /<name>route-123<\/name>/);
  assert.match(gpx, /<name>Family Trail west junction to Kiambu-side exit junction<\/name>/);
  assert.match(gpx, /<trkpt lat="-1\.23" lon="36\.81">/);
  assert.match(gpx, /<ele>1700\.1<\/ele>/);
  assert.match(gpx, /<ele>1710\.3<\/ele>/);
});


test("buildGpx omits elevation tags when route elevations are absent", () => {
  const gpx = buildGpx(sampleRoute({ elevations_m: undefined }), startJunction, endJunction);
  assert.match(gpx, /<trkpt lat="-1\.23" lon="36\.81"><\/trkpt>/);
  assert.doesNotMatch(gpx, /<ele>/);
});


test("buildGpx escapes XML-sensitive route and junction names", () => {
  const gpx = buildGpx(
    sampleRoute({ id: 'route & <weird> "name"' }),
    { id: "a", name: "Start & climb" },
    { id: "b", name: "End <gate>" },
  );
  assert.match(gpx, /<name>route &amp; &lt;weird&gt; &quot;name&quot;<\/name>/);
  assert.match(gpx, /<name>Start &amp; climb to End &lt;gate&gt;<\/name>/);
});


test("wireGpxDownload sets href and filename and revokes previous URL", () => {
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  }

  const calls = {
    revoked: [],
    created: [],
  };
  const urlApi = {
    createObjectURL(blob) {
      calls.created.push(blob);
      return "blob:next";
    },
    revokeObjectURL(url) {
      calls.revoked.push(url);
    },
  };
  const link = { href: "", download: "" };

  const result = wireGpxDownload(link, {
    route: sampleRoute(),
    startJunction,
    endJunction,
    previousUrl: "blob:prev",
    urlApi,
    BlobCtor: FakeBlob,
  });

  assert.equal(link.href, "blob:next");
  assert.equal(link.download, "route-123.gpx");
  assert.equal(result.url, "blob:next");
  assert.equal(result.filename, "route-123.gpx");
  assert.deepEqual(calls.revoked, ["blob:prev"]);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].options.type, "application/gpx+xml");
  assert.match(calls.created[0].parts[0], /<gpx version="1\.1"/);
});
