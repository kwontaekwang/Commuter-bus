const $ = (selector) => document.querySelector(selector);
const state = { data: null, query: '', category: '', service: '', period: '', favoritesOnly: false, favorites: new Set() };

try { state.favorites = new Set(JSON.parse(localStorage.getItem('commute-favorites') || '[]')); } catch { state.favorites = new Set(); }

const els = {
  grid: $('#route-grid'), empty: $('#empty-state'), error: $('#error-state'), result: $('#result-summary'),
  search: $('#search'), clear: $('#clear-search'), category: $('#category-filter'), service: $('#service-filter'),
  period: $('#period-filter'), favoriteToggle: $('#favorite-toggle'), dialog: $('#route-dialog')
};

function normalize(value) { return String(value ?? '').toLocaleLowerCase('ko-KR').replace(/\s+/g, ''); }
function unique(values) { return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko')); }
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function saveFavorites() {
  localStorage.setItem('commute-favorites', JSON.stringify([...state.favorites]));
}

function fillSelect(select, values) {
  const current = select.value;
  select.replaceChildren(new Option('전체', ''), ...values.map((value) => new Option(value, value)));
  if (values.includes(current)) select.value = current;
}

function routeTime(route) {
  const values = route.stops.map((stop) => stop.time).filter(Boolean);
  const clocks = values.filter((value) => /^\d{1,2}:\d{2}$/.test(value));
  if (clocks.length === 1) return clocks[0];
  if (clocks.length > 1) return `${clocks[0]} – ${clocks.at(-1)}`;
  if (values.includes('미운행')) return '미운행';
  return '정류장별 시간 미기재';
}

function filtersMatch(route) {
  if (state.category && route.category !== state.category) return false;
  if (state.service && route.serviceType !== state.service) return false;
  if (state.period && route.period !== state.period) return false;
  if (state.favoritesOnly && !state.favorites.has(route.id)) return false;
  if (!state.query) return true;
  const haystack = [route.id, route.category, route.serviceType, route.name, route.period,
    ...route.stops.flatMap((stop) => [stop.station, stop.boardingLocation, stop.note])].map(normalize).join('|');
  return haystack.includes(normalize(state.query));
}

function matchingStations(route) {
  if (!state.query) return [];
  const q = normalize(state.query);
  return route.stops.filter((stop) => normalize(`${stop.station} ${stop.boardingLocation || ''}`).includes(q)).slice(0, 2);
}

function badge(text, extra = '') { return make('span', `badge ${extra}`.trim(), text); }

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  saveFavorites();
  render();
  if (els.dialog.open && els.dialog.dataset.routeId === id) updateDialogFavorite(id);
}

function routeCard(route) {
  const article = make('article', 'route-card');
  const top = make('div', 'card-top');
  top.append(make('span', 'route-id', route.id));
  const favorite = make('button', `favorite-button${state.favorites.has(route.id) ? ' active' : ''}`, state.favorites.has(route.id) ? '★' : '☆');
  favorite.type = 'button';
  favorite.setAttribute('aria-label', `${route.name} 즐겨찾기 ${state.favorites.has(route.id) ? '해제' : '추가'}`);
  favorite.addEventListener('click', () => toggleFavorite(route.id));
  top.append(favorite);
  article.append(top, make('h3', '', route.name), make('p', 'category', `${route.category} · ${route.serviceType}`));
  const badges = make('div', 'badges');
  badges.append(badge(route.period, 'period'), badge(`${route.stops.length}개 정류장`));
  article.append(badges);
  const stationMatches = matchingStations(route);
  if (stationMatches.length) article.append(make('p', 'station-match', `정류장 일치: ${stationMatches.map((s) => s.station).join(', ')}`));
  const time = make('div', 'route-time');
  time.append(make('strong', '', routeTime(route)), make('span', '', route.sourceImage ? `원본 ${route.sourceImage}` : '전체_정류장 기준'));
  article.append(time);
  const detail = make('button', 'card-detail', '정류장 자세히 보기');
  detail.type = 'button';
  detail.addEventListener('click', () => openRoute(route.id));
  article.append(detail);
  return article;
}

function render() {
  if (!state.data) return;
  const routes = state.data.routes.filter(filtersMatch);
  els.grid.replaceChildren(...routes.map(routeCard));
  els.empty.hidden = routes.length > 0;
  els.result.textContent = `총 ${routes.length}개 노선`;
  els.favoriteToggle.textContent = `${state.favoritesOnly ? '★' : '☆'} 즐겨찾기만`;
  els.favoriteToggle.setAttribute('aria-pressed', String(state.favoritesOnly));
}

