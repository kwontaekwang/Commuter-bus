import http from 'node:http';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

async function loadEnv() {
  try {
    const text = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      if (at < 1) continue;
      const key = line.slice(0, at).trim();
      let value = line.slice(at + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await loadEnv();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const DATA_PATH = path.resolve(process.env.DATA_PATH || path.join(ROOT, 'data', 'routes.json'));
const ORIGINAL_PATH = path.join(ROOT, 'data', 'original-routes.json');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('base64url');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

const sessions = new Map();
const attempts = new Map();

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function json(res, status, value, extra = {}) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(value));
}

function cleanText(value, label, { required = false, max = 160 } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${label}은(는) 필수입니다.`);
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    if (required) throw new Error(`${label}은(는) 필수입니다.`);
    return null;
  }
  if (text.length > max) throw new Error(`${label}은(는) ${max}자 이하여야 합니다.`);
  return text;
}

function normalizeDataset(input, current) {
  if (!input || !Array.isArray(input.routes)) throw new Error('노선 배열이 필요합니다.');
  if (input.routes.length < 1 || input.routes.length > 200) throw new Error('노선은 1~200개여야 합니다.');
  const ids = new Set();
  let stopCount = 0;
  const routes = input.routes.map((route, routeIndex) => {
    const id = cleanText(route.id, `노선 ${routeIndex + 1} ID`, { required: true, max: 16 });
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${id}: ID에는 영문, 숫자, _, -만 사용할 수 있습니다.`);
    if (ids.has(id)) throw new Error(`${id}: 중복 노선 ID입니다.`);
    ids.add(id);
    if (!Array.isArray(route.stops) || route.stops.length < 1 || route.stops.length > 500) throw new Error(`${id}: 정류장은 1~500개여야 합니다.`);
    stopCount += route.stops.length;
    if (stopCount > 10000) throw new Error('전체 정류장은 10,000개를 넘을 수 없습니다.');
    return {
      id,
      category: cleanText(route.category, `${id} 구분`, { required: true }),
      serviceType: cleanText(route.serviceType, `${id} 운행유형`, { required: true }),
      name: cleanText(route.name, `${id} 노선명`, { required: true }),
      period: cleanText(route.period, `${id} 운행시간대`, { required: true }),
      sourceImage: cleanText(route.sourceImage, `${id} 원본이미지`, { max: 80 }),
      stops: route.stops.map((stop, index) => ({
        sequence: index + 1,
        time: cleanText(stop.time, `${id} ${index + 1}번 시간`, { max: 30 }),
        station: cleanText(stop.station, `${id} ${index + 1}번 정류장`, { required: true, max: 200 }),
        boardingLocation: cleanText(stop.boardingLocation, `${id} ${index + 1}번 탑승위치`, { max: 200 }),
        note: cleanText(stop.note, `${id} ${index + 1}번 비고`, { max: 200 })
      }))
    };
  });
  const notices = Array.isArray(input.notices)
    ? input.notices.slice(0, 10).map((n, i) => cleanText(n, `안내 ${i + 1}`, { required: true, max: 300 }))
    : current.notices;
  return {
    schemaVersion: 1,
    revision: Number(current.revision || 0) + 1,
    source: current.source,
    notices,
    routes
  };
}

async function readDataset(file = DATA_PATH) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeDataset(next, current) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.writeFile(path.join(BACKUP_DIR, `routes-r${current.revision}-${stamp}.json`), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, DATA_PATH);
  const backups = (await fs.readdir(BACKUP_DIR)).filter((n) => n.endsWith('.json')).sort().reverse();
  await Promise.all(backups.slice(20).map((n) => fs.unlink(path.join(BACKUP_DIR, n)).catch(() => {})));
}

function publicDataset(data) {
  return {
    ...data,
    stats: {
      routeCount: data.routes.length,
      stopCount: data.routes.reduce((sum, route) => sum + route.stops.length, 0),
      categoryCount: new Set(data.routes.map((route) => route.category)).size
    }
  };
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))];
  }));
}

