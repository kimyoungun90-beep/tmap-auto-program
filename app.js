export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST만 지원합니다.' });
    return;
  }

  const appKey = process.env.TMAP_APP_KEY;
  if (!appKey) {
    res.status(200).json({ ok: false, error: 'Vercel 환경변수 TMAP_APP_KEY가 없습니다.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const start = body.start || {};
    const end = body.end || {};

    const s = await normalizePoint(start, appKey);
    const e = await normalizePoint(end, appKey);
    if (!s.ok) return res.status(200).json({ ok: false, error: `출발지 좌표 변환 실패: ${s.error}` });
    if (!e.ok) return res.status(200).json({ ok: false, error: `도착지 좌표 변환 실패: ${e.error}` });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://apis.openapi.sk.com/tmap/routes?version=1&format=json', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'appKey': appKey
      },
      body: JSON.stringify({
        startX: String(s.lon),
        startY: String(s.lat),
        endX: String(e.lon),
        endY: String(e.lat),
        startName: start.name || '출발지',
        endName: end.name || '도착지',
        reqCoordType: 'WGS84GEO',
        resCoordType: 'WGS84GEO',
        searchOption: '0',
        trafficInfo: 'Y'
      })
    });

    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      res.status(200).json({ ok: false, error: data?.error?.message || data?.message || `TMAP HTTP ${response.status}` });
      return;
    }

    const summary = extractSummary(data);
    if (!summary || !summary.totalDistance) {
      res.status(200).json({ ok: false, error: 'TMAP 응답에서 거리 정보를 찾지 못했습니다.' });
      return;
    }

    res.status(200).json({
      ok: true,
      distanceKm: Math.round((Number(summary.totalDistance) / 1000) * 10) / 10,
      distanceMeters: Number(summary.totalDistance) || 0,
      timeMin: Math.round((Number(summary.totalTime) || 0) / 60),
      toll: Number(summary.totalFare || 0),
      taxiFare: Number(summary.taxiFare || 0),
      start: { name: start.name || '', address: start.address || '', lon: s.lon, lat: s.lat },
      end: { name: end.name || '', address: end.address || '', lon: e.lon, lat: e.lat }
    });
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'TMAP 호출 시간 초과' : (err?.message || String(err));
    res.status(200).json({ ok: false, error: message });
  }
}

async function normalizePoint(point, appKey) {
  const lon = Number(point.lon ?? point.x);
  const lat = Number(point.lat ?? point.y);
  if (Number.isFinite(lon) && Number.isFinite(lat)) return { ok: true, lon, lat };
  const address = String(point.address || '').trim();
  if (!address) return { ok: false, error: '주소가 비어 있습니다.' };
  return geocode(address, appKey);
}

async function geocode(address, appKey) {
  const url = new URL('https://apis.openapi.sk.com/tmap/geo/fullAddrGeo');
  url.searchParams.set('version', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('coordType', 'WGS84GEO');
  url.searchParams.set('fullAddr', address);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const response = await fetch(url.toString(), {
    method: 'GET',
    signal: controller.signal,
    headers: { 'Accept': 'application/json', 'appKey': appKey }
  });
  clearTimeout(timeout);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) return { ok: false, error: data?.error?.message || data?.message || `TMAP 지오코딩 HTTP ${response.status}` };

  const coord = data?.coordinateInfo?.coordinate?.[0] || data?.coordinateInfo?.newLatEntr || data?.coordinate?.[0];
  const lon = Number(coord?.lon || coord?.newLon || coord?.frontLon);
  const lat = Number(coord?.lat || coord?.newLat || coord?.frontLat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { ok: false, error: `주소 좌표를 찾지 못했습니다: ${address}` };
  }
  return { ok: true, lon, lat };
}

function extractSummary(data) {
  if (!data) return null;
  if (Array.isArray(data.features)) {
    const first = data.features.find(f => f?.properties?.totalDistance);
    if (first) return first.properties;
  }
  if (data.properties?.totalDistance) return data.properties;
  if (data.totalDistance) return data;
  return null;
}
