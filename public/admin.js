const $ = (selector) => document.querySelector(selector);
const state = { csrf: null, data: null, selectedId: null, dirty: false, draftRoute: null };

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  if (state.csrf && !['GET', undefined].includes(options.method)) headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(url, { ...options, headers });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    error.payload = value;
    throw error;
  }
  return value;
}

function message(text, error = false) {
  const el = $('#admin-message');
  el.textContent = text;
  el.className = `admin-message${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => { el.hidden = true; }, 5000);
}

function setLoggedIn(value) {
  $('#login-panel').hidden = value;
  $('#admin-panel').hidden = !value;
}

async function checkSession() {
  try {
    const session = await api('/api/admin/session');
    $('#setup-hint').hidden = session.configured;
    if (!session.authenticated) return setLoggedIn(false);
    state.csrf = session.csrf;
    setLoggedIn(true);
    await loadData();
  } catch (error) {
    $('#login-message').textContent = error.message;
  }
}

async function loadData(preferredId) {
  state.data = await api('/api/admin/data');
  state.draftRoute = null;
  $('#admin-summary').textContent = `${state.data.stats.routeCount}개 노선 · ${state.data.stats.stopCount}개 정류장 기록 · 데이터 버전 ${state.data.revision}`;
  const exists = state.data.routes.some((route) => route.id === preferredId);
  state.selectedId = exists ? preferredId : (state.selectedId && state.data.routes.some((route) => route.id === state.selectedId) ? state.selectedId : state.data.routes[0]?.id);
  state.dirty = false;
  renderRouteList();
  renderEditor();
}

function routeSearchMatch(route) {
  const q = $('#admin-search').value.trim().toLocaleLowerCase('ko-KR');
  return !q || `${route.id} ${route.category} ${route.serviceType} ${route.name}`.toLocaleLowerCase('ko-KR').includes(q);
}

function renderRouteList() {
  const container = $('#admin-route-list');
  const routes = state.draftRoute ? [...state.data.routes, state.draftRoute] : state.data.routes;
  container.replaceChildren(...routes.filter(routeSearchMatch).map((route) => {
    const button = make('button', `route-list-button${route.id === state.selectedId ? ' active' : ''}`);
    button.type = 'button';
    button.append(make('strong', '', `${route.id} · ${route.name}`), make('span', '', `${route.category} / ${route.period}`));
    button.addEventListener('click', () => selectRoute(route.id));
    return button;
  }));
}

function selectRoute(id) {
  if (state.dirty && !confirm('저장하지 않은 변경사항을 버리고 다른 노선을 선택할까요?')) return;
  if (state.draftRoute && state.draftRoute.id !== id) state.draftRoute = null;
  state.selectedId = id;
  state.dirty = false;
  renderRouteList();
  renderEditor();
}

function selectedRoute() {
  if (state.draftRoute?.id === state.selectedId) return state.draftRoute;
  return state.data.routes.find((route) => route.id === state.selectedId);
}

function inputField(className, value, placeholder, maxLength = 200) {
  const input = make('input', `stop-field ${className}`.trim());
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.addEventListener('input', () => { state.dirty = true; });
  return input;
}

function stopRow(stop) {
  const row = document.createElement('tr');
  row.append(document.createElement('td'));
  row.children[0].textContent = stop.sequence;
  for (const [key, className, placeholder, max] of [
    ['time', 'time', '예: 05:20', 30], ['station', 'station', '정류장명', 200],
    ['boardingLocation', '', '탑승위치', 200], ['note', '', '비고', 200]
  ]) {
    const cell = document.createElement('td');
    cell.append(inputField(className, stop[key], placeholder, max));
    row.append(cell);
  }
  const actionsCell = document.createElement('td');
  const actions = make('div', 'row-actions');
  for (const [label, glyph, handler] of [
    ['위로 이동', '↑', () => moveRow(row, -1)], ['아래로 이동', '↓', () => moveRow(row, 1)],
    ['삭제', '×', () => { if ($('#admin-stops').children.length <= 1) return alert('정류장은 최소 1개가 필요합니다.'); row.remove(); renumberRows(); state.dirty = true; }]
  ]) {
    const button = make('button', '', glyph);
    button.type = 'button'; button.setAttribute('aria-label', label); button.addEventListener('click', handler); actions.append(button);
  }
  actionsCell.append(actions); row.append(actionsCell);
  return row;
}

function moveRow(row, direction) {
  const body = $('#admin-stops');
  if (direction < 0 && row.previousElementSibling) body.insertBefore(row, row.previousElementSibling);
  if (direction > 0 && row.nextElementSibling) body.insertBefore(row.nextElementSibling, row);
  renumberRows(); state.dirty = true;
}

function renumberRows() {
  [...$('#admin-stops').children].forEach((row, index) => { row.children[0].textContent = index + 1; });
}

function renderEditor() {
  const route = selectedRoute();
  $('#editor-empty').hidden = Boolean(route);
  $('#route-form').hidden = !route;
  if (!route) return;
  $('#editor-route-id').textContent = route.id;
  $('#field-id').value = route.id;
  $('#field-category').value = route.category;
  $('#field-service').value = route.serviceType;
  $('#field-name').value = route.name;
  $('#field-period').value = route.period;
  $('#field-source').value = route.sourceImage || '';
  $('#admin-stops').replaceChildren(...route.stops.map(stopRow));
}

function collectRoute() {
  const id = $('#field-id').value.trim();
  const stops = [...$('#admin-stops').children].map((row, index) => {
    const inputs = row.querySelectorAll('input');
    return {
      sequence: index + 1,
      time: inputs[0].value.trim() || null,
      station: inputs[1].value.trim(),
      boardingLocation: inputs[2].value.trim() || null,
      note: inputs[3].value.trim() || null
    };
  });
  return {
    id,
    category: $('#field-category').value.trim(),
    serviceType: $('#field-service').value.trim(),
    name: $('#field-name').value.trim(),
    period: $('#field-period').value.trim(),
    sourceImage: $('#field-source').value.trim() || null,
    stops
  };
}

async function saveAll(routes, successMessage, preferredId) {
  try {
    const next = await api('/api/admin/data', {
      method: 'PUT',
      body: { expectedRevision: state.data.revision, notices: state.data.notices, routes }
    });
    state.data = next;
    state.draftRoute = null;
    state.selectedId = preferredId && next.routes.some((route) => route.id === preferredId) ? preferredId : next.routes[0]?.id;
    state.dirty = false;
    $('#admin-summary').textContent = `${next.stats.routeCount}개 노선 · ${next.stats.stopCount}개 정류장 기록 · 데이터 버전 ${next.revision}`;
    renderRouteList(); renderEditor(); message(successMessage);
  } catch (error) {
    message(error.message, true);
    if (error.status === 401) { state.csrf = null; setLoggedIn(false); }
    if (error.status === 409) await loadData(state.selectedId);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('#login-message').textContent = '';
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: { password: $('#password').value } });
    state.csrf = result.csrf;
    $('#password').value = '';
    setLoggedIn(true);
    await loadData();
  } catch (error) {
    $('#login-message').textContent = error.message;
  } finally { button.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  state.csrf = null; state.data = null; state.draftRoute = null; setLoggedIn(false);
});

$('#admin-search').addEventListener('input', renderRouteList);
['#field-id', '#field-category', '#field-service', '#field-name', '#field-period', '#field-source'].forEach((selector) => {
  $(selector).addEventListener('input', () => { state.dirty = true; });
});

$('#add-stop').addEventListener('click', () => {
  const stop = { sequence: $('#admin-stops').children.length + 1, time: null, station: '', boardingLocation: null, note: null };
  $('#admin-stops').append(stopRow(stop)); state.dirty = true;
  $('#admin-stops tr:last-child .station').focus();
});

$('#route-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const route = collectRoute();
  if (!route.stops.every((stop) => stop.station)) return message('모든 정류장명을 입력해 주세요.', true);
  const duplicate = state.data.routes.some((item) => item.id === route.id && item.id !== state.selectedId);
  if (duplicate) return message('이미 사용 중인 노선 ID입니다.', true);
  const routes = state.draftRoute
    ? [...state.data.routes, route]
    : state.data.routes.map((item) => item.id === state.selectedId ? route : item);
  await saveAll(routes, `${route.id} 노선을 저장했습니다.`, route.id);
});

$('#add-route').addEventListener('click', () => {
  if (state.dirty && !confirm('저장하지 않은 변경사항을 버리고 새 노선을 만들까요?')) return;
  const used = new Set(state.data.routes.map((route) => route.id));
  let n = 1; while (used.has(`R${String(n).padStart(3, '0')}`)) n += 1;
  const route = { id: `R${String(n).padStart(3, '0')}`, category: '신규', serviceType: '출근', name: '새 노선', period: '주간', sourceImage: null,
    stops: [{ sequence: 1, time: null, station: '새 정류장', boardingLocation: null, note: null }] };
  state.draftRoute = route; state.selectedId = route.id; state.dirty = true; renderRouteList(); renderEditor(); $('#field-name').select();
});

$('#delete-route').addEventListener('click', async () => {
  const route = selectedRoute();
  if (!route || !confirm(`${route.id} · ${route.name} 노선을 삭제할까요?`)) return;
  if (state.draftRoute?.id === route.id) {
    state.draftRoute = null; state.selectedId = state.data.routes[0]?.id; state.dirty = false; renderRouteList(); renderEditor();
    return message('저장 전 새 노선을 취소했습니다.');
  }
  await saveAll(state.data.routes.filter((item) => item.id !== route.id), `${route.id} 노선을 삭제했습니다.`);
});

$('#export-data').addEventListener('click', () => {
  const blob = new Blob([`${JSON.stringify(state.data, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `commute-routes-r${state.data.revision}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

$('#import-data').addEventListener('change', async (event) => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  if (!confirm(`${file.name}의 데이터로 현재 노선을 교체할까요? 저장 전 자동 백업됩니다.`)) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.routes)) throw new Error('routes 배열이 없는 파일입니다.');
    await saveAll(imported.routes, 'JSON 데이터를 가져왔습니다.', imported.routes[0]?.id);
  } catch (error) { message(error.message, true); }
});

$('#reset-data').addEventListener('click', async () => {
  if (!confirm('현재 데이터를 백업하고 최초 전체_정류장 변환본으로 복원할까요?')) return;
  try {
    state.data = await api('/api/admin/reset', { method: 'POST', body: {} });
    state.selectedId = state.data.routes[0]?.id; state.dirty = false;
    $('#admin-summary').textContent = `${state.data.stats.routeCount}개 노선 · ${state.data.stats.stopCount}개 정류장 기록 · 데이터 버전 ${state.data.revision}`;
    renderRouteList(); renderEditor(); message('최초 변환본으로 복원했습니다.');
  } catch (error) { message(error.message, true); }
});

window.addEventListener('beforeunload', (event) => { if (state.dirty) event.preventDefault(); });
checkSession();
