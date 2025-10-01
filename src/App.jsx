// SchedulerApp.jsx — 覆蓋整檔
import React, { useMemo, useState, useRef, useEffect } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// ===== 常數（欄寬、循環等） =====
const COLW = {
  editorDateCol: 112,
  editorPersonCol: 220,
  schedDateCol: 90,
  schedShiftCol: 150,
  schedHoursCol: 68,
  schedOTCol: 68
};

const SHIFT_CYCLE = {
  pharmacist: ["NONE","P6A","P6B","P8A","P8B","P10A","P10B","P12","OFF","PUBLIC","ANNUAL","COMP","SUPPORT"],
  clerk:      ["NONE","S6A","S6B","S8A","S8B","S10","S12","OFF","PUBLIC","ANNUAL","COMP","SUPPORT"]
};
const MARK_DEFAULT_HOURS = { PUBLIC: 8, ANNUAL: 8, COMP: 8, SUPPORT: 8 };

function tplCoversHour(tpl, hour) {
  const t = clockToMinutes(hour);
  return clockToMinutes(tpl.start) <= t && t < clockToMinutes(tpl.end);
}

// 依角色給出「覆蓋某整點」的班別候選（優先 6h → 8h → 10h；最後不含 12h）
function coveringTemplatesFor(role, hour) {
  const K = role === '門市' ? TEMPLATES.clerk : TEMPLATES.pharmacist;
  const order = role === '門市'
    ? [K.S6A, K.S6B, K.S8A, K.S8B, K.S10]     // S12 不列入一般補位
    : [K.P6A, K.P6B, K.P8A, K.P8B, K.P10A, K.P10B]; // P12 不列入一般補位
  return order.filter(t => tplCoversHour(t, hour));
}

// 取模板代碼（顯示/統計用）
function codeOfTemplate(role, tpl) {
  const dict = role === '門市' ? TEMPLATES.clerk : TEMPLATES.pharmacist;
  const hit = Object.entries(dict).find(([k, v]) => v === tpl);
  return hit ? hit[0] : '';
}

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
  OFF: "OFF",
  PUBLIC: "PUBLIC",
  ANNUAL: "ANNUAL",
  COMP: "COMP",
  SUPPORT: "SUPPORT"
};
const CYCLE = [MARK.NONE, MARK.OFF, MARK.PUBLIC, MARK.ANNUAL, MARK.COMP, MARK.SUPPORT];
function nextMark(t) {
  const i = CYCLE.indexOf(t ?? MARK.NONE);
  return CYCLE[(i + 1) % CYCLE.length];
}
function needsHours(t) {
  return t === MARK.PUBLIC || t === MARK.ANNUAL || t === MARK.COMP || t === MARK.SUPPORT;
}
function getMark(p, dateStr) {
  return (p.marks && p.marks[dateStr]) || { type: MARK.NONE };
}

// Shift templates（hours 為「不含休息」的上班時數）
const TEMPLATES = {
  pharmacist: {
    P12:  { start: "09:00", end: "22:00", hours: 12 },
    P6A:  { start: "09:00", end: "15:30", hours: 6 },
    P6B:  { start: "15:30", end: "22:00", hours: 6 },
    P8A:  { start: "09:00", end: "17:30", hours: 8 },
    P8B:  { start: "12:30", end: "21:00", hours: 8 },
    P10A: { start: "09:00", end: "20:00", hours: 10 },
    P10B: { start: "11:00", end: "22:00", hours: 10 }
  },
  clerk: {
    S6A:  { start: "09:00", end: "15:30", hours: 6 },
    S6B:  { start: "15:30", end: "22:00", hours: 6 },
    S8A:  { start: "09:00", end: "17:30", hours: 8 },
    S8B:  { start: "13:30", end: "22:00", hours: 8 },
    S10:  { start: "11:00", end: "22:00", hours: 10 },
    S12:  { start: "09:00", end: "22:00", hours: 12 }
  }
};

function defaultNames(n, prefix) {
  return range(n).map((i) => ({
    id: `${prefix}-${i + 1}`,
    name: `${prefix}${i + 1}`,
    marks: {},
    staffType: 'general',
    score: 1,
    hasKey: false
  }));
}

// 班別類型（統計用）— 依新規則：>10h 才算 full；09:00 開始算早；22:00 結束算晚
function getShiftType(shift) {
  const start = clockToMinutes(shift.start);
  const end   = clockToMinutes(shift.end);
  const hours = Number(shift.hours || 0);

  if (hours > 10) return 'full';                        // 只有「超過 10 小時」才算全班
  if (start === clockToMinutes("09:00")) return 'morning';
  if (end   === clockToMinutes("22:00")) return 'evening';
  return 'other';
}


// 統計
function calculateShiftStats(schedule, allPeople) {
  const stats = new Map();
  allPeople.forEach(person => {
    stats.set(person.id, {
      id: person.id, name: person.name, role: person.role || '',
      morning: 0, evening: 0, full: 0, other: 0
    });
  });
  schedule.days.forEach(day => {
    const allShifts = [...day.pharmacists, ...day.clerks];
    allShifts.forEach(shift => {
      const stat = stats.get(shift.id);
      if (stat) stat[getShiftType(shift)]++;
    });
  });
  return Array.from(stats.values());
}

// 某時段是否有主管
function hasManagerAtHour(dayShifts, allPeople, hour) {
  const t = clockToMinutes(hour);
  for (const shift of dayShifts) {
    const person = allPeople.find(p => p.id === shift.id);
    if (person && person.staffType === 'manager') {
      const s = clockToMinutes(shift.start), e = clockToMinutes(shift.end);
      if (s <= t && t < e) return true;
    }
  }
  return false;
}

// ✅ 人力分數（同一時段同一人只算一次）
function calculateHourlyScore(dayShifts, allPeople, hour) {
  const t = clockToMinutes(hour);
  const coveredIds = new Set();
  for (const shift of dayShifts) {
    const s = clockToMinutes(shift.start), e = clockToMinutes(shift.end);
    if (s <= t && t < e) coveredIds.add(shift.id);
  }
  let total = 0;
  for (const id of coveredIds) {
    const person = allPeople.find(p => p.id === id);
    if (person) total += person.score || 1;
  }
  return total;
}

// 合併連續班（顯示用）
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
    let cur = null;
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

/* ========= 新增：需求驅動用的小工具 ========= */

// 回傳每小時的缺口（need - actual，負數視為 0）
function hourShortageAt(allShifts, allPeople, hourlyReq, hour) {
  const need = hourlyReq[hour] || 0;
  const got = calculateHourlyScore(allShifts, allPeople, hour);
  return Math.max(0, need - got);
}

// 將 09:00～21:00 的缺口做成 map（目前未直接使用，但保留以便除錯）
function shortageMap(allShifts, allPeople, hourlyReq, HOURS) {
  const out = {};
  for (const h of HOURS) out[h] = hourShortageAt(allShifts, allPeople, hourlyReq, h);
  return out;
}

// 計算【某候選「人 × 班別模板」】加入後能減少多少「缺口總和」（考慮該人的 score）
function shortageGain(allShifts, allPeople, hourlyReq, HOURS, tpl, personId) {
  const before = HOURS.reduce((sum, h) => sum + hourShortageAt(allShifts, allPeople, hourlyReq, h), 0);

  const person = allPeople.find(p => p.id === personId);
  const personScore = person?.score || 1;

  const after = HOURS.reduce((sum, h) => {
    const need = hourlyReq[h] || 0;
    const t = clockToMinutes(h);
    const covers = clockToMinutes(tpl.start) <= t && t < clockToMinutes(tpl.end);
    const s = calculateHourlyScore(allShifts, allPeople, h);
    const sWith = s + (covers ? personScore : 0);
    return sum + Math.max(0, need - sWith);
  }, 0);

  return before - after; // 大於 0 表示有效降低缺口
}

// 同人同日不可重疊（但允許早+晚兩段）
function canPlace(placedShifts, personId, tpl) {
  const s = clockToMinutes(tpl.start);
  const e = clockToMinutes(tpl.end);
  for (const sh of placedShifts) {
    if (sh.id !== personId) continue;
    const ss = clockToMinutes(sh.start);
    const ee = clockToMinutes(sh.end);
    // 只要時間重疊就不放（避免同人同時段被排兩個班）
    if (Math.max(s, ss) < Math.min(e, ee)) return false;
  }
  return true;
}

