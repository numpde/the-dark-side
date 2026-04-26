export function gpxFilename(route) {
  return `${route.id}.gpx`;
}


function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}


export function buildGpx(route, startJunction, endJunction) {
  const hasElevations =
    Array.isArray(route.elevations_m) &&
    route.elevations_m.length === route.coordinates.length;
  const trackPoints = route.coordinates
    .map(([lon, lat], index) => {
      if (!hasElevations) {
        return `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`;
      }
      return [
        `      <trkpt lat="${lat}" lon="${lon}">`,
        `        <ele>${route.elevations_m[index].toFixed(1)}</ele>`,
        "      </trkpt>",
      ].join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="the-dark-side" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEscape(route.id)}</name>
  </metadata>
  <trk>
    <name>${xmlEscape(startJunction.name)} to ${xmlEscape(endJunction.name)}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>
`;
}


export function wireGpxDownload(
  link,
  {
    route,
    startJunction,
    endJunction,
    previousUrl = null,
    urlApi = URL,
    BlobCtor = Blob,
  },
) {
  const gpx = buildGpx(route, startJunction, endJunction);
  if (previousUrl) {
    urlApi.revokeObjectURL(previousUrl);
  }
  const blob = new BlobCtor([gpx], { type: "application/gpx+xml" });
  const url = urlApi.createObjectURL(blob);
  link.href = url;
  link.download = gpxFilename(route);
  return { url, filename: link.download, gpx, blob };
}
