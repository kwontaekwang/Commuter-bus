import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
let child, base, temp;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

test.before(async () => {
  const port = await freePort();
  temp = await mkdtemp(path.join(os.tmpdir(), 'commute-app-'));
  await copyFile(path.join(root, 'data', 'original-routes.json'), path.join(temp, 'routes.json'));
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_PATH: path.join(temp, 'routes.json'), BACKUP_DIR: path.join(temp, 'backups'), ADMIN_PASSWORD: 'correct-horse-battery-staple', SESSION_SECRET: 'test-secret-with-sufficient-entropy' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/data`);
});

test.after(async () => {
  child?.kill('SIGTERM');
  await new Promise((resolve) => child?.once('exit', resolve));
  await rm(temp, { recursive: true, force: true });
});

test('공개 API는 51개 노선과 462개 기록을 반환한다', async () => {
  const response = await fetch(`${base}/api/data`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.stats.routeCount, 51);
  assert.equal(data.stats.stopCount, 462);
});

test('관리자 데이터는 로그인 없이 접근할 수 없다', async () => {
  assert.equal((await fetch(`${base}/api/admin/data`)).status, 401);
});

test('비밀번호 로그인, CSRF, 리비전 저장이 동작한다', async () => {
  const bad = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong-password' }) });
  assert.equal(bad.status, 401);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery-staple' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const admin = await fetch(`${base}/api/admin/data`, { headers: { Cookie: cookie } });
  const data = await admin.json();
  assert.equal(admin.status, 200);

  const noCsrf = await fetch(`${base}/api/admin/data`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: data.revision, routes: data.routes, notices: data.notices }) });
  assert.equal(noCsrf.status, 403);

  const routes = structuredClone(data.routes);
  routes[0].name = '테스트 수정 노선';
  const saved = await fetch(`${base}/api/admin/data`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ expectedRevision: data.revision, routes, notices: data.notices }) });
  assert.equal(saved.status, 200);
  const next = await saved.json();
  assert.equal(next.revision, data.revision + 1);
  assert.equal(next.routes[0].name, '테스트 수정 노선');

  const stale = await fetch(`${base}/api/admin/data`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ expectedRevision: data.revision, routes, notices: data.notices }) });
  assert.equal(stale.status, 409);
});

test('정적 파일의 경로 이탈을 허용하지 않는다', async () => {
  const response = await fetch(`${base}/..%2Fpackage.json`);
  assert.equal(response.status, 404);
});
