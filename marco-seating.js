/* =====================================================================
   パスタのマルコ 予約 席割り当て判定（marco-seating.js）

   予約サイト（index.html）と GAS の両方で同じ判定を使うための共通ロジック。
   GitHub では index.html と同じ場所に置く。GAS には v10.3 本体に同じ中身が入っているので、
   別ファイルとして貼る必要はない（変えるときは両方そろえる）。

   考え方：
     その枠に入っている予約を、実際のテーブルに全員座れるように並べられるか試す。
     並べられれば受付、並べられなければ満席。
   ===================================================================== */

var MARCO_SEATING = (function () {

  // ---- 席（店内のみ。テラスは予約対象外） ----------------------------
  // テーブル1・2 は固定で1卓4名、3・4 も固定で1卓4名。5〜8 は各2名。
  // カウンターは7席。1組3名までの利用。
  var COUNTER_MAX_PARTY = 3;
  var MAX_ONLINE_PARTY  = 8;   // 9名以上はメールで問い合わせ

  // 使い方（どの卓を使い、何名まで座れるか）
  var LAYOUTS = [
    { tables: ['T12'],        max: 4 },
    { tables: ['T34'],        max: 4 },
    { tables: ['T5'],         max: 2 },
    { tables: ['T6'],         max: 2 },
    { tables: ['T7'],         max: 2 },
    { tables: ['T8'],         max: 2 },
    { tables: ['T5', 'T8'],   max: 4 },   // 5＋8で4名席
    { tables: ['T12', 'T7'],  max: 6 },   // 1・2＋7で6名席
    { tables: ['T34', 'T8'],  max: 6 },   // 3・4＋8で6名席
    { tables: ['T12', 'T34'], max: 8 }    // 7〜8名は分席
  ];

  // ---- 予約枠 ------------------------------------------------------
  // key は予約サイト・管理画面・GAS で一字一句同じにすること。
  // 14:00枠と14:30枠は店内を半分ずつ使う。
  var ALL = ['T12', 'T34', 'T5', 'T6', 'T7', 'T8'];
  var ALL_TABLES = ALL;
  var SLOTS = [
    { key: '11:00〜12:20', tables: ALL,                   counter: 7 },
    { key: '12:30〜13:50', tables: ALL,                   counter: 7,
      alwaysFullDows: [0, 6], fullOnHolidays: true },   // 土日祝はWeb予約を受けない（満席表示）。月曜は受ける
    { key: '14:00〜15:20', tables: ['T12', 'T6', 'T7'],   counter: 4 },
    { key: '14:30〜15:50', tables: ['T34', 'T5', 'T8'],   counter: 3 }
  ];

  // ---- 祝日（振替休日・国民の休日を含む）。毎年末に翌年分を足すこと --------
  var HOLIDAYS = [
    '2026-11-03', '2026-11-23',
    '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-22',
    '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19',
    '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03',
    '2027-11-23'
  ];

  function findSlot(key) {
    for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].key === key) return SLOTS[i];
    return null;
  }

  // 'YYYY-MM-DD' → 曜日（0=日）。タイムゾーンに左右されないよう UTC で計算。
  function dowOf(dateStr) {
    var p = String(dateStr).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }

  function isAlwaysFull(slot, dateStr) {
    if (!dateStr) return false;
    if (slot.alwaysFullDows && slot.alwaysFullDows.indexOf(dowOf(dateStr)) >= 0) return true;
    if (slot.fullOnHolidays && HOLIDAYS.indexOf(String(dateStr)) >= 0) return true;
    return false;
  }

  // 全員を座らせられるか（大きい組から順に、空いている卓・カウンターへ当てはめて試す）
  function fits(slot, sizes) {
    var list = sizes.slice().sort(function (a, b) { return b - a; });
    for (var i = 0; i < list.length; i++) {
      if (!(list[i] >= 1) || list[i] > MAX_ONLINE_PARTY) return false;
    }
    var used = {};
    var failed = {};   // 一度ダメだった状態は覚えておき、同じ試行を繰り返さない
    function place(idx, counterLeft) {
      if (idx === list.length) return true;
      var state = idx + '|' + counterLeft + '|' + ALL_TABLES.map(function (t) { return used[t] ? 1 : 0; }).join('');
      if (failed[state]) return false;
      if (tryPlace(idx, counterLeft)) return true;
      failed[state] = true;
      return false;
    }
    function tryPlace(idx, counterLeft) {
      var n = list[idx];
      // カウンター
      if (n <= COUNTER_MAX_PARTY && n <= counterLeft) {
        if (place(idx + 1, counterLeft - n)) return true;
      }
      // テーブル
      for (var j = 0; j < LAYOUTS.length; j++) {
        var L = LAYOUTS[j];
        if (n > L.max) continue;
        var ok = true;
        for (var k = 0; k < L.tables.length; k++) {
          if (used[L.tables[k]] || slot.tables.indexOf(L.tables[k]) < 0) { ok = false; break; }
        }
        if (!ok) continue;
        for (k = 0; k < L.tables.length; k++) used[L.tables[k]] = true;
        if (place(idx + 1, counterLeft)) return true;
        for (k = 0; k < L.tables.length; k++) used[L.tables[k]] = false;
      }
      return false;
    }
    return place(0, slot.counter);
  }

  // 新しい予約を受けられるか。
  //   slotKey  : '11:00〜12:20' など
  //   existing : その日・その枠に入っている予約の人数の配列（例 [2, 4, 2]）
  //   size     : 新しい予約の人数（大人＋お子様）
  //   dateStr  : 'YYYY-MM-DD'
  // 戻り値: { ok: true } または { ok: false, code: 'full_actual' | 'group' | 'no_slot' }
  function canAccept(slotKey, existing, size, dateStr) {
    var slot = findSlot(slotKey);
    if (!slot) return { ok: false, code: 'no_slot' };
    if (size > MAX_ONLINE_PARTY) return { ok: false, code: 'group' };
    if (isAlwaysFull(slot, dateStr)) return { ok: false, code: 'full_actual' };
    return fits(slot, (existing || []).concat([size])) ? { ok: true } : { ok: false, code: 'full_actual' };
  }

  // 枠ごとに「何名なら入れるか」を返す（予約サイトの空席表示用）
  //   fitBySize[n-1] が true なら n 名の予約を受けられる
  function slotStatus(slotKey, existing, dateStr) {
    var slot = findSlot(slotKey);
    var fitBySize = [];
    for (var n = 1; n <= MAX_ONLINE_PARTY; n++) {
      fitBySize.push(!!slot && !isAlwaysFull(slot, dateStr) && fits(slot, (existing || []).concat([n])));
    }
    var label = !fitBySize[0] ? '満席' : (!fitBySize[3] ? '空席わずか' : '受付中');
    return { label: label, fitBySize: fitBySize };
  }

  // '大人2名　小人1名' → 3（予約シートの party_size 文字列から人数を出す）
  function partySizeFromText(text) {
    var m = String(text || '').match(/\d+/g);
    if (!m) return 0;
    var total = 0;
    for (var i = 0; i < m.length; i++) total += +m[i];
    return total;
  }

  return {
    SLOTS: SLOTS,
    HOLIDAYS: HOLIDAYS,
    MAX_ONLINE_PARTY: MAX_ONLINE_PARTY,
    canAccept: canAccept,
    slotStatus: slotStatus,
    partySizeFromText: partySizeFromText,
    fits: function (slotKey, sizes) { var s = findSlot(slotKey); return !!s && fits(s, sizes); }
  };
})();

if (typeof module !== 'undefined') module.exports = MARCO_SEATING;
