import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../data/original-routes.json', import.meta.url), 'utf8'));

test('전체_정류장 변환 데이터의 건수가 일치한다', () => {
  assert.equal(data.source.sheetName, '전체_정류장');
  assert.equal(data.routes.length, 51);
  assert.equal(data.routes.reduce((sum, route) => sum + route.stops.length, 0), 462);
});

test('노선 ID와 순번이 안정적이다', () => {
  assert.equal(new Set(data.routes.map((route) => route.id)).size, 51);
  for (const route of data.routes) {
    assert.ok(route.name && route.category && route.serviceType && route.period);
    assert.deepEqual(route.stops.map((stop) => stop.sequence), Array.from({ length: route.stops.length }, (_, i) => i + 1));
    assert.ok(route.stops.every((stop) => stop.station));
  }
});

test('공란 시간과 미운행 값을 임의 변경하지 않았다', () => {
  const stops = data.routes.flatMap((route) => route.stops);
  assert.equal(stops.filter((stop) => stop.time === null).length, 119);
  assert.equal(stops.filter((stop) => stop.time === '미운행').length, 2);
  assert.equal(stops.filter((stop) => stop.boardingLocation === null).length, 462);
});
