import { computeStats, computeTrends } from "../ledger/statistics.js";
import { ledgerState } from "../state.js";
import { escapeHtml } from "./dom.js";

export function renderStats(ledger){
  const el = document.getElementById('statsGrid');
  const s = computeStats(ledger);

  if(s.daysTracked === 0){
    el.innerHTML = `<div class="stat-tile wide"><div class="stat-value">—</div><div class="stat-label">Log activity or mark a day complete to start stats</div></div>`;
    document.getElementById('topContributors').innerHTML = '';
    return;
  }

  const bestDayLabel = new Date(s.bestDay.date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });

  const singles = [
    [s.daysTracked, 'Days tracked'],
    [s.successRate + '%', 'Success rate since start'],
    [(s.currentStreak > 0 ? '🔥 ' : '') + s.currentStreak, 'Current success streak'],
    [s.bestStreak, 'Best success streak'],
  ];

  let html = singles.map(([value, label]) => `
    <div class="stat-tile">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>`).join('');

  html += `
    <div class="stat-tile wide">
      <div class="stat-value">${s.bestDay.score}</div>
      <div class="stat-label">Best day · ${bestDayLabel}</div>
    </div>`;

  el.innerHTML = html;

  document.getElementById('topContributors').innerHTML =
    renderRankBlock('Biggest gains', s.biggestGains, 'gain') +
    renderRankBlock('Biggest drains', s.biggestDrains, 'loss');
}

// Renders a top-3 ranked list for either gains or drains. Each row shows the plain
// instance count (no "×") and the total points that habit/bonus is responsible for.
function renderRankBlock(title, list, tone){
  if(!list || list.length === 0) return '';
  const rows = list.map((item, i) => `
    <div class="rank-row">
      <span class="rank-rank">${i + 1}</span>
      <span class="rank-name">${escapeHtml(item.name)}</span>
      <span class="rank-figures mono">
        <span class="rank-count">${item.count}</span>
        <span class="rank-total ${tone}-tone">${item.points > 0 ? '+' : ''}${item.points}</span>
      </span>
    </div>`).join('');
  return `
    <div class="rank-block">
      <div class="rank-head">
        <span class="rank-title ${tone}-tone">${title}</span>
        <span class="rank-collabels">Logged&nbsp;&nbsp;&nbsp;Total</span>
      </div>
      ${rows}
    </div>`;
}

export function renderTrends(ledger){
  const el = document.getElementById('trendsBody');
  const t = computeTrends(ledger);

  if(!t.ready){
    el.innerHTML = `<div class="empty">Log activity or mark a day complete and trends will begin immediately.</div>`;
    return;
  }

  const dayNamesFull = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const daysWithData = t.dowAverages.filter(a => a !== null).length;

  let summary = '';
  if(daysWithData === 1){
    const only = t.dowAverages.findIndex(a => a !== null);
    summary = `<div class="dow-summary">Only enough history for ${dayNamesFull[only]} so far — log a few more weeks for a full comparison.</div>`;
  } else if(t.bestDow === t.worstDow){
    // Multiple weekdays tracked, but they all average out the same — a real tie,
    // not a data-sparsity issue, so it gets its own message rather than picking
    // an arbitrary "best."
    summary = `<div class="dow-summary">Every day performs about the same so far (avg ${Math.round(t.dowAverages[t.bestDow])}).</div>`;
  } else {
    summary = `<div class="dow-summary">Best day: <span class="gain-tone">${dayNamesFull[t.bestDow]}</span> (avg ${Math.round(t.dowAverages[t.bestDow])}) &nbsp;·&nbsp; Worst day: <span class="loss-tone">${dayNamesFull[t.worstDow]}</span> (avg ${Math.round(t.dowAverages[t.worstDow])})</div>`;
  }

  const maxAbsNet = Math.max(1, ...t.dowAverages.map(a => a === null ? 0 : Math.abs(a - ledgerState.dailyBase)));
  const rows = [0,1,2,3,4,5,6].map(i => {
    const avg = t.dowAverages[i];
    if(avg === null){
      return `
        <div class="dow-row">
          <div class="dow-label">${t.dowNames[i]}</div>
          <div class="dow-track"></div>
          <div class="dow-empty">—</div>
        </div>`;
    }
    const net = avg - ledgerState.dailyBase;
    const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : 'even';
    const widthPct = Math.min(50, Math.abs(net) / maxAbsNet * 50);
    const rowClass = i === t.bestDow ? 'best' : (i === t.worstDow ? 'worst' : '');
    return `
      <div class="dow-row ${rowClass}">
        <div class="dow-label">${t.dowNames[i]}</div>
        <div class="dow-track"><div class="dow-bar ${tone}" style="width:${widthPct}%"></div></div>
        <div class="dow-value mono">${Math.round(avg)}</div>
      </div>`;
  }).join('');

  const sign = v => v > 0 ? '+' : '';
  const paceTone = t.recentPaceScore > ledgerState.dailyBase ? 'gain-tone' : t.recentPaceScore < ledgerState.dailyBase ? 'loss-tone' : '';
  const projectionTone = value => value > ledgerState.dailyBase ? 'gain-tone' : value < ledgerState.dailyBase ? 'loss-tone' : '';
  const netTone = value => value > 0 ? 'gain-tone' : value < 0 ? 'loss-tone' : '';
  const formatNet = value => `${sign(value)}${Math.round(value)}`;
  const p = t.projections;

  el.innerHTML = `
    ${t.early ? `<div class="trend-note">Early trend · based on ${t.daysTracked} tracked day${t.daysTracked === 1 ? '' : 's'} across a ${t.observationSpanDays}-day calendar span since your start date. Unknown days are excluded. This will settle as more activity is recorded.</div>` : ''}
    ${summary}
    <div class="dow-list">${rows}</div>
    <div class="metric-group-label">Future forecast</div>
    <div class="pace-line">${t.early ? 'Early forecast' : 'Current forecast'} — your recent pace is <span class="mono ${paceTone}">${t.recentPaceScore.toFixed(1)} points/day</span> (${sign(t.avgDailyNet)}${t.avgDailyNet.toFixed(1)} from baseline) over the last ${t.paceDays} tracked day${t.paceDays === 1 ? '' : 's'}. If that continues, your cumulative daily average is projected to be:</div>
    <div class="stats-grid forecast-grid">
      <div class="stat-tile projection-card">
        <div class="forecast-horizon">In 30 days</div>
        <div class="stat-value mono ${projectionTone(p.d30)}">${p.d30.toFixed(1)}</div>
        <div class="stat-label">Projected average</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.d30Net)}">${formatNet(p.d30Net)}</strong></div>
      </div>
      <div class="stat-tile projection-card">
        <div class="forecast-horizon">In 90 days</div>
        <div class="stat-value mono ${projectionTone(p.d90)}">${p.d90.toFixed(1)}</div>
        <div class="stat-label">Projected average</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.d90Net)}">${formatNet(p.d90Net)}</strong></div>
      </div>
      <div class="stat-tile wide projection-card">
        <div class="forecast-horizon">By December 31</div>
        <div class="stat-value mono ${projectionTone(p.eoy)}">${p.eoy.toFixed(1)}</div>
        <div class="stat-label">Projected average · ${p.daysUntilEndOfYear === 0 ? 'Today' : `${p.daysUntilEndOfYear} days out`}</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.eoyNet)}">${formatNet(p.eoyNet)}</strong></div>
      </div>
    </div>
    <div class="projection-note">Forecast combines your actual tracked-day average with your recent tracked-day pace for future days. Unknown historical days stay excluded; automatic milestone rewards already earned are included like bonus entries.</div>`;
}