function sign(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function sessionFrom(req) {
  const value = parseCookies(req).commute_session;
  if (!value) return null;
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  const expected = sign(id);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL;
  return { id, ...session };
}

function setSessionCookie(res, id) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `commute_session=${encodeURIComponent(`${id}.${sign(id)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `commute_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function verifyPassword(password) {
  const configured = process.env.ADMIN_PASSWORD_HASH;
  if (configured) {
    try {
      const [scheme, n, r, p, salt, digest] = configured.split('$');
      if (scheme !== 'scrypt') return false;
      const actual = scryptSync(String(password), Buffer.from(salt, 'base64url'), Buffer.from(digest, 'base64url').length, {
        N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024
      });
      const expected = Buffer.from(digest, 'base64url');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  if (process.env.ADMIN_PASSWORD) {
    const actual = createHash('sha256').update(String(password)).digest();
    const expected = createHash('sha256').update(process.env.ADMIN_PASSWORD).digest();
    return timingSafeEqual(actual, expected);
  }
  return false;
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('요청 크기가 너무 큽니다.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('올바른 JSON이 아닙니다.'); error.status = 400; throw error; }
}

function requireAdmin(req, res, { csrf = false } = {}) {
  const session = sessionFrom(req);
  if (!session) {
    json(res, 401, { error: '관리자 로그인이 필요합니다.' });
    return null;
  }
  if (csrf && req.headers['x-csrf-token'] !== session.csrf) {
    json(res, 403, { error: '요청 검증에 실패했습니다. 새로고침 후 다시 시도해 주세요.' });
    return null;
  }
  return session;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

async function serveStatic(res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname === '/admin' || pathname === '/admin/' ? 'admin.html' : pathname.slice(1);
  let file = path.resolve(PUBLIC, relative);
  if (!file.startsWith(`${PUBLIC}${path.sep}`)) return false;
  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
    const content = await fs.readFile(file);
    securityHeaders(res);
    const immutable = /\.(?:woff2|svg)$/.test(file) ? 'public, max-age=604800' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': immutable });
    res.end(content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/data') {
      return json(res, 200, publicDataset(await readDataset()));
    }

    if (req.method === 'GET' && pathname === '/api/admin/session') {
      const session = sessionFrom(req);
      return json(res, 200, { authenticated: Boolean(session), csrf: session?.csrf || null, configured: Boolean(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD) });
    }

    if (req.method === 'POST' && pathname === '/api/admin/login') {
      const ip = clientIp(req);
      const record = attempts.get(ip) || { failures: 0, blockedUntil: 0 };
      if (record.blockedUntil > Date.now()) return json(res, 429, { error: '로그인 시도가 잠시 제한되었습니다. 5분 후 다시 시도해 주세요.' });
      const body = await bodyJson(req);
      if (!verifyPassword(body.password)) {
        record.failures += 1;
        if (record.failures >= 5) record.blockedUntil = Date.now() + 5 * 60 * 1000;
        attempts.set(ip, record);
        return json(res, 401, { error: '비밀번호가 올바르지 않습니다.' });
      }
      attempts.delete(ip);
      const id = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL });
      setSessionCookie(res, id);
      return json(res, 200, { authenticated: true, csrf });
    }

    if (req.method === 'POST' && pathname === '/api/admin/logout') {
      const session = sessionFrom(req);
      if (session) sessions.delete(session.id);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/admin/data') {
      if (!requireAdmin(req, res)) return;
      return json(res, 200, publicDataset(await readDataset()));
    }

    if (req.method === 'PUT' && pathname === '/api/admin/data') {
      if (!requireAdmin(req, res, { csrf: true })) return;
      const body = await bodyJson(req);
      const current = await readDataset();
      if (Number(body.expectedRevision) !== Number(current.revision)) return json(res, 409, { error: '다른 관리자가 먼저 저장했습니다. 데이터를 다시 불러와 주세요.', currentRevision: current.revision });
      let next;
      try { next = normalizeDataset(body, current); }
      catch (error) { return json(res, 400, { error: error.message }); }
      await writeDataset(next, current);
      return json(res, 200, publicDataset(next));
    }

    if (req.method === 'POST' && pathname === '/api/admin/reset') {
      if (!requireAdmin(req, res, { csrf: true })) return;
      const current = await readDataset();
      const original = await readDataset(ORIGINAL_PATH);
      const next = normalizeDataset(original, current);
      await writeDataset(next, current);
      return json(res, 200, publicDataset(next));
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = await serveStatic(res, pathname);
      if (served) return;
    }
    json(res, 404, { error: '요청한 항목을 찾을 수 없습니다.' });
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, { error: error.status ? error.message : '서버 오류가 발생했습니다.' });
  }
}

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`통근버스 앱: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD)) console.warn('관리자 비밀번호가 설정되지 않았습니다. 먼저 npm run setup을 실행하세요.');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
