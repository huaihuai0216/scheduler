import React, { useMemo, useState, useRef } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// --- Helpers ---
const fmt = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + "T00:00:00");
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const range = (n) => Array.from({ length: n }, (_, i) => i);

function clockToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function minutesToClock(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function round1(x) { return Math.round(x * 10) / 10; }
function fmtH(x) { return String(round1(Number(x))).replace(/\.0$/, ""); }

// 覆蓋檢查：blocks 覆蓋 [needStart, needEnd]
function ensuresCoverage(blocks, needStart, needEnd) {
  const segs = blocks
    .map((b) => ({ s: clockToMinutes(b.start), e: clockToMinutes(b.end) }))
    .sort((a, b) => a.s - b.s);
  let cur = clockToMinutes(needStart);
  const goal = clockToMinutes(needEnd);
  for (const seg of segs) {
    if (seg.e <= cur) continue;
    if (seg.s > cur) return false; // gap
    cur = Math.max(cur, seg.e);
    if (cur >= goal) return true;
  }
  return cur >= goal;
}

// === 休假/支援標記 ===
const MARK = {
  NONE: "NONE",
  OFF: "OFF",       // 休假
  PUBLIC: "PUBLIC", // 公假
  ANNUAL: "ANNUAL", // 特休
  COMP: "COMP",     // 補休
  SUPPORT: "SUPPORT"// 支援外店（不算本店人力，但計入個人工時）
};
const CYCLE = [MARK.NONE, MARK.OFF, MARK.PUBLIC, MARK.ANNUAL, MARK.COMP, MARK.SUPPORT];
function nextMark(t) {
  const i = CYCLE.indexOf(t ?? MARK.NONE);
  return CYCLE[(i + 1) % CYCLE.length];
}
function needsHours(t) {
  return t === MARK.PUBLIC || t === MARK.ANNUAL || t === MARK.COMP || t === MARK.SUPPORT; // 支援也可填時數
}
function getMark(p, dateStr) {
  return (p.marks && p.marks[dateStr]) || { type: MARK.NONE };
}

// Shift templates（顯示為實際上下班時間；hours 為「不含休息」的上班時數）
const TEMPLATES = {
  pharmacist: {
    P12: { start: "09:00", end: "22:00", hours: 12 }, // 13h 含休 1h
    P6A: { start: "09:00", end: "15:30", hours: 6 },  // 6.5h 含休 0.5h
    P6B: { start: "15:30", end: "22:00", hours: 6 },  // 6.5h 含休 0.5h
    P8A: { start: "09:00", end: "17:30", hours: 8 },  // 8.5h 含休 0.5h
    P8B: { start: "12:30", end: "21:00", hours: 8 },  // 8.5h 含休 0.5h
    P10A:{ start: "09:00", end: "20:00", hours: 10 }, // 11h 含休 1h
    P10B:{ start: "11:00", end: "22:00", hours: 10 }
  },
  clerk: {
    S6A: { start: "09:00", end: "15:30", hours: 6 },  // 6.5h 含休 0.5h
    S6B: { start: "15:30", end: "22:00", hours: 6 },  // 6.5h 含休 0.5h
    S8A: { start: "09:00", end: "17:30", hours: 8 },
    S8B: { start: "13:30", end: "22:00", hours: 8 },
    S10: { start: "11:00", end: "22:00", hours: 10 },
    S12: { start: "09:00", end: "22:00", hours: 12 }
  }
};

function defaultNames(n, prefix) {
  return range(n).map((i) => ({ 
    id: `${prefix}-${i + 1}`, 
    name: `${prefix}${i + 1}`, 
    marks: {},
    staffType: 'general', // 'manager' | 'general'
    score: 1 // 1-2分
  }));
}

// 班別類型識別函數
function getShiftType(shift) {
  const startTime = clockToMinutes(shift.start);
  const endTime = clockToMinutes(shift.end);
  const hours = shift.hours || 0;
  
  // 早班：09:00上班且上班時長為6或8小時
  if (startTime === clockToMinutes("09:00") && (hours === 6 || hours === 8)) {
    return 'morning';
  }
  
  // 晚班：22:00下班且上班時長為6或8小時
  if (endTime === clockToMinutes("22:00") && (hours === 6 || hours === 8)) {
    return 'evening';
  }
  
  // 全班：上班時長達10小時
  if (hours >= 10) {
    return 'full';
  }
  
  return 'other';
}

// 計算個人班別統計
function calculateShiftStats(schedule, allPeople) {
  const stats = new Map();
  
  // 初始化統計
  allPeople.forEach(person => {
    stats.set(person.id, {
      id: person.id,
      name: person.name,
      role: person.role || '',
      morning: 0,
      evening: 0,
      full: 0,
      other: 0
    });
  });
  
  // 統計各日班別
  schedule.days.forEach(day => {
    const allShifts = [...day.pharmacists, ...day.clerks];
    allShifts.forEach(shift => {
      const stat = stats.get(shift.id);
      if (stat) {
        const shiftType = getShiftType(shift);
        stat[shiftType]++;
      }
    });
  });
  
  return Array.from(stats.values());
}

// 檢查某個時段是否有當班主管
function hasManagerAtHour(dayShifts, allPeople, hour) {
  const hourMinutes = clockToMinutes(hour);
  
  for (const shift of dayShifts) {
    const person = allPeople.find(p => p.id === shift.id);
    if (person && person.staffType === 'manager') {
      const startMinutes = clockToMinutes(shift.start);
      const endMinutes = clockToMinutes(shift.end);
      if (startMinutes <= hourMinutes && hourMinutes < endMinutes) {
        return true;
      }
    }
  }
  return false;
}

// 計算某個時段的人力總分數
function calculateHourlyScore(dayShifts, allPeople, hour) {
  const hourMinutes = clockToMinutes(hour);
  let totalScore = 0;
  
  for (const shift of dayShifts) {
    const person = allPeople.find(p => p.id === shift.id);
    if (person) {
      const startMinutes = clockToMinutes(shift.start);
      const endMinutes = clockToMinutes(shift.end);
      if (startMinutes <= hourMinutes && hourMinutes < endMinutes) {
        totalScore += person.score || 1;
      }
    }
  }
  return totalScore;
}

// === 合併連續班（同人）並保留工時 ===
function mergeConsecutiveShiftsWithHours(shifts) {
  const byId = new Map();
  for (const s of shifts) {
    const arr = byId.get(s.id) || [];
    arr.push({ ...s, s: clockToMinutes(s.start), e: clockToMinutes(s.end) });
    byId.set(s.id, arr);
  }
  const out = [];
  for (const [id, arr] of byId) {
    arr.sort((a, b) => a.s - b.s);
    let cur = null; // {id, name, start, end, s, e, totalHours}
    for (const seg of arr) {
      if (!cur) {
        cur = { id, name: seg.name, start: seg.start, end: seg.end, s: seg.s, e: seg.e, totalHours: seg.hours || 0 };
      } else if (seg.s <= cur.e) {
        cur.e = Math.max(cur.e, seg.e);
        cur.end = minutesToClock(cur.e);
        cur.totalHours += seg.hours || 0;
      } else {
        out.push({ id, name: cur.name, start: cur.start, end: cur.end, totalHours: cur.totalHours });
        cur = { id, name: seg.name, start: seg.start, end: seg.end, s: seg.s, e: seg.e, totalHours: seg.hours || 0 };
      }
    }
    if (cur) out.push({ id, name: cur.name, start: cur.start, end: cur.end, totalHours: cur.totalHours });
  }
  return out.sort((a, b) => clockToMinutes(a.start) - clockToMinutes(b.start));
}

// 轉成顯示字串：含「休x」＋若 >10h 則「加y」並把結束時間往前推到只顯示基本10h
function formatEntryForDisplay(entry) {
  const s = clockToMinutes(entry.start);
  const e = clockToMinutes(entry.end);
  const elapsedH = (e - s) / 60;
  const workH = entry.totalHours ?? entry.hours ?? 0;
  const restH = Math.max(0, round1(elapsedH - workH));
  const baseWork = Math.min(workH, 10);
  const ot = Math.max(0, round1(workH - 10));
  const baseEnd = s + Math.round((baseWork + restH) * 60);
  const baseEndClock = minutesToClock(baseEnd);
  const parts = [`${entry.start}–${baseEndClock}`];
  if (restH > 0) parts.push(`休${fmtH(restH)}`);
  if (ot > 0) parts.push(`加${fmtH(ot)}`);
  return { text: parts.join(""), ot, workH };
}

// --- Core scheduling ---
function buildSchedule({ startDate, pharmacists, clerks, hourlyRequirements = {} }) {
  const days = range(28).map((i) => addDays(startDate, i));

  const result = days.map((date) => ({
    date,
    pharmacists: [], // {id,name,start,end,hours}
    clerks: [],
    warnings: []
  }));

  // 個人累積工時（不含休息），含「支援」
  const load = new Map(); // id -> total hours
  const addLoad = (id, h) => load.set(id, (load.get(id) || 0) + h);

  // 班別計數器
  const shiftCounts = new Map(); // id -> {morning: 0, evening: 0, full: 0}
  const initShiftCount = (id) => {
    if (!shiftCounts.has(id)) {
      shiftCounts.set(id, { morning: 0, evening: 0, full: 0 });
    }
  };
  
  const addShiftCount = (id, type) => {
    initShiftCount(id);
    const counts = shiftCounts.get(id);
    counts[type]++;
  };

  // 檢查某人前一天是否為晚班
  const hadEveningShiftYesterday = (personId, currentDateIndex) => {
    if (currentDateIndex === 0) return false;
    const yesterday = result[currentDateIndex - 1];
    const yesterdayShifts = [...yesterday.pharmacists, ...yesterday.clerks];
    
    for (const shift of yesterdayShifts) {
      if (shift.id === personId && getShiftType(shift) === 'evening') {
        return true;
      }
    }
    return false;
  };

  const pick = (staffList, hoursNeeded, dateStr, preferredShiftType = null, currentDateIndex = 0) => {
    // 可上班：沒有任何標記（MARK.NONE）者
    const avail = staffList.filter((p) => getMark(p, dateStr).type === MARK.NONE);
    if (avail.length === 0) return null;
    
    // 初始化班別計數
    avail.forEach(p => initShiftCount(p.id));
    
    // 排序邏輯：先考慮班別公平，再考慮工時平衡
    avail.sort((a, b) => {
      const aLoad = load.get(a.id) || 0;
      const bLoad = load.get(b.id) || 0;
      const aCounts = shiftCounts.get(a.id);
      const bCounts = shiftCounts.get(b.id);
      
      // 避免連續晚早班（優先度較低，在其他條件相近時才考慮）
      if (preferredShiftType === 'morning') {
        const aHadEvening = hadEveningShiftYesterday(a.id, currentDateIndex);
        const bHadEvening = hadEveningShiftYesterday(b.id, currentDateIndex);
        
        // 如果其他條件相近，優先選擇昨天非晚班的人
        if (aHadEvening !== bHadEvening) {
          const otherFactorsEqual = Math.abs(aLoad - bLoad) <= 2 && 
                                  Math.abs((aCounts.morning + aCounts.evening) - (bCounts.morning + bCounts.evening)) <= 1;
          if (otherFactorsEqual) {
            return aHadEvening ? 1 : -1;
          }
        }
      }
      
      // 如有指定班別類型，優先選擇該班別次數較少的人
      if (preferredShiftType && preferredShiftType !== 'other') {
        const aDiff = aCounts[preferredShiftType] - bCounts[preferredShiftType];
        if (aDiff !== 0) return aDiff;
      }
      
      // 早晚班平衡：選擇早晚班總數較少的人
      const aMorningEvening = aCounts.morning + aCounts.evening;
      const bMorningEvening = bCounts.morning + bCounts.evening;
      const balanceDiff = aMorningEvening - bMorningEvening;
      if (balanceDiff !== 0) return balanceDiff;
      
      // 最後考慮工時平衡
      return aLoad - bLoad;
    });
    
    const chosen = avail[0];
    addLoad(chosen.id, hoursNeeded);
    return chosen;
  };

  // 先計入「公/特/補/支」時數到個人 load（不算本店人力）
  for (const day of result) {
    const dateStr = fmt(day.date);
    for (const p of pharmacists) {
      const m = getMark(p, dateStr);
      if (m.type === MARK.SUPPORT) addLoad(p.id, Number(m.hours || 8));
      else if ([MARK.PUBLIC, MARK.ANNUAL, MARK.COMP].includes(m.type)) addLoad(p.id, Number(m.hours || 0));
    }
    for (const c of clerks) {
      const m = getMark(c, dateStr);
      if (m.type === MARK.SUPPORT) addLoad(c.id, Number(m.hours || 8));
      else if ([MARK.PUBLIC, MARK.ANNUAL, MARK.COMP].includes(m.type)) addLoad(c.id, Number(m.hours || 0));
    }
  }

  for (let dayIndex = 0; dayIndex < result.length; dayIndex++) {
    const day = result[dayIndex];
    const dateStr = fmt(day.date);

    // === 規則新增：若某組人數為 2 且兩人都可上班，則兩人必上 ===
    const pAvail = pharmacists.filter((p) => getMark(p, dateStr).type === MARK.NONE);
    const cAvail = clerks.filter((c) => getMark(c, dateStr).type === MARK.NONE);

    // Pharmacists
    if (pharmacists.length === 2 && pAvail.length === 2) {
      // 兩人必上，各排 6h 區段以避免 12h，考慮早晚班平衡
      pAvail.forEach(p => initShiftCount(p.id));
      const sorted = [...pAvail].sort((a, b) => {
        const aLoad = load.get(a.id) || 0;
        const bLoad = load.get(b.id) || 0;
        const aCounts = shiftCounts.get(a.id);
        const bCounts = shiftCounts.get(b.id);
        
        // 早晚班平衡優先
        const aMorningEvening = aCounts.morning + aCounts.evening;
        const bMorningEvening = bCounts.morning + bCounts.evening;
        const balanceDiff = aMorningEvening - bMorningEvening;
        if (balanceDiff !== 0) return balanceDiff;
        
        return aLoad - bLoad;
      });
      
      const pA = sorted[0], pB = sorted[1];
      const aShift = { id: pA.id, name: pA.name, ...TEMPLATES.pharmacist.P6A };
      const bShift = { id: pB.id, name: pB.name, ...TEMPLATES.pharmacist.P6B };
      
      day.pharmacists.push(aShift); 
      day.pharmacists.push(bShift);
      addLoad(pA.id, 6);
      addLoad(pB.id, 6);
      addShiftCount(pA.id, getShiftType(aShift));
      addShiftCount(pB.id, getShiftType(bShift));
    } else {
      // 原有策略：同組全員可上（且≥2）則避免 12h
      const avoidP12 = pAvail.length === pharmacists.length && pAvail.length >= 2;
      if (!avoidP12) {
        const pCandidate = pick(pharmacists, 12, dateStr, 'full', dayIndex);
        if (pCandidate) {
          const shift = { id: pCandidate.id, name: pCandidate.name, ...TEMPLATES.pharmacist.P12 };
          day.pharmacists.push(shift);
          addShiftCount(pCandidate.id, getShiftType(shift));
        } else {
          const pA = pick(pharmacists, 6, dateStr, 'morning', dayIndex);
          const pB = pick(pharmacists, 6, dateStr, 'evening', dayIndex);
          if (pA) {
            const shiftA = { id: pA.id, name: pA.name, ...TEMPLATES.pharmacist.P6A };
            day.pharmacists.push(shiftA);
            addShiftCount(pA.id, getShiftType(shiftA));
          }
          if (pB) {
            const shiftB = { id: pB.id, name: pB.name, ...TEMPLATES.pharmacist.P6B };
            day.pharmacists.push(shiftB);
            addShiftCount(pB.id, getShiftType(shiftB));
          }
        }
      } else {
        const pA = pick(pharmacists, 6, dateStr, 'morning', dayIndex);
        const pB = pick(pharmacists, 6, dateStr, 'evening', dayIndex);
        if (pA) {
          const shiftA = { id: pA.id, name: pA.name, ...TEMPLATES.pharmacist.P6A };
          day.pharmacists.push(shiftA);
          addShiftCount(pA.id, getShiftType(shiftA));
        }
        if (pB) {
          const shiftB = { id: pB.id, name: pB.name, ...TEMPLATES.pharmacist.P6B };
          day.pharmacists.push(shiftB);
          addShiftCount(pB.id, getShiftType(shiftB));
        }
      }
    }
    if (!ensuresCoverage(day.pharmacists, "09:00", "21:00")) {
      day.warnings.push("藥師人力不足，09:00-21:00 覆蓋未完整。");
    }

    // Clerks
    if (clerks.length === 2 && cAvail.length === 2) {
      cAvail.forEach(c => initShiftCount(c.id));
      const sorted = [...cAvail].sort((a, b) => {
        const aLoad = load.get(a.id) || 0;
        const bLoad = load.get(b.id) || 0;
        const aCounts = shiftCounts.get(a.id);
        const bCounts = shiftCounts.get(b.id);
        
        // 早晚班平衡優先
        const aMorningEvening = aCounts.morning + aCounts.evening;
        const bMorningEvening = bCounts.morning + bCounts.evening;
        const balanceDiff = aMorningEvening - bMorningEvening;
        if (balanceDiff !== 0) return balanceDiff;
        
        return aLoad - bLoad;
      });
      
      const cA = sorted[0], cB = sorted[1];
      const aShift = { id: cA.id, name: cA.name, ...TEMPLATES.clerk.S6A };
      const bShift = { id: cB.id, name: cB.name, ...TEMPLATES.clerk.S6B };
      
      day.clerks.push(aShift);
      day.clerks.push(bShift);
      addLoad(cA.id, 6);
      addLoad(cB.id, 6);
      addShiftCount(cA.id, getShiftType(aShift));
      addShiftCount(cB.id, getShiftType(bShift));
    } else {
      const avoidC12 = cAvail.length === clerks.length && cAvail.length >= 2;
      const cA = pick(clerks, 6, dateStr, 'morning', dayIndex);
      const cB = pick(clerks, 6, dateStr, 'evening', dayIndex);
      if (cA) {
        const shiftA = { id: cA.id, name: cA.name, ...TEMPLATES.clerk.S6A };
        day.clerks.push(shiftA);
        addShiftCount(cA.id, getShiftType(shiftA));
      }
      if (cB) {
        const shiftB = { id: cB.id, name: cB.name, ...TEMPLATES.clerk.S6B };
        day.clerks.push(shiftB);
        addShiftCount(cB.id, getShiftType(shiftB));
      }
      if (!ensuresCoverage(day.clerks, "09:00", "22:00")) {
        if (!avoidC12) {
          day.clerks = [];
          const c12 = pick(clerks, 12, dateStr, 'full', dayIndex);
          if (c12) {
            const shift12 = { id: c12.id, name: c12.name, ...TEMPLATES.clerk.S12 };
            day.clerks.push(shift12);
            addShiftCount(c12.id, getShiftType(shift12));
          }
        }
      }
    }
    if (!ensuresCoverage(day.clerks, "09:00", "22:00")) {
      day.warnings.push("門市人力不足，09:00-22:00 覆蓋未完整。");
    }

    // 檢查營業時間是否有當班主管 (09:00-22:00)
    const allPeople = [...pharmacists, ...clerks];
    const allDayShifts = [...day.pharmacists, ...day.clerks];
    const businessHours = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
    
    for (const hour of businessHours) {
      if (!hasManagerAtHour(allDayShifts, allPeople, hour)) {
        day.warnings.push(`${hour} 時段缺少當班主管。`);
        break; // 只提示一次避免過多警告
      }
    }

    // 檢查各時段人力分數是否達標
    for (const hour of businessHours) {
      const requiredScore = hourlyRequirements[hour];
      if (requiredScore) {
        const actualScore = calculateHourlyScore(allDayShifts, allPeople, hour);
        if (actualScore < requiredScore) {
          day.warnings.push(`${hour} 時段人力分數不足：需要${requiredScore}分，實際${actualScore}分。`);
        }
      }
    }
  }

  // === 每人每日工時（含支援；不含休息）與加班統計 ===
  const stats = new Map(); // id -> { id, name, role, work:0, ot:0 }
  const indexPerson = (list, role) => list.forEach(p => {
    if (!stats.has(p.id)) stats.set(p.id, { id: p.id, name: p.name, role, work: 0, ot: 0 });
  });
  indexPerson(pharmacists, '藥師');
  indexPerson(clerks, '門市');

  for (const day of result) {
    const dateStr = fmt(day.date);
    const dayWork = new Map(); // id -> hours (不含休息)

    for (const s of day.pharmacists) dayWork.set(s.id, (dayWork.get(s.id) || 0) + (s.hours || 0));
    for (const s of day.clerks) dayWork.set(s.id, (dayWork.get(s.id) || 0) + (s.hours || 0));

    // 公/特/補/支 算個人工時
    for (const p of pharmacists) {
      const m = getMark(p, dateStr);
      if ([MARK.PUBLIC, MARK.ANNUAL, MARK.COMP, MARK.SUPPORT].includes(m.type)) dayWork.set(p.id, (dayWork.get(p.id) || 0) + Number(m.hours || 0));
    }
    for (const c of clerks) {
      const m = getMark(c, dateStr);
      if ([MARK.PUBLIC, MARK.ANNUAL, MARK.COMP, MARK.SUPPORT].includes(m.type)) dayWork.set(c.id, (dayWork.get(c.id) || 0) + Number(m.hours || 0));
    }

    // 累加到總表
    for (const [pid, h] of dayWork) {
      const st = stats.get(pid);
      if (!st) continue;
      const base = Math.min(h, 10);
      const ot = Math.max(0, round1(h - 10));
      st.work += base;
      st.ot += ot;
    }
  }

  // 計算班別統計
  const allPeople = [
    ...pharmacists.map(p => ({ ...p, role: '藥師' })),
    ...clerks.map(p => ({ ...p, role: '門市' }))
  ];
  const shiftStats = calculateShiftStats({ days: result }, allPeople);

  return { days: result, stats: Array.from(stats.values()), shiftStats };
}

// === 單一表格的「休假/支援」編輯器（橫軸：所有人員；縱軸：日期） ===
function PeopleEditorCombined({ pharmacists, setPharmacists, clerks, setClerks, days }) {
  // 合併人員清單，保留角色與來源 setter
  const people = [
    ...pharmacists.map((p, i) => ({ ...p, role: '藥師', group: 'p', idx: i })),
    ...clerks.map((p, i) => ({ ...p, role: '門市', group: 'c', idx: i })),
  ];

  const apply = (group, updater) => {
    if (group === 'p') setPharmacists((prev) => updater([...prev]));
    else setClerks((prev) => updater([...prev]));
  };

  const cycle = (person, dateStr) => {
    apply(person.group, (arr) => {
      const p = { ...arr[person.idx] };
      const cur = getMark(p, dateStr).type;
      const nxt = nextMark(cur);
      const marks = { ...(p.marks || {}) };
      if (nxt === MARK.NONE) delete marks[dateStr];
      else {
        const defaultHours = nxt === MARK.SUPPORT ? 8 : undefined;
        marks[dateStr] = { type: nxt, hours: defaultHours };
      }
      p.marks = marks;
      arr[person.idx] = p;
      return arr;
    });
  };

  const setHours = (person, dateStr, hours) => {
    apply(person.group, (arr) => {
      const p = { ...arr[person.idx] };
      const marks = { ...(p.marks || {}) };
      const m = marks[dateStr] || { type: MARK.PUBLIC };
      marks[dateStr] = { ...m, hours: hours === '' ? undefined : Number(hours) };
      p.marks = marks;
      arr[person.idx] = p;
      return arr;
    });
  };

  const rename = (person, name) => {
    apply(person.group, (arr) => {
      arr[person.idx] = { ...arr[person.idx], name };
      return arr;
    });
  };

  const updateStaffType = (person, staffType) => {
    apply(person.group, (arr) => {
      arr[person.idx] = { ...arr[person.idx], staffType };
      return arr;
    });
  };

  const updateScore = (person, score) => {
    apply(person.group, (arr) => {
      arr[person.idx] = { ...arr[person.idx], score };
      return arr;
    });
  };

  const badge = (t) => {
    switch (t) {
      case MARK.OFF: return { txt: '休', cls: 'bg-rose-50 border-rose-200 text-rose-700' };
      case MARK.PUBLIC: return { txt: '公', cls: 'bg-sky-50 border-sky-200 text-sky-700' };
      case MARK.ANNUAL: return { txt: '特', cls: 'bg-amber-50 border-amber-200 text-amber-700' };
      case MARK.COMP: return { txt: '補', cls: 'bg-violet-50 border-violet-200 text-violet-700' };
      case MARK.SUPPORT: return { txt: '支', cls: 'bg-slate-50 border-slate-200 text-slate-700' };
      default: return { txt: '班', cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' };
    }
  };

  return (
    <div className="border rounded-2xl p-4 shadow-sm bg-white">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-semibold">休假/支援設定</h3>
          <div className="text-sm text-gray-500">（橫軸：人員；縱軸：日期）</div>
        </div>
        <div className="text-sm text-gray-500 text-right">
          <div>點格子循環：班 → 休 → 公 → 特 → 補 → 支</div>
          <div>（公/特/補/支可填時數）</div>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="min-w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white border-b p-2 text-sm w-28">日期</th>
              {people.map((p) => (
                <th key={p.id} className="border-b p-2 text-sm min-w-[180px] text-left">
                  <div className="text-[11px] text-gray-500 mb-1">{p.role}</div>
                  <input
                    className="border rounded px-2 py-1 w-full text-sm mb-1"
                    value={p.name}
                    onChange={(e) => rename(p, e.target.value)}
                  />
                  <div className="flex gap-1 text-xs">
                    <select
                      className="border rounded px-1 py-0.5 text-xs flex-1"
                      value={p.staffType || 'general'}
                      onChange={(e) => updateStaffType(p, e.target.value)}
                    >
                      <option value="manager">當班主管</option>
                      <option value="general">一般人力</option>
                    </select>
                    <select
                      className="border rounded px-1 py-0.5 text-xs w-12"
                      value={p.score || 1}
                      onChange={(e) => updateScore(p, Number(e.target.value))}
                    >
                      <option value="1">1分</option>
                      <option value="2">2分</option>
                    </select>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={fmt(d)}>
                <td className="sticky left-0 bg-white border-b p-2 text-sm w-28">
                  <div className="font-medium">{d.getMonth()+1}/{d.getDate()}</div>
                  <div className="text-[11px] text-gray-500">週{["日","一","二","三","四","五","六"][d.getDay()]}</div>
                </td>
                {people.map((p) => {
                  const dateStr = fmt(d);
                  const m = getMark(p, dateStr);
                  const b = badge(m.type);
                  return (
                    <td key={p.id+dateStr} className={`border-b p-2 align-top` }>
                      <button
                        className={`w-full text-left border rounded px-2 py-1 ${b.cls}`}
                        onClick={() => cycle(p, dateStr)}
                        title={`${b.txt}${m.hours?` ${m.hours}h`:''}`}
                      >{b.txt}{m.hours?` ${m.hours}h`:''}</button>
                      {needsHours(m.type) && (
                        <input
                          type="number" min={0} step={0.5}
                          className="mt-1 w-full border rounded px-2 py-1 text-sm"
                          placeholder="時數"
                          value={m.hours ?? ''}
                          onChange={(e)=>setHours(p, dateStr, e.target.value)}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// === 班表矩陣（橫軸：人員；縱軸：日期）並提供 PDF ===
function ScheduleMatrix({ schedule, pharmacists, clerks, expectedHours }) {
  const containerRef = useRef(null);
  const { days, stats } = schedule;
  const from = fmt(days[0].date);
  const to = fmt(days[days.length - 1].date);

  const dlPdf = async () => {
    const node = containerRef.current;
    if (!node) return;
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    pdf.addImage(imgData, "PNG", margin, margin, imgWidth, imgHeight);

    const usable = pageHeight - margin * 2;
    let heightLeft = imgHeight - usable;
    let position = margin;

    while (heightLeft > 0) {
      pdf.addPage();
      position -= usable;
      pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight);
      heightLeft -= usable;
    }

    pdf.save(`schedule_${from}_to_${to}.pdf`);
  };

  const people = [
    ...pharmacists.map((p) => ({ ...p, role: '藥師' })),
    ...clerks.map((p) => ({ ...p, role: '門市' })),
  ];

  // 取得某人的該日總工時與加班（不含休息；支援計入個人）
  function getDayWork(person, d) {
    const dateStr = fmt(d.date);
    const entries = (person.role === '藥師' ? d.pharmacists : d.clerks).filter(x => x.id === person.id);
    let h = entries.reduce((acc, e) => acc + (e.hours || 0), 0);
    const m = getMark(person, dateStr);
    if ([MARK.PUBLIC, MARK.ANNUAL, MARK.COMP, MARK.SUPPORT].includes(m.type)) h += Number(m.hours || 0);
    const ot = Math.max(0, round1(h - 10));
    const base = Math.min(h, 10);
    return { base: round1(base), ot };
  }

  const renderMatrix = () => (
    <div className="mb-6">
      <div className="overflow-auto">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 bg-white border-b p-2 w-28 align-bottom">日期</th>
              {people.map((p)=> (
                <th key={p.id} colSpan={3} className="border-b p-2 min-w-[220px] text-left">
                  <div className="text-[11px] text-gray-500 mb-1">{p.role}</div>
                  {p.name}
                </th>
              ))}
            </tr>
            <tr>
              {people.map((p)=> (
                <React.Fragment key={p.id+"-sub"}>
                  <th className="border-b p-2 text-left">班別</th>
                  <th className="border-b p-2 text-right">上班時數</th>
                  <th className="border-b p-2 text-right">加班時數</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const dateStr = fmt(d.date);
              const mergedP = mergeConsecutiveShiftsWithHours(d.pharmacists);
              const mergedC = mergeConsecutiveShiftsWithHours(d.clerks);
              return (
                <tr key={dateStr}>
                  <td className="sticky left-0 bg-white border-b p-2 w-28 align-top">
                    <div className="font-medium">{d.date.getMonth()+1}/{d.date.getDate()}</div>
                    <div className="text-[11px] text-gray-500">週{["日","一","二","三","四","五","六"][d.date.getDay()]}</div>
                  </td>
                  {people.map((p) => {
                    const entries = (p.role==='藥師'?mergedP:mergedC).filter(x => x.id === p.id);
                    const m = getMark(p, dateStr);
                    let text = '';
                    if (entries.length > 0) {
                      text = entries.map(e => formatEntryForDisplay(e).text).join(' / ');
                    } else {
                      switch (m.type) {
                        case MARK.OFF: text = '休'; break;
                        case MARK.PUBLIC: text = `公${m.hours?fmtH(m.hours):''}`.trim(); break;
                        case MARK.ANNUAL: text = `特${m.hours?fmtH(m.hours):''}`.trim(); break;
                        case MARK.COMP: text = `補${m.hours?fmtH(m.hours):''}`.trim(); break;
                        case MARK.SUPPORT: text = `支${m.hours?fmtH(m.hours):''}`.trim(); break;
                        default: text = '';
                      }
                    }
                    const { base, ot } = getDayWork(p, d);
                    return (
                      <React.Fragment key={p.id+dateStr}>
                        <td className="border-b p-2 align-top tabular-nums">{text}</td>
                        <td className="border-b p-2 align-top text-right tabular-nums">{base ? fmtH(base) : ''}</td>
                        <td className="border-b p-2 align-top text-right tabular-nums">{ot ? fmtH(ot) : ''}</td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
            {/* 工時總計行 */}
            <tr>
              <td className="sticky left-0 bg-white border-t p-2 text-sm font-medium">工時合計</td>
              {people.map((p) => {
                // 直接將「上班時數」逐日加總（不含加班）
                const totals = days.reduce((acc, d) => {
                  const { base, ot } = getDayWork(p, d);
                  acc.base += base || 0;
                  acc.ot += ot || 0; // 仍顯示總加班供參考，但不影響差額
                  return acc;
                }, { base: 0, ot: 0 });
                const diff = round1((expectedHours || 0) - totals.base);
                return (
                  <React.Fragment key={p.id+"-total"}>
                    <td className="border-t p-2 text-left tabular-nums">{`差${fmtH(diff)}`}</td>
                    <td className="border-t p-2 text-right tabular-nums">{fmtH(totals.base)}</td>
                    <td className="border-t p-2 text-right tabular-nums">{fmtH(totals.ot)}</td>
                  </React.Fragment>
                );
              })}
            </tr>
            {/* 班別統計行 */}
            <tr>
              <td className="sticky left-0 bg-white border-t p-2 text-sm font-medium">班別統計</td>
              {people.map((p) => {
                const stat = (schedule.shiftStats || []).find(s => s.id === p.id);
                const shiftInfo = stat 
                  ? `早${stat.morning}晚${stat.evening}全${stat.full}` 
                  : '早0晚0全0';
                return (
                  <React.Fragment key={p.id+"-shifts"}>
                    <td className="border-t p-2 text-left tabular-nums text-xs">{shiftInfo}</td>
                    <td className="border-t p-2 text-right tabular-nums text-xs">{p.staffType === 'manager' ? '主管' : '一般'}</td>
                    <td className="border-t p-2 text-right tabular-nums text-xs">{p.score || 1}分</td>
                  </React.Fragment>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  // 收集所有警告
  const allWarnings = days.reduce((acc, day) => {
    if (day.warnings && day.warnings.length > 0) {
      acc.push({
        date: `${day.date.getMonth()+1}/${day.date.getDate()}`,
        warnings: day.warnings
      });
    }
    return acc;
  }, []);

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold">產生的班表（橫軸：人員；縱軸：日期）</h3>
        <button onClick={dlPdf} className="px-3 py-1.5 rounded-lg border shadow-sm text-sm">匯出 PDF</button>
      </div>
      
      {/* 警告提示 */}
      {allWarnings.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <h4 className="text-sm font-medium text-amber-800 mb-2">排班警告</h4>
          <div className="text-sm text-amber-700 space-y-1">
            {allWarnings.map((item, index) => (
              <div key={index}>
                <span className="font-medium">{item.date}：</span>
                {item.warnings.join('；')}
              </div>
            ))}
          </div>
        </div>
      )}
      
      <div ref={containerRef}>
        {renderMatrix()}
      </div>
    </div>
  );
}

export default function SchedulerApp() {
  const today = new Date();
  const defaultStart = useMemo(() => {
    const d = new Date(today);
    const day = d.getDay(); // 0=Sun
    const delta = day === 0 ? -6 : 1 - day; // move to Monday
    d.setDate(d.getDate() + delta);
    return d;
  }, []);

  const [startDateStr, setStartDateStr] = useState(fmt(defaultStart));
  const startDate = useMemo(() => parse(startDateStr), [startDateStr]);

  const [pCount, setPCount] = useState(2);
  const [cCount, setCCount] = useState(2); // 假設同組 2 人情境常見

  const [expectedHours, setExpectedHours] = useState(160); // 新增：每人應上時數

  // 時段人力分數需求設定
  const [hourlyRequirements, setHourlyRequirements] = useState({
    "09:00": 2, "10:00": 2, "11:00": 2, "12:00": 3, "13:00": 3, "14:00": 3,
    "15:00": 3, "16:00": 3, "17:00": 3, "18:00": 3, "19:00": 3, "20:00": 3, "21:00": 2
  });

  const [pharmacists, setPharmacists] = useState(() => defaultNames(pCount, "藥師"));
  const [clerks, setClerks] = useState(() => defaultNames(cCount, "門市"));

  const resize = (arr, n, prefix) => {
    const cur = [...arr];
    if (n > cur.length) {
      for (let i = cur.length; i < n; i++) cur.push({ id: `${prefix}-${i+1}`, name: `${prefix}${i+1}`, marks: {} });
    } else if (n < cur.length) {
      cur.length = n;
    }
    return cur;
  };

  const onPCountChange = (n) => setPharmacists((prev) => resize(prev, n, "藥師"));
  const onCCountChange = (n) => setClerks((prev) => resize(prev, n, "門市"));

  const days = useMemo(() => range(28).map((i) => addDays(startDate, i)), [startDate]);

  const [schedule, setSchedule] = useState(null);

  const generate = () => {
    const data = buildSchedule({ startDate, pharmacists, clerks, hourlyRequirements });
    setSchedule(data);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">排班助手 · 28 天</h1>
          <div className="text-sm text-gray-600">營業時間 09:00–22:00｜藥師覆蓋 09:00–21:00</div>
        </header>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-1 border rounded-2xl p-4 bg-white shadow-sm">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">起始週一</label>
                  <input
                    type="date"
                    className="border rounded-lg px-3 py-2 w-full"
                    value={startDateStr}
                    onChange={(e) => setStartDateStr(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">應上時數（每人）</label>
                  <input
                    type="number" min={0} step={1}
                    className="border rounded-lg px-3 py-2 w-full"
                    value={expectedHours}
                    onChange={(e) => setExpectedHours(Number(e.target.value || 0))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">藥師人數</label>
                  <input
                    type="number" min={1}
                    className="border rounded-lg px-3 py-2 w-full"
                    value={pCount}
                    onChange={(e) => {
                      const n = Math.max(1, Number(e.target.value || 1));
                      setPCount(n);
                      onPCountChange(n);
                    }}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1">門市人數</label>
                  <input
                    type="number" min={1}
                    className="border rounded-lg px-3 py-2 w-full"
                    value={cCount}
                    onChange={(e) => {
                      const n = Math.max(1, Number(e.target.value || 1));
                      setCCount(n);
                      onCCountChange(n);
                    }}
                  />
                </div>
              </div>

              <button onClick={generate} className="w-full mt-2 px-4 py-2 rounded-xl bg-black text-white font-medium shadow">產生班表</button>

              <div className="mt-4">
                <label className="block text-sm text-gray-700 mb-2">各時段人力分數需求</label>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  {Object.entries(hourlyRequirements).map(([hour, score]) => (
                    <div key={hour} className="flex items-center gap-1">
                      <span className="w-12">{hour}</span>
                      <input
                        type="number" min={1} max={10} step={1}
                        className="border rounded px-1 py-0.5 w-12 text-xs"
                        value={score}
                        onChange={(e) => setHourlyRequirements(prev => ({
                          ...prev,
                          [hour]: Number(e.target.value || 1)
                        }))}
                      />
                      <span>分</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-xs text-gray-500 mt-4">
                生成邏輯：
                <ul className="list-disc ml-5 mt-1 space-y-1">
                  <li>早晚班公平分配：早班(09:00上班6-8h)、晚班(22:00下班6-8h)、全班(10h+)。</li>
                  <li>避免連續晚早班：22:00下班後隔天盡量不排09:00上班。</li>
                  <li>營業時間需至少一位當班主管，各時段需達設定人力分數。</li>
                  <li>若同組人數 = 2 且兩人皆可上班，則兩人必上（各 6h 段）。</li>
                  <li>可標記：休 / 公 / 特 / 補 / 支；「公/特/補/支」不算本店人力，但會計入個人工時。</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="md:col-span-2 space-y-6">
            <PeopleEditorCombined
              pharmacists={pharmacists}
              setPharmacists={setPharmacists}
              clerks={clerks}
              setClerks={setClerks}
              days={days}
            />
          </div>
        </div>

        {schedule && (
          <ScheduleMatrix
            schedule={schedule}
            pharmacists={pharmacists}
            clerks={clerks}
            expectedHours={expectedHours}
          />
        )}
      </div>
    </div>
  );
}
