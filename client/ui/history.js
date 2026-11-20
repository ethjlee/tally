import { addDaysToKey, calendarDaysInclusive, laterDateKey } from "../ledger/calendar.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { pauseIntervals, pauseOn, statsStartKey, todayKey } from "../ledger/days.js";
import { summarizeLedger } from "../ledger/scoring.js";
import { averageScoreWindow } from "../ledger/statistics.js";
import { ledgerState, viewState } from "../state.js";
import { persistSettings } from "../storage/persistence.js";
import { openDayActivity } from "./day.js";

function renderRangeButtons(){
  const wrap = document.getElementById('rangeSelect');
  const opts = [7, 14, 30, 90, 'all'];
  wrap.innerHTML = opts.map(value =>
    `<button type="button" class="${value === ledgerState.historyRangeDays ? 'active' : ''}" data-action="set-range" data-days="${value}">${value === 'all' ? 'ALL' : `${value}D`}</button>`
  ).join('');
}

function renderDateJump(){
  const input = document.getElementById('historyDateInput');
  if(!input) return;
  input.min = statsStartKey();
  input.max = todayKey();
  if(!isValidDateKey(input.value) || input.value < input.min || input.value > input.max){
    input.value = todayKey();
  }
}
export function jumpToExactDate(){
  const input = document.getElementById('historyDateInput');
  const status = document.getElementById('dateJumpStatus');
  const date = input.value;
  status.textContent = '';
  if(!isValidDateKey(date) || date < statsStartKey() || date > todayKey()){
    status.textContent = `Choose a date from ${statsStartKey()} through ${todayKey()}.`;
    input.focus();
    return;
  }
  openDayActivity(date);
}
export function setHistoryRange(value){
  const range = value === 'all' ? 'all' : Number(value);
  if(![7,14,30,90,'all'].includes(range)) return;
  ledgerState.historyRangeDays = range;
  persistSettings();
  renderHistory();
}

function historyDaysForRange(){
  const today = todayKey();
  const desiredStart = ledgerState.historyRangeDays === 'all'
    ? statsStartKey()
    : addDaysToKey(today, -(Number(ledgerState.historyRangeDays) - 1));
  const start = laterDateKey(statsStartKey(), desiredStart);
  const rangeDays = calendarDaysInclusive(start, today);
  const days = [];
  for(let i = rangeDays - 1; i >= 0; i--) days.push(addDaysToKey(today, -i));
  return days;
}

function renderHistoryAverages(ledger){
  const el = document.getElementById('historyAverages');
  const { byDate, end, dates } = ledger;
  const allDays = calendarDaysInclusive(statsStartKey(), end);
  const values = [
    [averageScoreWindow(7, byDate, end, dates), '7-day average'],
    [averageScoreWindow(30, byDate, end, dates), '30-day average'],
    [averageScoreWindow(allDays, byDate, end, dates), 'Since-start average']
  ];
  el.innerHTML = `<div class="metric-group-label">Current averages</div><div class="average-grid">${values.map(([window,label]) =>
    `<div class="average-tile"><div class="average-value mono">${window.average === null ? '—' : Math.round(window.average)}</div><div class="average-label">${label}</div><div class="average-coverage">${window.tracked}/${window.calendarDays} tracked</div></div>`
  ).join('')}</div><div class="average-note">Unknown days are excluded. Each average uses only tracked days inside its calendar window, starting no earlier than ${new Date(statsStartKey() + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}.</div>`;
}

function chartStepForDeviation(maxDeviation){
  const target = Math.max(5, maxDeviation / 2);
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const normalized = target / magnitude;
  const factor = [1,2,2.5,3,5,10].find(x => x >= normalized) || 10;
  return factor * magnitude;
}