function updateDialogFavorite(id) {
  const button = $('#dialog-favorite');
  const active = state.favorites.has(id);
  button.textContent = active ? '★ 즐겨찾기 해제' : '☆ 즐겨찾기 추가';
  button.setAttribute('aria-pressed', String(active));
}

function openRoute(id, push = true) {
  const route = state.data?.routes.find((item) => item.id === id);
  if (!route) return;
  els.dialog.dataset.routeId = id;
  $('#dialog-id').textContent = route.id;
  $('#dialog-title').textContent = route.name;
  $('#dialog-meta').textContent = `${route.category} · ${route.serviceType}`;
  $('#dialog-source').textContent = route.sourceImage ? `원본 참조 ${route.sourceImage} · 전체_정류장 시트 기준` : '전체_정류장 시트 기준';
  const badges = $('#dialog-badges');
  badges.replaceChildren(badge(route.period, 'period'), badge(`${route.stops.length}개 정류장`), badge(routeTime(route)));
  const list = $('#stop-list');
  list.replaceChildren(...route.stops.map((stop) => {
    const item = make('li', 'stop-item');
    const time = make('div', `stop-time${!stop.time ? ' missing' : stop.time === '미운행' ? ' off' : ''}`, stop.time || '시간\n미기재');
    const info = make('div', 'stop-info');
    info.append(make('strong', '', `${stop.sequence}. ${stop.station}`));
    if (stop.boardingLocation) info.append(make('span', '', `탑승위치: ${stop.boardingLocation}`));
    if (stop.note) info.append(make('span', 'stop-note', stop.note));
    item.append(time, info);
    return item;
  }));
  updateDialogFavorite(id);
  if (!els.dialog.open) els.dialog.showModal();
  if (push) history.pushState({ route: id }, '', `?route=${encodeURIComponent(id)}`);
}

function closeDialog(push = true) {
  if (els.dialog.open) els.dialog.close();
  if (push) history.pushState({}, '', location.pathname);
}

async function loadData() {
  els.error.hidden = true;
  try {
    const response = await fetch('/api/data', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('load failed');
    state.data = await response.json();
    $('#route-count').textContent = state.data.stats.routeCount;
    $('#stop-count').textContent = state.data.stats.stopCount;
    $('#category-count').textContent = state.data.stats.categoryCount;
    $('#data-revision').textContent = `데이터 버전 ${state.data.revision}`;
    $('#notices').replaceChildren(...state.data.notices.map((notice) => make('p', '', notice)));
    fillSelect(els.category, unique(state.data.routes.map((route) => route.category)));
    fillSelect(els.service, unique(state.data.routes.map((route) => route.serviceType)));
    fillSelect(els.period, unique(state.data.routes.map((route) => route.period)));
    render();
    const routeId = new URLSearchParams(location.search).get('route');
    if (routeId) openRoute(routeId, false);
  } catch {
    els.grid.replaceChildren();
    els.error.hidden = false;
    els.result.textContent = '노선 정보를 불러오지 못했습니다';
  }
}

els.search.addEventListener('input', (event) => {
  state.query = event.target.value;
  els.clear.hidden = !state.query;
  render();
});
els.clear.addEventListener('click', () => { els.search.value = ''; state.query = ''; els.clear.hidden = true; els.search.focus(); render(); });
els.category.addEventListener('change', (event) => { state.category = event.target.value; render(); });
els.service.addEventListener('change', (event) => { state.service = event.target.value; render(); });
els.period.addEventListener('change', (event) => { state.period = event.target.value; render(); });
els.favoriteToggle.addEventListener('click', () => { state.favoritesOnly = !state.favoritesOnly; render(); });
$('#reset-filters').addEventListener('click', () => {
  state.query = state.category = state.service = state.period = '';
  state.favoritesOnly = false;
  els.search.value = els.category.value = els.service.value = els.period.value = '';
  els.clear.hidden = true;
  render();
});
$('#dialog-close').addEventListener('click', () => closeDialog());
$('#dialog-favorite').addEventListener('click', () => toggleFavorite(els.dialog.dataset.routeId));
els.dialog.addEventListener('click', (event) => { if (event.target === els.dialog) closeDialog(); });
els.dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
$('#retry').addEventListener('click', loadData);
window.addEventListener('popstate', () => {
  const routeId = new URLSearchParams(location.search).get('route');
  if (routeId) openRoute(routeId, false); else closeDialog(false);
});

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
loadData();