// 一天內是否已經被排過任一段（藥師或門市）
function hasShiftToday(day, personId) {
  return day.pharmacists.some(s => s.id === personId) || day.clerks.some(s => s.id === personId);
}


/* ========= 產生班表（需求驅動版，含鑰匙 / 覆蓋 / 主管 / 人力分數檢查） ========= */

// ========= 重新寫的「排班邏輯」：buildSchedule 只負責生成 days 與 shiftStats =========
// ========= 重新寫的「排班邏輯」（不以鑰匙/主管當作選人條件） =========
function buildSchedule({
  startDate,
  pharmacists,
  clerks,
  hourlyRequirements = {},
  pharmCoverageByWeek = {
    0: { enabled:true,  start:"09:00", end:"21:00" },
    1: { enabled:true,  start:"09:00", end:"21:00" },
    2: { enabled:true,  start:"09:00", end:"21:00" },
    3: { enabled:true,  start:"09:00", end:"21:00" },
    4: { enabled:true,  start:"09:00", end:"21:00" },
    5: { enabled:true,  start:"09:00", end:"21:00" },
    6: { enabled:true,  start:"09:00", end:"21:00" },
  },
  scheduleMode = 'multi',
}) {
  // ---- 小工具（僅本函式使用） ----
  const HOURS = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"];
  const toM = (hhmm) => clockToMinutes(hhmm);
  const coversHour = (tpl, hhmm) => toM(tpl.start) <= toM(hhmm) && toM(hhmm) < toM(tpl.end);

  // 一天只上一段：是否今天已有任何班（藥師或門市）
  function hasShiftToday(day, personId) {
    return day.pharmacists.some(s => s.id === personId) || day.clerks.some(s => s.id === personId);
  }

  // 以「最小時數優先」列出候選模板（不直接放 12h；12h 僅兜底）
  function templatesByRoleShortFirst(role) {
    const K = role === '門市' ? TEMPLATES.clerk : TEMPLATES.pharmacist;
    return role === '門市'
      ? [K.S6A, K.S6B, K.S8A, K.S8B, K.S10] // S12 留兜底
      : [K.P6A, K.P6B, K.P8A, K.P8B, K.P10A, K.P10B]; // P12 留兜底
  }
  function codeOfTemplate(role, tpl) {
    const dict = role === '門市' ? TEMPLATES.clerk : TEMPLATES.pharmacist;
    const hit = Object.entries(dict).find(([k,v]) => v===tpl);
    return hit ? hit[0] : '';
  }
  function coveringTemplatesFor(role, hour) {
    return templatesByRoleShortFirst(role).filter(t => coversHour(t, hour));
  }
  function canPlace(pool, personId, tpl) {
    const s = toM(tpl.start), e = toM(tpl.end);
    for (const sh of pool) {
      if (sh.id !== personId) continue;
      const ss = toM(sh.start), ee = toM(sh.end);
      if (Math.max(s, ss) < Math.min(e, ee)) return false; // 與本人已有班重疊
    }
    return true;
  }
  function hourShortageAt(allShifts, allPeople, hourlyReq, hour) {
    const need = hourlyReq[hour] || 0;
    const got = calculateHourlyScore(allShifts, allPeople, hour);
    return Math.max(0, need - got);
  }
  function totalShortage(allShifts, allPeople, hourlyReq) {
    return HOURS.reduce((s,h)=> s + hourShortageAt(allShifts, allPeople, hourlyReq, h), 0);
  }
  function shortageGain(allShifts, allPeople, hourlyReq, tpl, personId) {
    const person = allPeople.find(p => p.id === personId);
    const score = person?.score || 1;
    let gain = 0;
    for (const h of HOURS) {
      const need = hourlyReq[h] || 0;
      if (!coversHour(tpl, h)) continue;
      const cur = calculateHourlyScore(allShifts, allPeople, h);
      const beforeLack = Math.max(0, need - cur);
      const afterLack  = Math.max(0, need - (cur + score));
      gain += (beforeLack - afterLack);
    }
    return gain; // 越大越好
  }
  
  function hadEveningShiftYesterday(personId, resultDays, dayIdx) {
    if (dayIdx === 0) return false;
    const closeT = clockToMinutes("22:00");
    const y = resultDays[dayIdx - 1];
    return [...y.pharmacists, ...y.clerks].some(
      s => s.id === personId && clockToMinutes(s.end) === closeT
    );
  }

  // ---- 容器與公平計數 ----
  const days = Array.from({length:28}, (_,i)=> addDays(startDate, i));
  const result = days.map(date => ({ date, pharmacists: [], clerks: [], warnings: [], key:{open:null, close:null, notes:[]} }));

  const load = new Map();
  const shiftCounts = new Map(); // {morning, evening}
  const ensureCount = (id) => { if(!shiftCounts.has(id)) shiftCounts.set(id, { morning:0, evening:0 }); };
  const addLoad = (id, h) => load.set(id, (load.get(id)||0) + (h||0));
  const addCount = (id, shift) => { ensureCount(id); const t=getShiftType(shift); if(t==='morning') shiftCounts.get(id).morning++; else if(t==='evening') shiftCounts.get(id).evening++; };

  // 把「公/特/補/支」計入 load（不排班）
  for (const d of result) {
    const ds = fmt(d.date);
    for (const p of pharmacists) {
      const m = getMark(p, ds);
      if (['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(m.type)) addLoad(p.id, Number(m.hours||0));
    }
    for (const c of clerks) {
      const m = getMark(c, ds);
      if (['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(m.type)) addLoad(c.id, Number(m.hours||0));
    }
  }

  // ---- 逐日排法 ----
  for (let dayIdx=0; dayIdx<result.length; dayIdx++) {
    const day = result[dayIdx];
    const ds = fmt(day.date);
    const dow = day.date.getDay();
    const reqPh = pharmCoverageByWeek[dow];

    const pAvail = pharmacists.filter(p => getMark(p, ds).type === MARK.NONE);
    const cAvail = clerks.filter(c => getMark(c, ds).type === MARK.NONE);
    const allPeople = [...pharmacists, ...clerks];

    // A) 藥師覆蓋（最高原則）
    if (reqPh?.enabled) {
      const needS = reqPh.start, needE = reqPh.end;
      const coverOK = () => ensuresCoverage(day.pharmacists, needS, needE);

      // 唯一藥師可上班且未覆蓋 → 允許一次 P12（避免覆蓋失敗）
      if (!coverOK() && pAvail.length === 1 && !hasShiftToday(day, pAvail[0].id)) {
        const only = pAvail[0];
        const P12 = TEMPLATES.pharmacist.P12;
        if (canPlace(day.pharmacists, only.id, P12)) {
          day.pharmacists.push({ id: only.id, name: only.name, ...P12, code:'P12' });
          addLoad(only.id, P12.hours); addCount(only.id, P12);
        }
      }

      // 一般情況：6→8→10 疊滿覆蓋（不使用 P12）
      let guard = 0;
        while (!coverOK() && guard++ < 8) {
          let best = null;

          for (const p of pAvail) {
            if (hasShiftToday(day, p.id)) continue; // ✅ 一人一天只上一段

            for (const tpl of [
              TEMPLATES.pharmacist.P6A, TEMPLATES.pharmacist.P6B,
              TEMPLATES.pharmacist.P8A, TEMPLATES.pharmacist.P8B,
              TEMPLATES.pharmacist.P10A, TEMPLATES.pharmacist.P10B
            ]) {
              if (!canPlace(day.pharmacists, p.id, tpl)) continue;

              // pseudo 需求：覆蓋區每小時至少 1 分
              const pseudo = Object.fromEntries(
                HOURS.map(h => [h, (toM(needS) <= toM(h) && toM(h) < toM(needE)) ? 1 : 0])
              );

              const gain = shortageGain([...day.pharmacists], allPeople, pseudo, tpl, p.id);
              if (gain <= 0) continue;

              // ===== 新增：避免晚接早（昨晚 22:00 下班 → 排 09:00 早班會被懲罰）=====
              const hadEve = hadEveningShiftYesterday(p.id, result, dayIdx);
              const isMorningTpl = toM(tpl.start) === toM("09:00");
              const penalty = (hadEve && isMorningTpl) ? 1 : 0; // 0 最佳，1 次之

              // ===== 新增：早晚班平均分配（以現有統計做平衡）=====
              ensureCount(p.id);
              const cnt = shiftCounts.get(p.id); // { morning, evening }
              const tplType = getShiftType(tpl);
              // 若要排早班，偏好「目前晚班多於早班」的人（balance 越小越好）
              // 若要排晚班，偏好「目前早班多於晚班」的人
              const balance =
                tplType === 'morning' ? (cnt.morning - cnt.evening) :
                tplType === 'evening' ? (cnt.evening - cnt.morning) : 0;

              // 效益/時數
              const eff  = gain / (tpl.hours || 1);

              // 綜合排序權重（越好越先選）
              const rank = {
                penalty,            // 先比：避免晚接早（0 優於 1）
                balance,            // 再比：早/晚平衡（越小越好）
                eff,                // 再比：效益/時數
                gain,               // 再比：總效益
                hours: tpl.hours||0,// 再比：短班優先
                start: toM(tpl.start) // 最後：越早開始越好
              };

              const better = (a, b) => {
                if (!a) return true;
                if (b.hours   !== a.hours)   return b.hours   < a.hours;
                if (b.penalty !== a.penalty) return b.penalty < a.penalty;
                if (b.balance !== a.balance) return b.balance < a.balance;
                if (b.eff     !== a.eff)     return b.eff     > a.eff;
                if (b.gain    !== a.gain)    return b.gain    > a.gain;
                return b.start < a.start;
              };

              if (better(best?.rank, rank)) best = { person: p, tpl, rank };
            }
          }

          if (!best) break;

          const code = codeOfTemplate('藥師', best.tpl);
          day.pharmacists.push({ id: best.person.id, name: best.person.name, ...best.tpl, code });
          addLoad(best.person.id, best.tpl.hours);
          addCount(best.person.id, best.tpl); // 會更新 morning/evening 統計，用於平衡
        }
    }

    // A2) 門市覆蓋（最高原則）：09:00–22:00 期間至少一名門市在班（不以鑰匙/主管當作選人條件）
    {
      const needS = "09:00", needE = "22:00";
      const clerkCoverOK = () => ensuresCoverage(day.clerks, needS, needE);

      // 單一可上班門市 → 允許一次 S12 兜底（仍遵守「一天只上一段」）
      if (!clerkCoverOK() && cAvail.length === 1 && !hasShiftToday(day, cAvail[0].id)) {
        const only = cAvail[0];
        const S12 = TEMPLATES.clerk.S12;
        if (canPlace(day.clerks, only.id, S12)) {
          day.clerks.push({ id: only.id, name: only.name, ...S12, code: 'S12' });
          addLoad(only.id, S12.hours); addCount(only.id, S12);
        }
      }

      // 一般情況：用 6→8→10 疊滿覆蓋（不使用 S12）
      // 加入：早/晚平衡 + 「昨晚 22:00 → 隔天 09:00」的 penalty
      let guardCover = 0;
      while (!clerkCoverOK() && guardCover++ < 8) {
        let best = null;

        for (const c of cAvail) {
          if (hasShiftToday(day, c.id)) continue; // ✅ 一天只上一段

          for (const tpl of [
            TEMPLATES.clerk.S6A, TEMPLATES.clerk.S6B,
            TEMPLATES.clerk.S8A, TEMPLATES.clerk.S8B,
            TEMPLATES.clerk.S10
          ]) {
            if (!canPlace(day.clerks, c.id, tpl)) continue;

            // pseudo 需求：09–22 每小時至少 1 分（只看門市本身的覆蓋）
            const pseudo = Object.fromEntries(
              HOURS.map(h => [h, (toM(needS) <= toM(h) && toM(h) < toM(needE)) ? 1 : 0])
            );

            // 用門市自己的 blocks + 門市名單來算增益
            const gain = shortageGain([...day.clerks], clerks, pseudo, tpl, c.id);
            if (gain <= 0) continue;

            // ===== 新增：避免晚接早（昨晚 22:00 下班 → 排 09:00 早班會被懲罰）=====
            const hadEve = hadEveningShiftYesterday(c.id, result, dayIdx);
            const isMorningTpl = toM(tpl.start) === toM("09:00");
            const penalty = (hadEve && isMorningTpl) ? 1 : 0; // 0 最佳，1 次之

            // ===== 新增：早晚班平均分配（以現有統計做平衡）=====
            ensureCount(c.id);
            const cnt = shiftCounts.get(c.id); // { morning, evening }
            const tplType = getShiftType(tpl);
            // 若要排早班，偏好「目前晚班多於早班」的人（balance 越小越好）
            // 若要排晚班，偏好「目前早班多於晚班」的人
            const balance =
              tplType === 'morning' ? (cnt.morning - cnt.evening) :
              tplType === 'evening' ? (cnt.evening - cnt.morning) : 0;

            // 效益/時數
            const eff  = gain / (tpl.hours || 1);

            // 綜合排序權重（越好越先選）
            const rank = {
              penalty,              // 先比：避免晚接早（0 優於 1）
              balance,              // 再比：早/晚平衡（越小越好）
              eff,                  // 再比：效益/時數
              gain,                 // 再比：總效益
              hours: tpl.hours||0,  // 再比：短班優先
              start: toM(tpl.start) // 最後：越早開始越好
            };

            const better = (a, b) => {
              if (!a) return true;
              if (b.hours   !== a.hours)   return b.hours   < a.hours;
              if (b.penalty !== a.penalty) return b.penalty < a.penalty;
              if (b.balance !== a.balance) return b.balance < a.balance;
              if (b.eff     !== a.eff)     return b.eff     > a.eff;
              if (b.gain    !== a.gain)    return b.gain    > a.gain;
              return b.start < a.start;
            };

            if (better(best?.rank, rank)) best = { person: c, tpl, rank };
          }
        }

        if (!best) break;

        const code = codeOfTemplate('門市', best.tpl);
        day.clerks.push({ id: best.person.id, name: best.person.name, ...best.tpl, code });
        addLoad(best.person.id, best.tpl.hours);
        addCount(best.person.id, best.tpl); // 更新 morning/evening 統計，用於平衡
      }
    }

    // B) 以人力分數補齊（不因鑰匙/主管而偏好；且一天僅一段）
    {
      let guard = 0;
      while (totalShortage([...day.pharmacists, ...day.clerks], allPeople, hourlyRequirements) > 0 && guard++ < 24) {
        let best = null;

        // 門市候選
        for (const c of cAvail) {
          if (hasShiftToday(day, c.id)) continue; // ✅ 一天只上一段
          const pool = day.clerks;

          for (const tpl of templatesByRoleShortFirst('門市')) {
            if (!canPlace(pool, c.id, tpl)) continue;

            const gain = shortageGain([...day.pharmacists, ...day.clerks], allPeople, hourlyRequirements, tpl, c.id);
            if (gain <= 0) continue;

            // —— 新增：避免晚接早（昨晚 22:00 → 隔天 09:00 會被懲罰，而非硬性禁止）
            const hadEve = hadEveningShiftYesterday(c.id, result, dayIdx);
            const isMorningTpl = toM(tpl.start) === toM("09:00");
            const penalty = (hadEve && isMorningTpl) ? 1 : 0; // 0 最好，1 次之

            // —— 新增：早/晚班平均分配（balance 越小越好）
            ensureCount(c.id);
            const cnt = shiftCounts.get(c.id); // { morning, evening }
            const tplType = getShiftType(tpl);
            const balance =
              tplType === 'morning' ? (cnt.morning - cnt.evening) :
              tplType === 'evening' ? (cnt.evening - cnt.morning) : 0;

            const ticksCovered = HOURS.filter(h => toM(tpl.start) <= toM(h) && toM(h) < toM(tpl.end)).length || 1;
            const eff = gain / ticksCovered;
            const rank = {
              role: '門市',
              penalty,         // 先比：避免晚接早
              balance,         // 再比：早/晚平衡
              eff,             // 再比：效率
              gain,            // 再比：總效益
              hours: tpl.hours || 0, // 短班優先
              start: toM(tpl.start)  // 越早開始越優
            };

            const better = (a, b) => {
              if (!a) return true;
              if (b.hours   !== a.hours)   return b.hours   < a.hours;
              if (b.penalty !== a.penalty) return b.penalty < a.penalty;
              if (b.balance !== a.balance) return b.balance < a.balance;
              if (b.eff     !== a.eff)     return b.eff     > a.eff;
              if (b.gain    !== a.gain)    return b.gain    > a.gain;
              return b.start < a.start;
            };

            if (better(best?.rank, rank)) best = { person: c, role: '門市', tpl, rank };
          }
        }

        // 藥師候選
        for (const p of pAvail) {
          if (hasShiftToday(day, p.id)) continue; // ✅ 一天只上一段
          const pool = day.pharmacists;

          for (const tpl of templatesByRoleShortFirst('藥師')) {
            if (!canPlace(pool, p.id, tpl)) continue;

            const gain = shortageGain([...day.pharmacists, ...day.clerks], allPeople, hourlyRequirements, tpl, p.id);
            if (gain <= 0) continue;

            // —— 新增：避免晚接早（昨晚 22:00 → 隔天 09:00 會被懲罰，而非硬性禁止）
            const hadEve = hadEveningShiftYesterday(p.id, result, dayIdx);
            const isMorningTpl = toM(tpl.start) === toM("09:00");
            const penalty = (hadEve && isMorningTpl) ? 1 : 0; // 0 最好，1 次之

            // —— 新增：早/晚班平均分配
            ensureCount(p.id);
            const cnt = shiftCounts.get(p.id);
            const tplType = getShiftType(tpl);
            const balance =
              tplType === 'morning' ? (cnt.morning - cnt.evening) :
              tplType === 'evening' ? (cnt.evening - cnt.morning) : 0;

            const ticksCovered = HOURS.filter(h => toM(tpl.start) <= toM(h) && toM(h) < toM(tpl.end)).length || 1;
            const eff = gain / ticksCovered;
            const rank = {
              role: '藥師',
              penalty,
              balance,
              eff,
              gain,
              hours: tpl.hours || 0,
              start: toM(tpl.start)
            };

            const better = (a, b) => {
              if (!a) return true;
              if (b.hours   !== a.hours)   return b.hours   < a.hours;
              if (b.penalty !== a.penalty) return b.penalty < a.penalty;
              if (b.balance !== a.balance) return b.balance < a.balance;
              if (b.eff     !== a.eff)     return b.eff     > a.eff;
              if (b.gain    !== a.gain)    return b.gain    > a.gain;
              return b.start < a.start;
            };

            if (better(best?.rank, rank)) best = { person: p, role: '藥師', tpl, rank };
          }
        }

        if (!best) break;

        const code = codeOfTemplate(best.role, best.tpl);
        const s = { id: best.person.id, name: best.person.name, ...best.tpl, code };
        if (best.role === '門市') day.clerks.push(s); else day.pharmacists.push(s);
        addLoad(best.person.id, best.tpl.hours);
        addCount(best.person.id, best.tpl);
      }

      // 兜底：仍不足時，門市可放一名 12h（僅找「今天尚無班」者）
      if (totalShortage([...day.pharmacists, ...day.clerks], allPeople, hourlyRequirements) > 0) {
        const freeClerk = cAvail.find(c => !hasShiftToday(day, c.id));
        if (freeClerk && canPlace(day.clerks, freeClerk.id, TEMPLATES.clerk.S12)) {
          const s = { id: freeClerk.id, name: freeClerk.name, ...TEMPLATES.clerk.S12, code: 'S12' };
          day.clerks.push(s);
          addLoad(freeClerk.id, s.hours);
          addCount(freeClerk.id, s);
        }
      }
    }

    // C) 沒有畫休假的人 → 至少上一段（依缺口決定早/晚；一天只上一段）
    const segLack = (start,end) => {
      let sum=0;
      for (const h of HOURS) if (toM(start)<=toM(h) && toM(h)<toM(end)) {
        sum += hourShortageAt([...day.pharmacists, ...day.clerks], allPeople, hourlyRequirements, h);
      }
      return sum;
    };
    // 門市
    for (const c of cAvail) {
      if (hasShiftToday(day, c.id)) continue;
      const lackAM = segLack("09:00","15:30"), lackPM = segLack("15:30","22:00");
      let tpl = lackAM >= lackPM ? TEMPLATES.clerk.S6A : TEMPLATES.clerk.S6B;
      let alt = tpl === TEMPLATES.clerk.S6A ? TEMPLATES.clerk.S6B : TEMPLATES.clerk.S6A;

      // 門市也避免晚接早
      if (tpl === TEMPLATES.clerk.S6A && hadEveningShiftYesterday(c.id, result, dayIdx)) {
        [tpl, alt] = [alt, tpl];
      }

      if (canPlace(day.clerks, c.id, tpl)) {
        const s = { id:c.id, name:c.name, ...tpl, code: codeOfTemplate('門市', tpl) };
        day.clerks.push(s); addLoad(c.id, s.hours); addCount(c.id, s);
      } else if (canPlace(day.clerks, c.id, alt)) {
        const s = { id:c.id, name:c.name, ...alt, code: codeOfTemplate('門市', alt) };
        day.clerks.push(s); addLoad(c.id, s.hours); addCount(c.id, s);
      }
    }
    // 藥師
    for (const p of pAvail) {
      if (hasShiftToday(day, p.id)) continue;
      const lackAM = segLack("09:00","15:30"), lackPM = segLack("15:30","22:00");
      let tpl = lackAM >= lackPM ? TEMPLATES.pharmacist.P6A : TEMPLATES.pharmacist.P6B;
      let alt = tpl===TEMPLATES.pharmacist.P6A ? TEMPLATES.pharmacist.P6B : TEMPLATES.pharmacist.P6A;
      if (tpl===TEMPLATES.pharmacist.P6A && hadEveningShiftYesterday(p.id, result, dayIdx)) [tpl, alt] = [alt, tpl];
      if (canPlace(day.pharmacists, p.id, tpl)) {
        const s = { id:p.id, name:p.name, ...tpl, code: codeOfTemplate('藥師', tpl) };
        day.pharmacists.push(s); addLoad(p.id, s.hours); addCount(p.id, s);
      } else if (canPlace(day.pharmacists, p.id, alt)) {
        const s = { id:p.id, name:p.name, ...alt, code: codeOfTemplate('藥師', alt) };
        day.pharmacists.push(s); addLoad(p.id, s.hours); addCount(p.id, s);
      }
    }

    // D) 主管「只檢查不補位」：每整點必須有 manager，否則給警示（不因此加班）
    {
      const storeBlocks = [...day.clerks, ...day.pharmacists];
      for (const h of HOURS) {
        if (!hasManagerAtHour(storeBlocks, allPeople, h)) {
          day.warnings.push(`${h} 時段缺少當班主管（提醒：不因主管身分自動加班）.`);
          break;
        }
      }
    }

    // E) 鑰匙「只檢查不補位」：09:00 開門、22:00 關門（僅提醒轉移）
    {
      const storeBlocks = [...day.clerks, ...day.pharmacists];
      const openT = toM("09:00"), closeT = toM("22:00");
      const byId = new Map([...pharmacists, ...clerks].map(p=>[p.id,p]));
      const holdersOpen = storeBlocks.filter(s => byId.get(s.id)?.hasKey && toM(s.start) <= openT && openT < toM(s.end));
      const holdersClose= storeBlocks.filter(s => byId.get(s.id)?.hasKey && toM(s.end) >= closeT);

      if (!holdersOpen.length) {
        const earliest = [...storeBlocks].sort((a,b)=>toM(a.start)-toM(b.start))[0];
        day.key.open = { ok:false, suggest: earliest?.id || null };
        day.key.notes.push("09:00 無持鑰匙者在班：請於前一日或當日最早上班者間轉移鑰匙。");
      } else {
        day.key.open = { ok:true, holder: holdersOpen[0].id };
      }

      if (!holdersClose.length) {
        const latest = [...storeBlocks].sort((a,b)=>toM(b.end)-toM(a.end))[0];
        day.key.close = { ok:false, suggest: latest?.id || null };
        day.key.notes.push("22:00 無持鑰匙者在班：請於當日最晚下班者間轉移鑰匙。");
      } else {
        day.key.close = { ok:true, holder: holdersClose[0].id };
      }

      if (day.key.notes.length) day.warnings.push("🔑 鑰匙提醒：" + day.key.notes.join("；"));
    }

    // F) 覆蓋/人力分數的最終檢查（保留原有提示）
    const req = pharmCoverageByWeek[dow];
    if (req?.enabled && !ensuresCoverage(day.pharmacists, req.start, req.end)) {
      day.warnings.push(`藥師覆蓋不足：週${["日","一","二","三","四","五","六"][dow]} ${req.start}-${req.end} 覆蓋未完整。`);
    }
    const storeBlocks = [...day.clerks, ...day.pharmacists];
    if (!ensuresCoverage(storeBlocks, "09:00", "22:00")) {
      day.warnings.push("門市人力不足：09:00–22:00 覆蓋未完整。");
    }
    for (const h of HOURS) {
      const need = hourlyRequirements[h];
      if (!need) continue;
      const actual = calculateHourlyScore(storeBlocks, allPeople, h);
      if (actual < need) day.warnings.push(`${h} 人力分數不足：需要${need}分，實際${actual}分。`);
    }
  }

  // 統計（沿用）
  const allPeople = [
    ...pharmacists.map(p => ({ ...p, role: '藥師' })),
    ...clerks.map(p => ({ ...p, role: '門市' })),
  ];
  const shiftStats = calculateShiftStats({ days: result }, allPeople);

  return { days: result, shiftStats };
}



/* ========= 覆寫與即時重算（維持原本） ========= */

function deepCopyDays(days) {
  return days.map(d => ({
    date: new Date(d.date),
    pharmacists: d.pharmacists.map(x => ({...x})),
    clerks: d.clerks.map(x => ({...x})),
    warnings: [...d.warnings],
    key: d.key ? JSON.parse(JSON.stringify(d.key)) : { open:null, close:null, notes:[] }
  }));
}

// overrides: { [dateStr]: { [personId]: { kind:'SHIFT'|'MARK'|'NONE', role:'藥師'|'門市', code?, markType?, hours? } } }
function applyOverrides(baseDays, overrides, pharmacists, clerks, hourlyRequirements, pharmCoverageByWeek) {
  const days = deepCopyDays(baseDays);

  for (const day of days) {
    const ds = fmt(day.date);
    const ov = overrides[ds];
    if (!ov) continue;

    for (const [pid, rule] of Object.entries(ov)) {
      day.pharmacists = day.pharmacists.filter(s => s.id !== pid);
      day.clerks      = day.clerks.filter(s => s.id !== pid);

      if (rule.kind === 'SHIFT') {
        const role = rule.role;
        const tpl = (role === '藥師' ? TEMPLATES.pharmacist : TEMPLATES.clerk)[rule.code];
        if (tpl) {
          const name = (role === '藥師' ? pharmacists : clerks).find(p=>p.id===pid)?.name || pid;
          const shift = { id: pid, name, ...tpl, code: rule.code };
          if (role === '藥師') day.pharmacists.push(shift);
          else day.clerks.push(shift);
        }
      }
    }
  }

  // 重新計警示（含主管、人力分數、覆蓋）
  const allPeople = [
    ...pharmacists.map(p => ({ ...p, role: '藥師' })),
    ...clerks.map(p => ({ ...p, role: '門市' }))
  ];
  const HOURS = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"];

  for (const day of days) {
    day.warnings = [];
    day.key = { open:null, close:null, notes:[] };

    const dow = day.date.getDay();
    const req = pharmCoverageByWeek?.[dow];
    if (req?.enabled) {
      if (!ensuresCoverage(day.pharmacists, req.start, req.end)) {
        day.warnings.push(`藥師覆蓋不足：週${["日","一","二","三","四","五","六"][dow]} ${req.start}-${req.end} 覆蓋未完整。`);
      }
    }

    // 門市覆蓋：合併藥師 + 門市
    const storeBlocks = [...day.clerks, ...day.pharmacists];
    if (!ensuresCoverage(storeBlocks, "09:00", "22:00")) {
      day.warnings.push("門市人力不足，09:00-22:00 覆蓋未完整。");
    }

    const allShifts = storeBlocks;
    for (const h of HOURS) {
      if (!hasManagerAtHour(allShifts, allPeople, h)) {
        day.warnings.push(`${h} 時段缺少當班主管。`);
        break;
      }
    }
    for (const h of HOURS) {
      const need = hourlyRequirements[h];
      if (need) {
        const actual = calculateHourlyScore(allShifts, allPeople, h);
        if (actual < need) day.warnings.push(`${h} 時段人力分數不足：需要${need}分，實際${actual}分。`);
      }
    }

    // 鑰匙檢查
    const openT = clockToMinutes("09:00");
    const closeT = clockToMinutes("22:00");
    const coversAt = (s,t)=> clockToMinutes(s.start) <= t && t <= clockToMinutes(s.end);
    const map = new Map([...pharmacists,...clerks].map(p=>[p.id,p]));
    const holdersOpen = allShifts.filter(s => map.get(s.id)?.hasKey && coversAt(s, openT));
    const holdersClose= allShifts.filter(s => map.get(s.id)?.hasKey && clockToMinutes(s.end) >= closeT);

    if (holdersOpen.length === 0) {
      const candidate = [...allShifts].sort((a,b)=>clockToMinutes(a.start)-clockToMinutes(b.start))[0];
      if (candidate) { day.key.open={ok:false,suggest:candidate.id}; day.key.notes.push("9:00 無鑰匙，建議轉移鑰匙給該日最早上班者。"); }
      else { day.key.open={ok:false,suggest:null}; day.key.notes.push("9:00 無人上班，無法轉移鑰匙。"); }
    } else { day.key.open={ok:true, holder: holdersOpen[0].id}; }

    if (holdersClose.length === 0) {
      const candidate = [...allShifts].sort((a,b)=>clockToMinutes(b.end)-clockToMinutes(a.end))[0];
      if (candidate) { day.key.close={ok:false,suggest:candidate.id}; day.key.notes.push("22:00 無鑰匙，建議轉移鑰匙給該日最晚下班者。"); }
      else { day.key.close={ok:false,suggest:null}; day.key.notes.push("22:00 無人上班，無法轉移鑰匙。"); }
    } else { day.key.close={ok:true, holder: holdersClose[0].id}; }

    if (day.key.notes.length) day.warnings.push("🔑 鑰匙提醒：" + day.key.notes.join("；"));
  }

  const shiftStats = calculateShiftStats({ days }, allPeople);
  return { days, shiftStats };
}

function nextCycle(current, role) {
  const seq = SHIFT_CYCLE[role === '藥師' ? 'pharmacist' : 'clerk'];
  // 目前狀態可來自：覆寫中的 SHIFT/ MARK，或空
  const cur =
    current?.code ||
    current?.markType ||
    (current?.kind === 'NONE' ? 'NONE' : 'NONE');

  const idx = Math.max(0, seq.indexOf(cur));
  const nxt = seq[(idx + 1) % seq.length];

  // 休假/支援類型
  if (["NONE","OFF","PUBLIC","ANNUAL","COMP","SUPPORT"].includes(nxt)) {
    return nxt === "NONE"
      ? { kind: 'NONE' }
      : { kind: 'MARK', markType: nxt, hours: MARK_DEFAULT_HOURS[nxt] ?? undefined };
  }
  // 其餘為班別代碼（如 P6A / S8B ...）
  return { kind: 'SHIFT', code: nxt };
}

/* ========= 休假/支援/鑰匙 設定表格（原本） ========= */

function PeopleEditorCombined({ pharmacists, setPharmacists, clerks, setClerks, days }) {
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

  const rename = (person, name) => apply(person.group, (arr) => { arr[person.idx] = { ...arr[person.idx], name }; return arr; });
  const updateStaffType = (person, staffType) => apply(person.group, (arr) => { arr[person.idx] = { ...arr[person.idx], staffType }; return arr; });
  const updateScore = (person, score) => apply(person.group, (arr) => { arr[person.idx] = { ...arr[person.idx], score }; return arr; });
  const updateHasKey = (person, hasKey) => apply(person.group, (arr) => { arr[person.idx] = { ...arr[person.idx], hasKey }; return arr; });

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
          <div>（公/特/補/支可填時數；🔑 可勾選持鑰匙）</div>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: COLW.editorDateCol }} />
            {people.map(p => (<col key={p.id + '-col'} style={{ width: COLW.editorPersonCol }} />))}
          </colgroup>

          <thead>
            <tr>
              <th className="sticky left-0 bg-white border-b p-2 text-sm">日期</th>
              {people.map((p) => (
                <th key={p.id} className="border-b p-2 text-sm text-left">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[11px] text-gray-500">{p.role}</div>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={!!p.hasKey}
                        onChange={(e)=>updateHasKey(p, e.target.checked)}
                      />
                      <span>🔑持鑰匙</span>
                    </label>
                  </div>
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
                <td className="sticky left-0 bg-white border-b p-2 text-sm align-top">
                  <div className="font-medium">{d.getMonth()+1}/{d.getDate()}</div>
                  <div className="text-[11px] text-gray-500">週{["日","一","二","三","四","五","六"][d.getDay()]}</div>
                </td>

                {people.map((p) => {
                  const dateStr = fmt(d);
                  const m = getMark(p, dateStr);
                  const b = badge(m.type);
                  return (
                    <td key={p.id+dateStr} className="border-b p-2 align-top">
                      <button
                        className={`w-full text-left border rounded px-2 py-1 ${b.cls}`}
                        onClick={() => cycle(p, dateStr)}
                        title={`${b.txt}${m.hours?` ${m.hours}h`:''}`}
                      >
                        {b.txt}{m.hours?` ${m.hours}h`:''}
                      </button>

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

/* ========= 班表矩陣（可編輯＋交換＋PDF 匯出） ========= */

function ScheduleMatrix({ baseSchedule, pharmacists, clerks, hourlyRequirements, expectedHours, pharmCoverageByWeek }) {
  const [overrides, setOverrides] = useState({});
  const [swapMode, setSwapMode] = useState(false);
  const [selectedCell, setSelectedCell] = useState(null); // {dateStr, role, personId}
  const [activeCell, setActiveCell] = useState(null);     // {dateStr, role, personId}
  const containerRef = useRef(null);

  const { days:rawDays, shiftStats } = useMemo(
    () => applyOverrides(baseSchedule.days, overrides, pharmacists, clerks, hourlyRequirements, pharmCoverageByWeek),
    [baseSchedule, overrides, pharmacists, clerks, hourlyRequirements, pharmCoverageByWeek]
  );

  // 依逐日覆蓋設定再補強藥師覆蓋警示（避免重複）
  const computedDays = useMemo(() => {
    return rawDays.map(d => {
      const dow = d.date.getDay();
      const req = pharmCoverageByWeek?.[dow];
      const filtered = (d.warnings || []).filter(w => !/藥師覆蓋不足/.test(w));
      if (req?.enabled) {
        if (!ensuresCoverage(d.pharmacists, req.start, req.end)) {
          filtered.push(`藥師覆蓋不足：週${["日","一","二","三","四","五","六"][dow]} ${req.start}-${req.end} 覆蓋未完整。`);
        }
      }
      return { ...d, warnings: filtered };
    });
  }, [rawDays, pharmCoverageByWeek]);

  const displaySchedule = { days: computedDays, shiftStats };

  const classifyWarning = (w) => /藥師/.test(w) ? 'pharm' : 'manpower';

  // PDF 匯出：固定 A4 landscape
  const [isExporting, setIsExporting] = useState(false);
  const dlPdf = async () => {
    try {
      setIsExporting(true);
      const node = containerRef.current;
      if (!node) throw new Error("PDF 容器不存在");

      const canvas = await html2canvas(node, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        windowWidth: node.scrollWidth,
        windowHeight: node.scrollHeight
      });
      const imgData = canvas.toDataURL("image/png");

      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const usableW = pageW - margin*2;

      const imgW = usableW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let y = margin;

      pdf.addImage(imgData, "PNG", margin, y, imgW, imgH);

      let heightLeft = imgH - (pageH - margin*2);
      while (heightLeft > 0) {
        pdf.addPage();
        y = margin - (imgH - heightLeft);
        pdf.addImage(imgData, "PNG", margin, y, imgW, imgH);
        heightLeft -= (pageH - margin*2);
      }

      const from = fmt(computedDays[0].date);
      const to   = fmt(computedDays[computedDays.length-1].date);
      pdf.save(`schedule_${from}_to_${to}.pdf`);
    } catch (err) {
      alert("匯出 PDF 失敗： " + (err?.message || String(err)));
      console.error(err);
    } finally {
      setIsExporting(false);
    }
  };

  const people = [
    ...pharmacists.map((p) => ({ ...p, role: '藥師' })),
    ...clerks.map((p) => ({ ...p, role: '門市' })),
  ];

  // 計算每日工時（含 override 的 MARK）
  function getDayWork(person, d, ds) {
    const entries = (person.role === '藥師' ? d.pharmacists : d.clerks).filter(x => x.id === person.id);
    let h = entries.reduce((acc, e) => acc + (e.hours || 0), 0);

    const ov = overrides[ds]?.[person.id];
    if (ov?.kind === 'MARK') h += Number(ov.hours || 0);
    else {
      const baseM = getMark(person, ds);
      if (['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(baseM.type)) h += Number(baseM.hours || 0);
    }

    const ot = Math.max(0, round1(h - 10));
    const base = Math.min(h, 10);
    return { base: round1(base), ot };
  }

  const isEditableMark = (markType) => ['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(markType);

  const onCycleCell = (person, role, ds) => {
    setActiveCell({ dateStr: ds, role, personId: person.id });
    setOverrides(prev => {
      const cur = prev[ds]?.[person.id];
      let curState = cur;
      if (!curState) {
        const day = computedDays.find(x => fmt(x.date) === ds);
        const pool = role === '藥師' ? day.pharmacists : day.clerks;
        const found = pool.find(s => s.id === person.id);
        if (found) curState = { kind:'SHIFT', code: (role==='藥師'?'P':'S') };
        else {
          const baseM = getMark(person, ds);
          curState = baseM.type !== 'NONE' ? { kind:'MARK', markType: baseM.type, hours: baseM.hours } : { kind:'NONE' };
        }
      }
      const nxt = nextCycle(curState, role);
      const newDay = { ...(prev[ds] || {}) };

      if (nxt.kind === 'NONE') {
        delete newDay[person.id];
        if (Object.keys(newDay).length === 0) { const cp = { ...prev }; delete cp[ds]; return cp; }
        return { ...prev, [ds]: newDay };
      }
      if (nxt.kind === 'SHIFT') newDay[person.id] = { kind:'SHIFT', role, code: nxt.code };
      if (nxt.kind === 'MARK')  newDay[person.id] = { kind:'MARK', role, markType: nxt.markType, hours: nxt.hours };

      return { ...prev, [ds]: newDay };
    });
  };

  const onClickCell = (person, role, ds) => {
    setActiveCell({ dateStr: ds, role, personId: person.id });
    if (!swapMode) { onCycleCell(person, role, ds); return; }
    const current = { dateStr: ds, role, personId: person.id };
    if (!selectedCell) { setSelectedCell(current); return; }

    if (selectedCell.dateStr !== ds || selectedCell.role !== role) { setSelectedCell(current); return; }
    if (selectedCell.personId === person.id) { setSelectedCell(null); return; }

    const day = computedDays.find(x => fmt(x.date) === ds);
    const pool = role === '藥師' ? day.pharmacists : day.clerks;
    const a = pool.find(s => s.id === selectedCell.personId);
    const b = pool.find(s => s.id === person.id);
    if (!a || !b) { setSelectedCell(null); return; }

    setOverrides(prev => {
      const dOv = { ...(prev[ds] || {}) };
      const findCode = (id) => {
        const shift = pool.find(s => s.id === id);
        if (!shift) return null;
        const templates = role==='藥師' ? TEMPLATES.pharmacist : TEMPLATES.clerk;
        const code = Object.entries(templates).find(([k,v]) => v.start===shift.start && v.end===shift.end && v.hours===shift.hours)?.[0];
        return code || (role==='藥師'?'P8A':'S8A');
      };
      const codeA = findCode(selectedCell.personId);
      const codeB = findCode(person.id);
      dOv[selectedCell.personId] = { kind:'SHIFT', role, code: codeB };
      dOv[person.id]            = { kind:'SHIFT', role, code: codeA };
      return { ...prev, [ds]: dOv };
    });
    setSelectedCell(null);
  };

  const onEditMarkHours = (ds, person, role, markType, nextHours) => {
    const h = nextHours === '' ? '' : Number(nextHours);
    setOverrides(prev => {
      const dayOv = { ...(prev[ds] || {}) };
      dayOv[person.id] = { kind:'MARK', role, markType, hours: h === '' ? undefined : h };
      return { ...prev, [ds]: dayOv };
    });
  };

  const totalCols = 1 + people.length * 3;

  const renderMatrix = () => (
    <div className="mb-6">
      <div className="overflow-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            <col style={{ width: COLW.schedDateCol }} />
            {people.map(p => (
              <React.Fragment key={p.id + "-cols"}>
                <col style={{ width: COLW.schedShiftCol }} />
                <col style={{ width: COLW.schedHoursCol }} />
                <col style={{ width: COLW.schedOTCol }} />
              </React.Fragment>
            ))}
          </colgroup>

          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 bg-white border-b p-2 align-bottom">日期</th>
              {people.map((p)=> (
                <th key={p.id} colSpan={3} className="border-b p-2 text-left">
                  <div className="flex items-center gap-2">
                    <div className="text-[11px] text-gray-500">{p.role}</div>
                    <div className="inline-flex items-center gap-1 text-xs">
                      {p.hasKey && <span title="持鑰匙">🔑</span>}
                      {p.staffType === 'manager' && <span className="px-1 border rounded">主管</span>}
                      <span className="px-1 border rounded">{p.score || 1}分</span>
                    </div>
                  </div>
                  {p.name}
                </th>
              ))}
            </tr>
            <tr>
              {people.map((p)=> (
                <React.Fragment key={p.id+"-sub"}>
                  <th className="border-b p-2 text-left">班別</th>
                  <th className="border-b p-2 text-right">上</th>
                  <th className="border-b p-2 text-right">加</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>

          <tbody>
            {displaySchedule.days.map((d) => {
              const ds = fmt(d.date);
              const mergedP = mergeConsecutiveShiftsWithHours(d.pharmacists);
              const mergedC = mergeConsecutiveShiftsWithHours(d.clerks);

              return (
                <React.Fragment key={ds}>
                  {/* 主資料列 */}
                  <tr>
                    <td className="sticky left-0 bg-white border-b p-2 align-top">
                      <div className="font-medium">{d.date.getMonth()+1}/{d.date.getDate()}</div>
                      <div className="text-[11px] text-gray-500">週{["日","一","二","三","四","五","六"][d.date.getDay()]}</div>
                    </td>

                    {people.map((p) => {
                      const pool = (p.role==='藥師'?mergedP:mergedC).filter(x => x.id === p.id);
                      const ov = overrides[ds]?.[p.id];

                      let contentLabel = '';
                      let markUI = null;
                      if (ov?.kind === 'MARK') {
                        const m = ov.markType;
                        const label = m==='OFF'?'休':m==='PUBLIC'?'公':m==='ANNUAL'?'特':m==='COMP'?'補':'支';
                        contentLabel = label;
                        if (['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(m)) {
                          markUI = (
                            <div className="mt-0.5 flex items-center gap-1">
                              <span className="text-[11px] text-gray-500">時數</span>
                              <input
                                type="number" min={0} step={0.5}
                                className="w-16 border rounded px-1 py-0.5 text-[12px]"
                                value={ov.hours ?? ''}
                                onClick={(e)=>e.stopPropagation()}
                                onChange={(e)=>onEditMarkHours(ds, p, p.role, m, e.target.value)}
                              />
                              <span className="text-[11px] text-gray-500">h</span>
                            </div>
                          );
                        }
                      } else if (pool.length > 0) {
                        contentLabel = pool.map(e => formatEntryForDisplay(e).text).join(' / ');
                      } else {
                        const baseM = getMark(p, ds);
                        if (baseM.type !== MARK.NONE) {
                          const label = baseM.type==='OFF'?'休':baseM.type==='PUBLIC'?'公':baseM.type==='ANNUAL'?'特':baseM.type==='COMP'?'補':'支';
                          contentLabel = `${label}${baseM.hours ? ` ${fmtH(baseM.hours)}h` : ''}`;
                          if (['PUBLIC','ANNUAL','COMP','SUPPORT'].includes(baseM.type)) {
                            markUI = (
                              <div className="mt-0.5 flex items-center gap-1">
                                <span className="text-[11px] text-gray-500">時數</span>
                                <input
                                  type="number" min={0} step={0.5}
                                  className="w-16 border rounded px-1 py-0.5 text-[12px]"
                                  value={overrides[ds]?.[p.id]?.hours ?? baseM.hours ?? ''}
                                  onClick={(e)=>e.stopPropagation()}
                                  onChange={(e)=>onEditMarkHours(ds, p, p.role, baseM.type, e.target.value)}
                                />
                                <span className="text-[11px] text-gray-500">h</span>
                              </div>
                            );
                          }
                        } else {
                          contentLabel = '';
                        }
                      }

                      const isSelected = swapMode && selectedCell && selectedCell.dateStr===ds && selectedCell.role===p.role && selectedCell.personId===p.id;
                      const isActive   = activeCell && activeCell.dateStr===ds && activeCell.role===p.role && activeCell.personId===p.id;

                      const { base, ot } = getDayWork(p, d, ds);

                      return (
                        <React.Fragment key={p.id+ds}>
                          <td
                            className={`border-b p-2 align-top tabular-nums cursor-pointer ${isSelected?'ring-2 ring-indigo-500 rounded':''} ${isActive?'':''
                              }`}
                            onClick={() => onClickCell(p, p.role, ds)}
                            title={swapMode ? '交換模式：點兩格互換（同日同角色）' : '點一下循環班別/休假；公/特/補/支 可直接改時數'}
                          >
                            <div className="flex flex-col gap-0.5">
                              <div>{contentLabel || <span className="text-gray-400">—</span>}</div>
                              {markUI}
                            </div>
                          </td>
                          <td className="border-b p-2 align-top text-right tabular-nums">{base ? fmtH(base) : ''}</td>
                          <td className="border-b p-2 align-top text-right tabular-nums">{ot ? fmtH(ot) : ''}</td>
                        </React.Fragment>
                      );
                    })}
                  </tr>

                  {/* 警示列（每警示一行 & 分色） */}
                  {d.warnings?.length > 0 && (
                    <tr>
                      <td colSpan={totalCols} className="border-b px-2 py-2">
                        <div className="text-[12px] font-medium text-gray-600 mb-1">⚠️ 當日警示</div>
                        <ul className="space-y-1">
                          {d.warnings.map((w, i) => {
                            const kind = classifyWarning(w);
                            const cls =
                              kind === 'pharm'
                                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                                : 'bg-amber-50 border-amber-300 text-amber-800';
                            return (
                              <li
                                key={i}
                                className={`text-[12px] leading-snug whitespace-normal break-words px-2 py-1 rounded border ${cls}`}
                              >
                                {w}
                              </li>
                            );
                          })}
                        </ul>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}

            {/* 工時總計行 */}
            <tr>
              <td className="sticky left-0 bg-white border-t p-2 text-sm font-medium">工時合計</td>
              {people.map((p) => {
                const totals = displaySchedule.days.reduce((acc, d) => {
                  const ds = fmt(d.date);
                  const { base, ot } = getDayWork(p, d, ds);
                  acc.base += base || 0;
                  acc.ot += ot || 0;
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
                const stat = (displaySchedule.shiftStats || []).find(s => s.id === p.id);
                const info = stat ? `早${stat.morning}晚${stat.evening}全${stat.full}` : '早0晚0全0';
                return (
                  <React.Fragment key={p.id+"-shifts"}>
                    <td className="border-t p-2 text-left tabular-nums text-xs">{info}</td>
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

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold">產生的班表（可直接編輯/交換）</h3>
          <label className="inline-flex items-center gap-1 text-sm select-none">
            <input
              type="checkbox"
              checked={swapMode}
              onChange={(e)=>{ setSwapMode(e.target.checked); setSelectedCell(null); }}
            />
            交換模式
          </label>
        </div>
        <button
          onClick={dlPdf}
          disabled={isExporting}
          className={`px-3 py-1.5 rounded-lg border shadow-sm text-sm ${isExporting ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          {isExporting ? '匯出中…' : '匯出 PDF (A4)'}
        </button>
      </div>

      <div ref={containerRef}>{renderMatrix()}</div>
    </div>
  );
}

/* ========= App 入口 ========= */

export default function SchedulerApp() {
  const [scheduleMode, setScheduleMode] = useState('multi'); // 'single' | 'multi'
  const DOW = ["日","一","二","三","四","五","六"];

  // 預設：多藥（週一～週日 09:00–21:00）
  const [pharmCoverageByWeek, setPharmCoverageByWeek] = useState({
    0: { enabled: true , start: "09:00", end: "21:00" },
    1: { enabled: true , start: "09:00", end: "21:00" },
    2: { enabled: true , start: "09:00", end: "21:00" },
    3: { enabled: true , start: "09:00", end: "21:00" },
    4: { enabled: true , start: "09:00", end: "21:00" },
    5: { enabled: true , start: "09:00", end: "21:00" },
    6: { enabled: true , start: "09:00", end: "21:00" },
  });

  // 模式切換時自動套用覆蓋規則（保留原行為）
  useEffect(() => {
    if (scheduleMode === 'multi') {
      setPharmCoverageByWeek({
        0: { enabled: true , start: "09:00", end: "21:00" },
        1: { enabled: true , start: "09:00", end: "21:00" },
        2: { enabled: true , start: "09:00", end: "21:00" },
        3: { enabled: true , start: "09:00", end: "21:00" },
        4: { enabled: true , start: "09:00", end: "21:00" },
        5: { enabled: true , start: "09:00", end: "21:00" },
        6: { enabled: true , start: "09:00", end: "21:00" },
      });
    } else {
      setPharmCoverageByWeek({
        0: { enabled: false, start: "09:00", end: "17:30" },
        1: { enabled: true , start: "09:00", end: "17:30" },
        2: { enabled: true , start: "09:00", end: "17:30" },
        3: { enabled: true , start: "09:00", end: "17:30" },
        4: { enabled: true , start: "09:00", end: "17:30" },
        5: { enabled: true , start: "09:00", end: "17:30" },
        6: { enabled: false, start: "09:00", end: "17:30" },
      });
    }
  }, [scheduleMode]);

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
  const [cCount, setCCount] = useState(2);

  const [expectedHours, setExpectedHours] = useState(160);

  const [hourlyRequirements, setHourlyRequirements] = useState({
    "09:00": 2, "10:00": 2, "11:00": 2, "12:00": 3, "13:00": 3, "14:00": 3,
    "15:00": 3, "16:00": 3, "17:00": 3, "18:00": 3, "19:00": 3, "20:00": 3, "21:00": 2
  });

  const [pharmacists, setPharmacists] = useState(() => defaultNames(pCount, "藥師"));
  const [clerks, setClerks] = useState(() => defaultNames(cCount, "門市"));

  const resize = (arr, n, prefix) => {
    const cur = [...arr];
    if (n > cur.length) {
      for (let i = cur.length; i < n; i++) cur.push({ id: `${prefix}-${i+1}`, name: `${prefix}${i+1}`, marks: {}, staffType:'general', score:1, hasKey:false });
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
    const data = buildSchedule({
      startDate,
      pharmacists,
      clerks,
      hourlyRequirements,
      pharmCoverageByWeek,
      scheduleMode,
    });
    setSchedule(data);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">排班助手 · 28 天</h1>

            <div className="flex items-center gap-3">
              <div className="text-sm">
                <label className="inline-flex items-center gap-2">
                  <span className="text-gray-600">模式</span>
                  <select
                    className="border rounded-md px-2 py-1"
                    value={scheduleMode}
                    onChange={(e)=>setScheduleMode(e.target.value)}
                  >
                    <option value="multi">多藥</option>
                    <option value="single">一藥</option>
                  </select>
                </label>
              </div>
            </div>
          </div>

          {/* 藥師覆蓋（逐日） */}
          <div className="border rounded-xl p-3 bg-white shadow-sm">
            <div className="text-sm font-medium mb-2">藥師覆蓋（逐日設定）</div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {Object.entries(pharmCoverageByWeek).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2">
                  <label className="w-8 text-sm">週{DOW[k]}</label>
                  <label className="inline-flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      checked={v.enabled}
                      onChange={(e)=>setPharmCoverageByWeek(prev => ({ ...prev, [k]: { ...prev[k], enabled: e.target.checked } }))}
                    />
                    覆蓋
                  </label>
                  <input
                    type="time" step="1800"
                    className="border rounded px-2 py-1 text-sm"
                    value={v.start}
                    onChange={(e)=>setPharmCoverageByWeek(prev => ({ ...prev, [k]: { ...prev[k], start: e.target.value } }))}
                    disabled={!v.enabled}
                  />
                  <span>–</span>
                  <input
                    type="time" step="1800"
                    className="border rounded px-2 py-1 text-sm"
                    value={v.end}
                    onChange={(e)=>setPharmCoverageByWeek(prev => ({ ...prev, [k]: { ...prev[k], end: e.target.value } }))}
                    disabled={!v.enabled}
                  />
                </div>
              ))}
            </div>
          </div>
        </header>

        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-sm text-gray-600">by huai</h1>
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
                      setPharmacists(prev => {
                        const cur = [...prev];
                        if (n > cur.length) {
                          for (let i = cur.length; i < n; i++) cur.push({ id: `藥師-${i+1}`, name: `藥師${i+1}`, marks: {}, staffType:'general', score:1, hasKey:false });
                        } else {
                          cur.length = n;
                        }
                        return cur;
                      });
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
                      setClerks(prev => {
                        const cur = [...prev];
                        if (n > cur.length) {
                          for (let i = cur.length; i < n; i++) cur.push({ id: `門市-${i+1}`, name: `門市${i+1}`, marks: {}, staffType:'general', score:1, hasKey:false });
                        } else {
                          cur.length = n;
                        }
                        return cur;
                      });
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
                        onChange={(e) => setHourlyRequirements(prev => ({ ...prev, [hour]: Number(e.target.value || 1) }))}
                      />
                      <span>分</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-xs text-gray-500 mt-4">
                生成邏輯：
                <ul className="list-disc ml-5 mt-1 space-y-1">
                  <li>凡未標休/公/特/補/支 → 視為可上班。</li>
                  <li>允許同一時間同一組別多人同時上班。</li>
                  <li>先補「藥師覆蓋」時段，再以「門市+藥師」共同把各小時人力分數補到需求。</li>
                  <li>持續檢查每時段須有主管、各時段人力分數達標。</li>
                  <li>🔑 鑰匙：09:00/22:00 必須有人持鑰匙在班，否則提示轉移建議。</li>
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
            baseSchedule={schedule}
            pharmacists={pharmacists}
            clerks={clerks}
            expectedHours={expectedHours}
            hourlyRequirements={hourlyRequirements}
            pharmCoverageByWeek={pharmCoverageByWeek}
          />
        )}
      </div>
    </div>
  );
}