function bindChartPreview(svg, days, showDay, selectDay, restoreSelection){
  const plot = svg.querySelector('.chart-plot');
  let press = null;
  let suppressClick = false;

  function dayAt(event, dragging = false){
    // The SVG can be letterboxed. Measure the plot itself in screen coordinates.
    const bounds = plot.getBoundingClientRect();
    if(!bounds.width) return null;
    if(!dragging && (event.clientX < bounds.left || event.clientX > bounds.right ||
       event.clientY < bounds.top || event.clientY > bounds.bottom)) return null;
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    return Math.round(fraction * (days.length - 1));
  }

  svg.addEventListener('pointerdown', event => {
    if(event.isPrimary === false || event.button !== 0) return;
    suppressClick = false;
    if(event.pointerType === 'mouse') return;
    const hitDate = event.target.closest('[data-action="open-day"]')?.dataset.date;
    const index = hitDate ? days.indexOf(hitDate) : dayAt(event);
    if(index === null || index < 0) return;
    press = { id:event.pointerId, x:event.clientX, y:event.clientY, startedAt:event.timeStamp, index, dragging:false };
    event.target.setPointerCapture?.(event.pointerId);
    showDay(index);
  });
  svg.addEventListener('pointermove', event => {
    if(event.isPrimary === false) return;
    if(event.pointerType === 'mouse'){
      const index = dayAt(event);
      if(index === null) restoreSelection();
      else showDay(index);
      return;
    }
    if(!press || press.id !== event.pointerId) return;
    if(!press.dragging){
      const horizontal = Math.abs(event.clientX - press.x);
      const vertical = Math.abs(event.clientY - press.y);
      if(Math.max(horizontal, vertical) > 8) suppressClick = true;
      if(horizontal <= 8 || horizontal < vertical) return;
      press.dragging = true;
    }
    const index = dayAt(event, true);
    if(index !== null){
      press.index = index;
      showDay(index);
    }
  });
  svg.addEventListener('pointerup', event => {
    if(!press || press.id !== event.pointerId) return;
    if(event.timeStamp - press.startedAt >= 350) suppressClick = true;
    selectDay(press.index);
    press = null;
  });
  function cancelPress(event){
    if(!press || press.id !== event.pointerId) return;
    press = null;
    restoreSelection();
  }
  svg.addEventListener('pointercancel', cancelPress);
  svg.addEventListener('lostpointercapture', cancelPress);
  svg.addEventListener('pointerleave', event => {
    if(event.pointerType === 'mouse') restoreSelection();
  });
  svg.addEventListener('contextmenu', event => {
    if(press) event.preventDefault();
  });
  svg.addEventListener('click', event => {
    if(suppressClick && event.detail !== 0){
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

export function renderHistory(ledger = summarizeLedger()){
  renderRangeButtons();
  renderDateJump();
  const el = document.getElementById('historyChart');
  const { manualByDate, byDate, dates:trackedSeq } = ledger;
  renderHistoryAverages(ledger);

  const days = historyDaysForRange();
  if(!viewState.selectedHistoryDate || !days.includes(viewState.selectedHistoryDate)){
    viewState.selectedHistoryDate = days[days.length - 1];
  }
  const trackedDates = new Set(trackedSeq);
  const tracked = days.map(date => trackedDates.has(date));
  const scores = days.map((d, index) => tracked[index] ? ledgerState.dailyBase + (byDate[d] || 0) : null);
  // Single sliding-window pass over the tracked sequence. Calling
  // averageForLastTrackedDays() once per rendered day re-scanned every entry each
  // time, which made renderAll() O(days x entries) and froze the UI on wide ranges.
  const rollingByDate = Object.create(null);
  let rollSum = 0;
  for(let i = 0; i < trackedSeq.length; i++){
    rollSum += ledgerState.dailyBase + (byDate[trackedSeq[i]] || 0);
    if(i >= 7) rollSum -= ledgerState.dailyBase + (byDate[trackedSeq[i - 7]] || 0);
    rollingByDate[trackedSeq[i]] = rollSum / Math.min(i + 1, 7);
  }
  const rolling = days.map((d, index) =>
    tracked[index] && rollingByDate[d] !== undefined ? rollingByDate[d] : null);
  const showAverage = ledgerState.historyRangeDays === 'all' || Number(ledgerState.historyRangeDays) >= 14;
  let maxDeviation = 10;
  for(const series of showAverage ? [scores, rolling] : [scores]){
    for(const value of series){
      if(value !== null) maxDeviation = Math.max(maxDeviation, Math.abs(value - ledgerState.dailyBase));
    }
  }
  const step = chartStepForDeviation(maxDeviation);
  const yMin = ledgerState.dailyBase - step * 2;
  const yMax = ledgerState.dailyBase + step * 2;

  const W = 360, H = 210, left = 38, right = 8, top = 9, bottom = 25;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const xFor = i => days.length === 1 ? left + plotW / 2 : left + (i / (days.length - 1)) * plotW;
  const yFor = value => top + ((yMax - value) / (yMax - yMin)) * plotH;
  const pathForObserved = values => {
    let started = false;
    return values.map((value, i) => {
      if(value === null){
        started = false;
        return '';
      }
      const command = started ? 'L' : 'M';
      started = true;
      return `${command}${xFor(i).toFixed(2)},${yFor(value).toFixed(2)}`;
    }).filter(Boolean).join(' ');
  };
  const pathAcrossUnknownGaps = values => {
    const segments = [];
    let previousObservedIndex = null;
    let crossedUnknown = false;
    values.forEach((value, i) => {
      if(value === null){
        if(pauseOn(days[i])) previousObservedIndex = null;
        else if(previousObservedIndex !== null) crossedUnknown = true;
        return;
      }
      if(previousObservedIndex !== null && crossedUnknown){
        segments.push(
          `M${xFor(previousObservedIndex).toFixed(2)},${yFor(values[previousObservedIndex]).toFixed(2)}` +
          ` L${xFor(i).toFixed(2)},${yFor(value).toFixed(2)}`
        );
      }
      previousObservedIndex = i;
      crossedUnknown = false;
    });
    return segments.join(' ');
  };
  const firstDay = days[0], lastDay = days[days.length - 1];
  const halfDayWidth = plotW / Math.max(1, days.length - 1) / 2;
  const pauseBands = pauseIntervals.filter(range => range.start <= lastDay && range.end >= firstDay).map(range => {
    const start = laterDateKey(range.start, firstDay);
    const end = range.end < lastDay ? range.end : lastDay;
    const x = Math.max(left, xFor(calendarDaysInclusive(firstDay, start) - 1) - halfDayWidth);
    const edge = Math.min(left + plotW, xFor(calendarDaysInclusive(firstDay, end) - 1) + halfDayWidth);
    return `<rect class="chart-paused" x="${x}" y="${top}" width="${edge - x}" height="${plotH}"></rect>`;
  }).join('');
  const scoreGapPath = pathAcrossUnknownGaps(scores);
  const averageGapPath = showAverage ? pathAcrossUnknownGaps(rolling) : '';

  const yTicks = [yMin, ledgerState.dailyBase - step, ledgerState.dailyBase, ledgerState.dailyBase + step, yMax];
  const yGrid = yTicks.map(value => {
    const y = yFor(value);
    const baseline = value === ledgerState.dailyBase;
    return `<line class="${baseline ? 'chart-baseline' : 'chart-grid'}" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"></line>
      <text class="chart-axis-label${baseline ? ' baseline' : ''}" x="${left - 5}" y="${y + 3}" text-anchor="end">${Math.round(value)}</text>`;
  }).join('');

  const xLabelCount = Math.min(5, days.length);
  const labelIndexes = [...new Set(Array.from({ length:xLabelCount }, (_, i) => Math.round(i * (days.length - 1) / Math.max(1, xLabelCount - 1))))];
  const xLabels = labelIndexes.map(i => {
    const date = new Date(days[i] + 'T12:00:00');
    const label = days.length > 180
      ? date.toLocaleDateString('en-US', { month:'short', year:'2-digit' })
      : date.toLocaleDateString('en-US', { month:'numeric', day:'numeric' });
    return `<text class="chart-axis-label" x="${xFor(i)}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${label}</text>`;
  }).join('');

  const markerIndexes = [];
  let lastMarkerColumn = -1;
  // Adjacent dates can share a pixel on long ranges. Keep the graph paths and
  // date lookup at full resolution while limiting the number of SVG controls.
  days.forEach((date, i) => {
    const column = Math.floor(xFor(i));
    if(column === lastMarkerColumn || (!tracked[i] && !pauseOn(date))) return;
    markerIndexes.push(i);
    lastMarkerColumn = column;
  });
  const halfHitWidth = Math.max(12, halfDayWidth);
  const markers = markerIndexes.map((i, index) => {
    const d = days[i];
    const score = scores[i];
    const success = ledgerState.dailyBase + (manualByDate[d] || 0) >= ledgerState.successThreshold;
    const dateLabel = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    const x = xFor(i);
    const leftBoundary = index > 0 ? (x + xFor(markerIndexes[index - 1])) / 2 : left;
    const rightBoundary = index < markerIndexes.length - 1 ? (x + xFor(markerIndexes[index + 1])) / 2 : left + plotW;
    const hitStart = Math.max(x - halfHitWidth, leftBoundary);
    const hitEnd = Math.min(x + halfHitWidth, rightBoundary);
    const dayAction = `data-action="open-day" data-date="${d}"`;
    return {
      hit:`<rect class="chart-hit" x="${hitStart}" y="${top}" width="${hitEnd - hitStart}" height="${plotH}" ${dayAction} role="button" tabindex="0" aria-label="${dateLabel}: ${tracked[i] ? 'score ' + Math.round(score) : 'paused'}. Open activity."></rect>`,
      dot:tracked[i] ? `<circle class="chart-dot${success ? ' success' : ''}" cx="${x}" cy="${yFor(score)}" r="${days.length > 90 ? 2.2 : 3.2}" ${dayAction} aria-hidden="true"></circle>` : ''
    };
  });
  let selectedIndex = Math.max(0, days.indexOf(viewState.selectedHistoryDate));
  el.innerHTML = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Tracked daily score history since ${statsStartKey()}. Unknown days are omitted.">
    <rect class="chart-plot" x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
    ${pauseBands}
    ${yGrid}
    ${xLabels}
    <path class="chart-score-line" d="${pathForObserved(scores)}"></path>
    ${scoreGapPath ? `<path class="chart-score-gap" d="${scoreGapPath}"></path>` : ''}
    ${showAverage ? `<path class="chart-average-line" d="${pathForObserved(rolling)}"></path>` : ''}
    ${averageGapPath ? `<path class="chart-average-gap" d="${averageGapPath}"></path>` : ''}
    <line class="chart-selected-guide" y1="${top}" y2="${top + plotH}" pointer-events="none"></line>
    ${markers.map(marker => marker.hit).join('')}
    <circle class="chart-selected-dot" r="4.2" data-action="open-day" aria-hidden="true"></circle>
    ${markers.map(marker => marker.dot).join('')}
  </svg>
  <div class="chart-selection-readout" role="status" aria-live="polite">
    <span></span><strong class="mono"></strong>
  </div>
  <div class="chart-legend">
    <span class="legend-item"><span class="legend-swatch"></span>Daily score</span>
    ${showAverage ? `<span class="legend-item"><span class="legend-swatch average"></span>7 tracked-day moving average</span>` : ''}
    ${pauseBands ? '<span class="legend-item"><span class="legend-swatch paused"></span>Travel pause</span>' : ''}
    ${scoreGapPath ? `<span class="legend-item"><span class="legend-swatch gap"></span>Unknown gap</span>` : ''}
    <span class="legend-item"><span class="legend-swatch baseline"></span>Baseline</span>
  </div>
  <div class="chart-hint">Hover or drag across the graph to see scores. Tap a point for details.</div>`;

  const svg = el.querySelector('svg');
  const guide = svg.querySelector('.chart-selected-guide');
  const dot = svg.querySelector('.chart-selected-dot');
  const label = el.querySelector('.chart-selection-readout span');
  const value = el.querySelector('.chart-selection-readout strong');
  let shownIndex = null;
  function showDay(i){
    if(i === shownIndex) return;
    shownIndex = i;
    const x = xFor(i);
    guide.setAttribute('x1', x);
    guide.setAttribute('x2', x);
    dot.setAttribute('visibility', tracked[i] ? 'visible' : 'hidden');
    if(tracked[i]){
      dot.dataset.date = days[i];
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', yFor(scores[i]));
    }
    const date = new Date(days[i] + 'T12:00:00');
    label.textContent = date.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' }) +
      (tracked[i] ? '' : pauseOn(days[i]) ? ' · Paused' : ' · Untracked');
    value.textContent = tracked[i] ? Math.round(scores[i]) : '—';
  }
  showDay(selectedIndex);
  bindChartPreview(svg, days, showDay, index => {
    selectedIndex = index;
    viewState.selectedHistoryDate = days[index];
  }, () => showDay(selectedIndex));

  let successCount = 0, trackedCount = 0;
  days.forEach((d, i) => {
    if(!tracked[i]) return;
    trackedCount++;
    if(ledgerState.dailyBase + (manualByDate[d] || 0) >= ledgerState.successThreshold) successCount++;
  });
  document.getElementById('historyRateEl').textContent =
    trackedCount > 0 ? `${successCount}/${trackedCount} success` : '';
}
