(function () {
  'use strict';

  // --- State ---
  let stopsData = [];       // [{id, name, lat, lon}]
  let timetableData = {};   // {routeKey: {routeId, directionId, routeName, routeLongName, headsign, stops:[stopId], trips:[{serviceType, times:[{stopId, arr, dep}]}]}}
  let selectedDeparture = null;  // {id, name}
  let selectedDestination = null; // {id, name}
  let currentDayType = 'weekday';
  let updateTimer = null;
  const STORAGE_KEY_FAV = 'nagoya_bus_favorites';
  const STORAGE_KEY_HIST = 'nagoya_bus_history';
  const MAX_HISTORY = 10;

  // --- DOM Elements ---
  const clockEl = document.getElementById('current-time');
  const depInput = document.getElementById('departure-input');
  const depSuggestions = document.getElementById('departure-suggestions');
  const destInput = document.getElementById('destination-input');
  const destSuggestions = document.getElementById('destination-suggestions');
  const dayTabsEl = document.getElementById('day-tabs');
  const nextBusSection = document.getElementById('next-bus');
  const nextRouteEl = document.getElementById('next-route');
  const nextDepartureEl = document.getElementById('next-departure');
  const nextArrivalEl = document.getElementById('next-arrival');
  const nextDurationEl = document.getElementById('next-duration');
  const countdownEl = document.getElementById('countdown');
  const timetableSection = document.getElementById('timetable-section');
  const timetableContainer = document.getElementById('timetable-container');
  const emptyState = document.getElementById('empty-state');
  const favSection = document.getElementById('favorites-section');
  const favList = document.getElementById('favorites-list');
  const histSection = document.getElementById('history-section');
  const histList = document.getElementById('history-list');
  const favAction = document.getElementById('fav-action');
  const favToggleBtn = document.getElementById('fav-toggle-btn');

  // --- Init ---
  async function init() {
    updateClock();
    setInterval(updateClock, 1000);
    detectDayType();

    emptyState.innerHTML = '<div class="loading">データを読み込み中</div>';

    try {
      const [stopsRes, ttRes] = await Promise.all([
        fetch('data/stops.json'),
        fetch('data/timetable.json'),
      ]);

      if (!stopsRes.ok || !ttRes.ok) {
        throw new Error('データファイルが見つかりません。convert.js を実行してください。');
      }

      stopsData = await stopsRes.json();
      timetableData = await ttRes.json();

      emptyState.innerHTML = '<p>出発バス停と目的地バス停を選択すると<br>時刻表が表示されます</p>';
      renderBookmarks();
      setupAutocomplete(depInput, depSuggestions, onDepartureSelected, () => getAllStopNames());
    } catch (e) {
      emptyState.innerHTML = `<p style="color:#d32f2f">読み込みエラー: ${e.message}<br><br>
        data/stops.json と data/timetable.json が必要です。<br>
        <code>node convert.js</code> を実行してデータを生成してください。</p>`;
    }
  }

  // --- Clock ---
  function updateClock() {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // --- Day Type ---
  function detectDayType() {
    const day = new Date().getDay();
    if (day === 0) currentDayType = 'holiday';
    else if (day === 6) currentDayType = 'saturday';
    else currentDayType = 'weekday';

    updateTabUI();
  }

  function updateTabUI() {
    document.querySelectorAll('.tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.day === currentDayType);
    });
  }

  // --- Text Normalization ---
  // GTFSデータには異体字セレクタ(U+E0100等)などの不可視文字が含まれることがある
  function normalizeText(str) {
    // 異体字セレクタ (U+FE00-U+FE0F, U+E0100-U+E01EF) を除去
    return str.replace(/[\uFE00-\uFE0F]/g, '').replace(/[\uDB40][\uDD00-\uDDEF]/g, '');
  }

  // --- Autocomplete ---
  function getAllStopNames() {
    const nameMap = new Map();
    for (const s of stopsData) {
      const normalized = normalizeText(s.name);
      if (!nameMap.has(normalized)) nameMap.set(normalized, { id: s.id, name: s.name, displayName: normalized });
    }
    return Array.from(nameMap.values()).map(v => ({ id: v.id, name: v.name, displayName: v.displayName }));
  }

  function getDestinationCandidates() {
    if (!selectedDeparture) return [];
    const depIds = selectedDeparture.ids || [selectedDeparture.id];
    const candidates = new Map();

    for (const [, route] of Object.entries(timetableData)) {
      // 出発バス停の全IDでルートを検索
      const depIdx = route.stops.findIndex(s => depIds.includes(s));
      if (depIdx === -1) continue;

      // 出発バス停より後のバス停のみ候補とする
      for (let i = depIdx + 1; i < route.stops.length; i++) {
        const stopId = route.stops[i];
        if (!candidates.has(stopId)) {
          const stop = stopsData.find(s => s.id === stopId);
          if (stop) {
            candidates.set(stopId, { id: stopId, name: stop.name, routeName: route.routeName });
          }
        }
      }
    }

    // 同名バス停をまとめる（正規化した名前でグループ化）
    const byName = new Map();
    for (const c of candidates.values()) {
      const normalized = normalizeText(c.name);
      if (!byName.has(normalized)) {
        byName.set(normalized, { id: c.id, name: c.name, displayName: normalized, routes: [c.routeName] });
      } else {
        const existing = byName.get(normalized);
        if (!existing.routes.includes(c.routeName)) {
          existing.routes.push(c.routeName);
        }
      }
    }

    return Array.from(byName.values());
  }

  function setupAutocomplete(input, list, onSelect, getCandidates) {
    let activeIdx = -1;
    let items = [];

    input.addEventListener('input', () => {
      const query = input.value.trim();
      items = getCandidates();

      if (query) {
        items = items.filter(item => {
          const display = item.displayName || normalizeText(item.name);
          return display.includes(query);
        });
      }
      items = items.slice(0, 50);

      renderSuggestions(list, items, activeIdx);
      list.hidden = items.length === 0;
      activeIdx = -1;
    });

    input.addEventListener('focus', () => {
      if (input.value.trim() === '') {
        items = getCandidates().slice(0, 50);
        renderSuggestions(list, items, activeIdx);
        list.hidden = items.length === 0;
      }
    });

    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        renderSuggestions(list, items, activeIdx);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        renderSuggestions(list, items, activeIdx);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) {
          onSelect(items[activeIdx]);
          input.value = items[activeIdx].displayName || normalizeText(items[activeIdx].name);
          list.hidden = true;
        }
      } else if (e.key === 'Escape') {
        list.hidden = true;
      }
    });

    list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      const idx = parseInt(li.dataset.index, 10);
      if (items[idx]) {
        onSelect(items[idx]);
        input.value = items[idx].displayName || normalizeText(items[idx].name);
        list.hidden = true;
      }
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !list.contains(e.target)) {
        list.hidden = true;
      }
    });
  }

  function renderSuggestions(list, items, activeIdx) {
    list.innerHTML = items.map((item, i) => {
      const displayName = item.displayName || normalizeText(item.name);
      const badges = (item.routes || []).map(r => `<span class="route-badge">${r}</span>`).join('');
      return `<li data-index="${i}" class="${i === activeIdx ? 'active' : ''}">${displayName}${badges}</li>`;
    }).join('');
  }

  // --- Selection Callbacks ---
  function onDepartureSelected(item) {
    // バス停名でIDを再解決（同名バス停が複数IDを持つ場合があるため）
    const displayName = item.displayName || normalizeText(item.name);
    const matchingIds = stopsData.filter(s => normalizeText(s.name) === displayName).map(s => s.id);
    selectedDeparture = { id: matchingIds[0], ids: matchingIds, name: displayName };
    selectedDestination = null;

    destInput.value = '';
    destInput.disabled = false;
    setupAutocomplete(destInput, destSuggestions, onDestinationSelected, getDestinationCandidates);
    destInput.focus();

    hideResults();
  }

  function onDestinationSelected(item) {
    const displayName = item.displayName || normalizeText(item.name);
    const matchingIds = stopsData.filter(s => normalizeText(s.name) === displayName).map(s => s.id);
    selectedDestination = { id: matchingIds[0], ids: matchingIds, name: displayName };

    dayTabsEl.hidden = false;
    showResults();
  }

  // --- Results ---
  function hideResults() {
    nextBusSection.hidden = true;
    timetableSection.hidden = true;
    favAction.hidden = true;
    emptyState.hidden = false;
    renderBookmarks();
    if (updateTimer) clearInterval(updateTimer);
  }

  function showResults() {
    emptyState.hidden = true;
    favSection.hidden = true;
    histSection.hidden = true;
    renderTimetable();
    addHistory(selectedDeparture.name, selectedDestination.name);
    updateFavButton();
    favAction.hidden = false;

    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(renderTimetable, 60000);
  }

  function findMatchingTrips() {
    if (!selectedDeparture || !selectedDestination) return [];

    const depIds = selectedDeparture.ids || [selectedDeparture.id];
    const destIds = selectedDestination.ids || [selectedDestination.id];
    const results = [];

    for (const [, route] of Object.entries(timetableData)) {
      // このルートに出発・目的地バス停が存在するかチェック
      const depStopIdx = route.stops.findIndex(s => depIds.includes(s));
      if (depStopIdx === -1) continue;
      const destStopIdx = route.stops.findIndex((s, i) => i > depStopIdx && destIds.includes(s));
      if (destStopIdx === -1) continue;

      const depStopId = route.stops[depStopIdx];
      const destStopId = route.stops[destStopIdx];

      for (const trip of route.trips) {
        if (trip.serviceType !== currentDayType) continue;

        const depTime = trip.times.find(t => t.stopId === depStopId);
        const arrTime = trip.times.find(t => t.stopId === destStopId);
        if (!depTime || !arrTime) continue;

        results.push({
          routeName: route.routeName,
          routeLongName: route.routeLongName,
          headsign: route.headsign,
          departure: depTime.dep,
          arrival: arrTime.arr,
        });
      }
    }

    // 出発時刻順にソート
    results.sort((a, b) => a.departure.localeCompare(b.departure));
    return results;
  }

  function renderTimetable() {
    const trips = findMatchingTrips();
    const now = getCurrentTimeStr();

    if (trips.length === 0) {
      nextBusSection.hidden = true;
      timetableSection.hidden = true;
      emptyState.hidden = false;
      emptyState.innerHTML = `<p>この区間の${getDayTypeName()}ダイヤは見つかりませんでした</p>`;
      return;
    }

    emptyState.hidden = true;

    // 次のバスを探す（全便の中で現在時刻以降の最初の便のインデックス）
    const nextIdx = trips.findIndex(t => t.departure >= now);
    const nextTrip = nextIdx >= 0 ? trips[nextIdx] : null;

    // 次のバスカード
    if (nextTrip) {
      nextBusSection.hidden = false;
      nextRouteEl.textContent = `${nextTrip.routeName} ${nextTrip.headsign}`;
      nextDepartureEl.textContent = formatTime(nextTrip.departure);
      nextArrivalEl.textContent = formatTime(nextTrip.arrival);
      nextDurationEl.textContent = calcDuration(nextTrip.departure, nextTrip.arrival);
      updateCountdown(nextTrip.departure);
    } else {
      nextBusSection.hidden = true;
    }

    // 前後2本ずつに絞り込み（現在時刻の前2本 + 後2本）
    let startIdx, endIdx;
    if (nextIdx >= 0) {
      startIdx = Math.max(0, nextIdx - 2);
      endIdx = Math.min(trips.length, nextIdx + 3);
    } else {
      // 全便が過去の場合、末尾4本を表示
      startIdx = Math.max(0, trips.length - 4);
      endIdx = trips.length;
    }
    const nearbyTrips = trips.slice(startIdx, endIdx);

    // 時刻表一覧
    timetableSection.hidden = false;

    // 路線ごとにグループ化
    const groups = new Map();
    for (const trip of nearbyTrips) {
      const key = `${trip.routeName} ${trip.headsign}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(trip);
    }

    let html = '';
    for (const [groupName, groupTrips] of groups) {
      html += `<div class="route-group">`;
      html += `<div class="route-group-header">${groupName}</div>`;
      for (const trip of groupTrips) {
        const isPast = trip.departure < now;
        const isNext = nextTrip && trip.departure === nextTrip.departure && trip.routeName === nextTrip.routeName;
        const cls = isPast ? 'past' : (isNext ? 'next' : '');
        html += `<div class="trip-row ${cls}">
          <span class="trip-dep">${formatTime(trip.departure)}</span>
          <span class="trip-arrow">→</span>
          <span class="trip-arr">${formatTime(trip.arrival)}</span>
          <span class="trip-duration">${calcDuration(trip.departure, trip.arrival)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    timetableContainer.innerHTML = html;

    // 次のバスが見えるようスクロール
    const nextRow = timetableContainer.querySelector('.trip-row.next');
    if (nextRow) {
      nextRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // --- Utility ---
  function getCurrentTimeStr() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function formatTime(timeStr) {
    // GTFS時刻は "HH:MM:SS" 形式。24時以降もある（例: 25:30:00）
    const parts = timeStr.split(':');
    let h = parseInt(parts[0], 10);
    const m = parts[1];
    const displayH = h >= 24 ? h - 24 : h;
    const suffix = h >= 24 ? ' (翌)' : '';
    return `${displayH}:${m}${suffix}`;
  }

  function calcDuration(dep, arr) {
    const depMin = timeToMinutes(dep);
    const arrMin = timeToMinutes(arr);
    const diff = arrMin - depMin;
    if (diff <= 0) return '--';
    if (diff >= 60) {
      return `${Math.floor(diff / 60)}時間${diff % 60}分`;
    }
    return `${diff}分`;
  }

  function timeToMinutes(timeStr) {
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function updateCountdown(depTimeStr) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const depMin = timeToMinutes(depTimeStr);
    const diff = depMin - nowMin;

    if (diff <= 0) {
      countdownEl.textContent = 'まもなく出発';
    } else if (diff === 1) {
      countdownEl.textContent = 'あと1分';
    } else {
      countdownEl.textContent = `あと${diff}分`;
    }
  }

  function getDayTypeName() {
    switch (currentDayType) {
      case 'weekday': return '平日';
      case 'saturday': return '土曜';
      case 'holiday': return '休日';
      default: return '';
    }
  }

  // --- Favorites & History ---
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_FAV)) || []; }
    catch { return []; }
  }

  function saveFavorites(favs) {
    localStorage.setItem(STORAGE_KEY_FAV, JSON.stringify(favs));
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_HIST)) || []; }
    catch { return []; }
  }

  function saveHistory(hist) {
    localStorage.setItem(STORAGE_KEY_HIST, JSON.stringify(hist));
  }

  function addHistory(dep, dest) {
    let hist = getHistory();
    // 同じ組み合わせがあれば削除して先頭に
    hist = hist.filter(h => !(h.dep === dep && h.dest === dest));
    hist.unshift({ dep, dest });
    if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
    saveHistory(hist);
  }

  function isFavorite(dep, dest) {
    return getFavorites().some(f => f.dep === dep && f.dest === dest);
  }

  function toggleFavorite() {
    if (!selectedDeparture || !selectedDestination) return;
    const dep = selectedDeparture.name;
    const dest = selectedDestination.name;
    let favs = getFavorites();
    if (isFavorite(dep, dest)) {
      favs = favs.filter(f => !(f.dep === dep && f.dest === dest));
    } else {
      favs.unshift({ dep, dest });
    }
    saveFavorites(favs);
    updateFavButton();
  }

  function updateFavButton() {
    if (!selectedDeparture || !selectedDestination) return;
    const starred = isFavorite(selectedDeparture.name, selectedDestination.name);
    favToggleBtn.textContent = starred ? '★ お気に入り解除' : '☆ お気に入り登録';
    favToggleBtn.classList.toggle('is-fav', starred);
  }

  function selectRoute(dep, dest) {
    // プログラムから出発・目的地を選択
    const displayDep = dep;
    const matchingDepIds = stopsData.filter(s => normalizeText(s.name) === displayDep).map(s => s.id);
    if (matchingDepIds.length === 0) return;
    selectedDeparture = { id: matchingDepIds[0], ids: matchingDepIds, name: displayDep };
    depInput.value = displayDep;

    const displayDest = dest;
    const matchingDestIds = stopsData.filter(s => normalizeText(s.name) === displayDest).map(s => s.id);
    if (matchingDestIds.length === 0) return;
    selectedDestination = { id: matchingDestIds[0], ids: matchingDestIds, name: displayDest };
    destInput.value = displayDest;
    destInput.disabled = false;

    dayTabsEl.hidden = false;
    showResults();
  }

  function renderBookmarks() {
    const favs = getFavorites();
    const hist = getHistory();

    // お気に入り
    if (favs.length > 0) {
      favSection.hidden = false;
      favList.innerHTML = favs.map((f, i) =>
        `<li>
          <button class="bookmark-item" data-type="fav" data-index="${i}">${f.dep} → ${f.dest}</button>
          <button class="bookmark-delete" data-type="fav-del" data-index="${i}" title="削除">×</button>
        </li>`
      ).join('');
    } else {
      favSection.hidden = true;
    }

    // 履歴
    if (hist.length > 0) {
      histSection.hidden = false;
      histList.innerHTML = hist.map((h, i) =>
        `<li>
          <button class="bookmark-item" data-type="hist" data-index="${i}">${h.dep} → ${h.dest}</button>
          <button class="bookmark-delete" data-type="hist-del" data-index="${i}" title="削除">×</button>
        </li>`
      ).join('');
    } else {
      histSection.hidden = true;
    }
  }

  // お気に入りボタン
  favToggleBtn.addEventListener('click', toggleFavorite);

  // お気に入り・履歴リストのクリック
  favList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index, 10);
    if (btn.dataset.type === 'fav') {
      const favs = getFavorites();
      if (favs[idx]) selectRoute(favs[idx].dep, favs[idx].dest);
    } else if (btn.dataset.type === 'fav-del') {
      const favs = getFavorites();
      favs.splice(idx, 1);
      saveFavorites(favs);
      renderBookmarks();
    }
  });

  histList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index, 10);
    if (btn.dataset.type === 'hist') {
      const hist = getHistory();
      if (hist[idx]) selectRoute(hist[idx].dep, hist[idx].dest);
    } else if (btn.dataset.type === 'hist-del') {
      const hist = getHistory();
      hist.splice(idx, 1);
      saveHistory(hist);
      renderBookmarks();
    }
  });

  // --- Day Tab Events ---
  dayTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    currentDayType = tab.dataset.day;
    updateTabUI();
    if (selectedDeparture && selectedDestination) {
      renderTimetable();
    }
  });

  // --- Start ---
  init();
})();
