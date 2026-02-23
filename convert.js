const fs = require('fs');
const path = require('path');

const GTFS_DIR = path.join(__dirname, 'data', 'gtfs');
const OUTPUT_DIR = path.join(__dirname, 'data');

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    return obj;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function readGTFS(filename) {
  const filepath = path.join(GTFS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`ファイルが見つかりません: ${filepath}`);
    process.exit(1);
  }
  const text = fs.readFileSync(filepath, 'utf-8');
  return parseCSV(text);
}

function main() {
  console.log('GTFSデータを読み込み中...');

  // 各ファイル読み込み
  const stops = readGTFS('stops.txt');
  const routes = readGTFS('routes.txt');
  const trips = readGTFS('trips.txt');
  const stopTimes = readGTFS('stop_times.txt');
  const calendar = readGTFS('calendar.txt');

  // calendar_dates.txt は任意
  let calendarDates = [];
  const calDatesPath = path.join(GTFS_DIR, 'calendar_dates.txt');
  if (fs.existsSync(calDatesPath)) {
    calendarDates = parseCSV(fs.readFileSync(calDatesPath, 'utf-8'));
  }

  console.log(`  stops: ${stops.length}件`);
  console.log(`  routes: ${routes.length}件`);
  console.log(`  trips: ${trips.length}件`);
  console.log(`  stop_times: ${stopTimes.length}件`);
  console.log(`  calendar: ${calendar.length}件`);

  // --- stops.json ---
  const stopsJson = stops.map(s => ({
    id: s.stop_id,
    name: s.stop_name,
    lat: parseFloat(s.stop_lat) || null,
    lon: parseFloat(s.stop_lon) || null,
  }));

  // --- service_idごとの曜日マッピング ---
  const serviceMap = {};
  for (const c of calendar) {
    serviceMap[c.service_id] = {
      weekday: c.monday === '1' && c.tuesday === '1' && c.wednesday === '1' && c.thursday === '1' && c.friday === '1',
      saturday: c.saturday === '1',
      sunday: c.sunday === '1',
      startDate: c.start_date,
      endDate: c.end_date,
    };
  }

  // --- trip_idからroute_id, service_idへのマッピング ---
  const tripMap = {};
  for (const t of trips) {
    tripMap[t.trip_id] = {
      routeId: t.route_id,
      serviceId: t.service_id,
      directionId: t.direction_id || '0',
      tripHeadsign: t.trip_headsign || '',
    };
  }

  // --- route_idから路線名へのマッピング ---
  const routeMap = {};
  for (const r of routes) {
    routeMap[r.route_id] = {
      shortName: r.route_short_name || '',
      longName: r.route_long_name || '',
    };
  }

  // --- stop_timesを trip_id でグループ化 ---
  console.log('時刻表データを構築中...');
  const tripStopTimes = {};
  for (const st of stopTimes) {
    if (!tripStopTimes[st.trip_id]) tripStopTimes[st.trip_id] = [];
    tripStopTimes[st.trip_id].push({
      stopId: st.stop_id,
      arrival: st.arrival_time,
      departure: st.departure_time,
      seq: parseInt(st.stop_sequence, 10),
    });
  }
  // 各trip内をstop_sequence順にソート
  for (const tid of Object.keys(tripStopTimes)) {
    tripStopTimes[tid].sort((a, b) => a.seq - b.seq);
  }

  // --- 路線ごと・方向ごとにバス停の順序と時刻表を整理 ---
  // timetable構造:
  // { [routeId_directionId]: { routeName, stops: [stopId,...], trips: [{ serviceType, times: [{stopId, departure, arrival}] }] } }
  const timetable = {};

  for (const [tripId, stList] of Object.entries(tripStopTimes)) {
    const trip = tripMap[tripId];
    if (!trip) continue;

    const key = `${trip.routeId}_${trip.directionId}`;
    const service = serviceMap[trip.serviceId];

    let serviceType = 'weekday';
    if (service) {
      if (service.sunday) serviceType = 'holiday';
      else if (service.saturday) serviceType = 'saturday';
      else serviceType = 'weekday';
    }

    if (!timetable[key]) {
      const route = routeMap[trip.routeId] || {};
      timetable[key] = {
        routeId: trip.routeId,
        directionId: trip.directionId,
        routeName: route.shortName || route.longName || trip.routeId,
        routeLongName: route.longName || '',
        headsign: trip.tripHeadsign,
        stops: stList.map(s => s.stopId),
        trips: [],
      };
    }

    timetable[key].trips.push({
      serviceType,
      times: stList.map(s => ({
        stopId: s.stopId,
        arr: s.arrival,
        dep: s.departure,
      })),
    });
  }

  // 各路線のtripsを出発時刻順にソート
  for (const key of Object.keys(timetable)) {
    timetable[key].trips.sort((a, b) => {
      const ta = a.times[0]?.dep || '99:99:99';
      const tb = b.times[0]?.dep || '99:99:99';
      return ta.localeCompare(tb);
    });
  }

  // --- 出力 ---
  const stopsOut = JSON.stringify(stopsJson, null, 2);
  const timetableOut = JSON.stringify(timetable, null, 2);

  fs.writeFileSync(path.join(OUTPUT_DIR, 'stops.json'), stopsOut, 'utf-8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'timetable.json'), timetableOut, 'utf-8');

  console.log(`\n変換完了!`);
  console.log(`  data/stops.json (${stopsJson.length}件のバス停)`);
  console.log(`  data/timetable.json (${Object.keys(timetable).length}件の路線・方向)`);
}

main();
