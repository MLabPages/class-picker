// Pure layout functions mirrored from index.html; parity tests prevent drift.
export function todayKey(now = Date.now()) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
  var DEFAULT_SETTINGS = {
    mode: "number",
    totalStudents: 80,
    groupSize: 4,
    remainderMode: "singleExtra",
    columnFillMode: "", // 空欄は表示方式ごとの既定（数字のみ：上限まで埋める，列番号版：そろえる）
    columnCount: 4,
    rowLimitPerColumn: 0,
    columnRowLimits: "",
    autoDailyReset: false,
    genderBalance: false,
    resetCode: "reset2026",
    lastResetDate: todayKey(),
    sessionId: "session-1"
  };

  var FRUITS = [
    { id: "apple", label: "りんご", emoji: "🍎" },
    { id: "orange", label: "みかん", emoji: "🍊" },
    { id: "grape", label: "ぶどう", emoji: "🍇" },
    { id: "strawberry", label: "いちご", emoji: "🍓" },
    { id: "banana", label: "バナナ", emoji: "🍌" },
    { id: "peach", label: "もも", emoji: "🍑" },
    { id: "cherry", label: "さくらんぼ", emoji: "🍒" },
    { id: "pineapple", label: "パイナップル", emoji: "🍍" }
  ];

  function normalizeSettings(s) {
    var out = Object.assign({}, DEFAULT_SETTINGS, s || {});
    out.mode = out.mode === "fruit" || out.mode === "plainNumber" ? out.mode : "number";
    out.totalStudents = clampInt(out.totalStudents, 1, 600, 80);
    out.groupSize = clampInt(out.groupSize, 1, 20, 4);
    out.remainderMode = out.remainderMode === "balanced" ? "balanced" : "singleExtra";
    // 折り返し方が未保存の設定では，これまでの並び方（数字のみ：上限まで埋める，列番号版：そろえる）を保つ。
    out.columnFillMode = out.columnFillMode === "fill" || out.columnFillMode === "even"
      ? out.columnFillMode
      : (out.mode === "plainNumber" ? "fill" : "even");
    out.columnCount = clampInt(out.columnCount, 1, 12, 4);
    out.rowLimitPerColumn = clampOptionalInt(out.rowLimitPerColumn, 0, 30);
    out.columnRowLimits = typeof out.columnRowLimits === "string" ? out.columnRowLimits : "";
    out.autoDailyReset = !!out.autoDailyReset;
    out.genderBalance = !!out.genderBalance;
    out.resetCode = out.resetCode || "reset2026";
    out.lastResetDate = out.lastResetDate || todayKey();
    out.sessionId = out.sessionId || String(Date.now());
    return out;
  }

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) n = fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clampOptionalInt(value, min, max) {
    if (value === "" || value === null || typeof value === "undefined") return 0;
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(min, Math.min(max, n));
  }

  function createNumberGroups(s) {
    var plan = planNumberLayout(s);
    var numberOnly = s.mode === "plainNumber";
    // 数字のみ，または上限まで埋める方式では，列ごとに上から順に並べる。
    var columnMajor = numberOnly || s.columnFillMode === "fill";
    var slots = buildSlots(plan.columnCounts, numberOnly, columnMajor);
    var columns = plan.columnCounts.length || 1;
    var groups = [];

    for (var i = 0; i < plan.groupCount; i++) {
      var fallbackSlot = numberOnly
        ? { col: String(Math.floor(i / 10) + 1), row: (i % 10) + 1 }
        : { col: columnLabel(i % columns), row: Math.floor(i / columns) + 1 };
      var slot = slots[i] || fallbackSlot;
      var label = numberOnly ? String(i + 1) : slot.col + slot.row;
      groups.push({
        id: label,
        label: label,
        type: "number",
        col: slot.col,
        row: slot.row,
        capacity: plan.capacities[i],
        detail: numberOnly ? label + "番" : slot.col + "列・" + slot.row + "番"
      });
    }
    return groups;
  }

  function planNumberLayout(s) {
    var total = s.totalStudents;
    var groupSize = s.groupSize;
    var neededGroupCount = preferredGroupCount(total, groupSize, s.remainderMode);
    var columns = Math.min(s.columnCount, neededGroupCount);
    var columnLimits = buildColumnLimits(s, columns, neededGroupCount);
    var maxSlots = columnLimits.reduce(function (sum, n) { return sum + n; }, 0);
    var groupCount = neededGroupCount;

    // 行数上限を設定していて，必要な組数を置ききれない場合は，
    // 教室内の配置上限を優先し，その枠数の中で人数を配分する。
    // 例：105人・4人基準・5列・各列5グループ → 25組，5人組が一部発生。
    if (hasRowLimitSettings(s) && maxSlots > 0 && maxSlots < neededGroupCount) {
      groupCount = maxSlots;
    }

    var allowOverStandard = total > groupCount * groupSize;
    // 「余った人を後ろの組に加える」で配置枠に余裕がある場合は，基準人数より多い組を後ろに置く。
    var placeExtraAtEnd = s.remainderMode !== "balanced" && groupCount === neededGroupCount;
    return {
      neededGroupCount: neededGroupCount,
      groupCount: groupCount,
      columnLimits: columnLimits,
      columnCounts: columnGroupCounts(columnLimits, groupCount, s.columnFillMode),
      capacities: balancedCapacities(total, groupSize, groupCount, allowOverStandard, placeExtraAtEnd)
    };
  }

  function hasRowLimitSettings(s) {
    return s.mode === "plainNumber" || !!(s.rowLimitPerColumn || String(s.columnRowLimits || "").trim());
  }

  function parseColumnRowLimits(text, columns) {
    var raw = String(text || "").trim();
    if (!raw) return [];
    return raw.split(/[,，\s]+/).map(function (part) {
      return clampOptionalInt(part, 0, 30);
    }).filter(function (n) { return n > 0; }).slice(0, columns);
  }

  function buildColumnLimits(s, columns, neededGroupCount) {
    var specified = parseColumnRowLimits(s.columnRowLimits, columns);
    var fallbackRows = s.rowLimitPerColumn || (s.mode === "plainNumber" ? 10 : Math.ceil(neededGroupCount / columns));
    var limits = [];
    for (var c = 0; c < columns; c++) {
      limits.push(specified[c] || fallbackRows);
    }
    return limits.map(function (n) { return clampInt(n, 1, 30, 1); });
  }

  function columnGroupCounts(columnLimits, groupCount, fillMode) {
    var counts = columnLimits.map(function () { return 0; });
    var remaining = groupCount;
    if (fillMode === "fill") {
      // 左の列から上限まで埋めてから次の列へ進む。例：45組・各列上限10 → 10,10,10,10,5
      for (var c = 0; c < columnLimits.length && remaining > 0; c++) {
        counts[c] = Math.min(columnLimits[c], remaining);
        remaining -= counts[c];
      }
      return counts;
    }
    // 1段ずつ左の列から置き，各列の組数をできるだけそろえる。例：45組・5列 → 9,9,9,9,9
    var maxRow = columnLimits.reduce(function (m, n) { return Math.max(m, n); }, 0);
    for (var r = 1; r <= maxRow && remaining > 0; r++) {
      for (var col = 0; col < columnLimits.length && remaining > 0; col++) {
        if (r <= columnLimits[col]) {
          counts[col] += 1;
          remaining -= 1;
        }
      }
    }
    return counts;
  }

  function buildSlots(columnCounts, numberOnly, columnMajor) {
    var slots = [];
    function slotColumn(c) { return numberOnly ? String(c + 1) : columnLabel(c); }
    if (columnMajor) {
      columnCounts.forEach(function (count, c) {
        for (var row = 1; row <= count; row++) slots.push({ col: slotColumn(c), row: row });
      });
      return slots;
    }
    // 列番号版で各列をそろえる場合は，A1，B1，C1…の順に並べる。
    var maxRow = columnCounts.reduce(function (m, n) { return Math.max(m, n); }, 0);
    for (var r = 1; r <= maxRow; r++) {
      for (var c = 0; c < columnCounts.length; c++) {
        if (r <= columnCounts[c]) slots.push({ col: slotColumn(c), row: r });
      }
    }
    return slots;
  }

  function balancedCapacities(total, groupSize, groupCount, allowOverStandard, placeExtraAtEnd) {
    // 人数を組数で割った余りを1人ずつ配る。placeExtraAtEnd のときは後ろの組から配る。
    // 例：18人・4人基準・均等配分 → 4,4,4,3,3。183人・4人基準・後ろに加える → 4人組42，5人組3。
    var base = Math.floor(total / groupCount);
    var extra = total % groupCount;
    var caps = [];
    for (var i = 0; i < groupCount; i++) {
      var receivesExtra = placeExtraAtEnd ? i >= groupCount - extra : i < extra;
      caps.push(base + (receivesExtra ? 1 : 0));
    }
    // 行数上限を優先するために必要な場合だけ，基準人数を超えるグループを許容する。
    return allowOverStandard ? caps : caps.map(function (n) { return Math.min(n, groupSize); });
  }

  function createFruitGroups(s) {
    var total = s.totalStudents;
    var baseCapacity = Math.ceil(total / FRUITS.length);
    return FRUITS.map(function (f, i) {
      return {
        id: f.id,
        label: f.label,
        emoji: f.emoji,
        type: "fruit",
        col: "",
        row: i + 1,
        capacity: baseCapacity,
        detail: f.label + "グループ"
      };
    });
  }

  function columnLabel(index) {
    var n = index;
    var label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  function isNumberMode(mode) {
    return mode === "number" || mode === "plainNumber";
  }

  function preferredGroupCount(total, groupSize, remainderMode) {
    var fullGroupCount = Math.max(1, Math.ceil(total / groupSize));
    if (remainderMode === "balanced") return fullGroupCount;
    // 余った人を後ろの組に1人ずつ加える：基準人数の組を作り，余りの人数分だけ後ろの組を1人増やす。
    // 例：181人・4人基準 → 45組（5人組1），183人 → 45組（5人組3）。
    // 組数が余りより少なく1人ずつ配れない少人数の場合は，均等配分と同じ組数にする。
    var baseGroupCount = Math.floor(total / groupSize);
    var remainder = total % groupSize;
    return baseGroupCount >= 1 && remainder <= baseGroupCount ? baseGroupCount : fullGroupCount;
  }


export { normalizeSettings, createNumberGroups, createFruitGroups };
export function groupsFor(settings) { return settings.mode === "fruit" ? createFruitGroups(settings) : createNumberGroups(settings); }
export function cleanSettings(value) {
 const s = normalizeSettings(value);
 return Object.fromEntries(["mode", "totalStudents", "groupSize", "remainderMode", "columnFillMode", "columnCount", "rowLimitPerColumn", "columnRowLimits", "autoDailyReset", "genderBalance", "lastResetDate", "sessionId"].map(k => [k,s[k]]));
}
