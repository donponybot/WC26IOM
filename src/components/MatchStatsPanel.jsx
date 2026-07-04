import { useState, useMemo } from 'react';
import { MATCHES } from '../data/matches';
import stats from '../data/historicalStats.json';
import FlagImg from './FlagImg';

const GROUP_MATCHES = MATCHES.filter(m => m.home && m.away);

function h2hKey(a, b) { return [a, b].sort().join('|'); }

// ── Competition weight (v2 spec) ─────────────────────────────────────
function competitionWeight(t) {
  if (!t) return 0.7;
  const tl = t.toLowerCase();
  if (tl === 'fifa world cup') return 1.0;
  if (tl.includes('world cup qual')) return 1.0;
  if (['african cup of nations', 'africa cup of nations', 'copa américa',
       'copa america', 'gold cup', 'afc asian cup',
       'uefa european championship'].includes(tl)) return 1.0;
  if (tl === 'friendly') return 0.4;
  if (['kirin cup', 'al ain international cup', 'soccer ashes',
       'fifa series'].some(x => tl.includes(x))) return 0.4;
  return 0.7; // Nations League, Arab Cup, other
}

// ── Prediction engine (v2 spec) ──────────────────────────────────────
function computePrediction(home, away) {
  const formA   = stats.form[home]       || [];
  const formB   = stats.form[away]       || [];
  const wcA     = stats.wc_modern[home]  || { p:0, w:0, d:0, l:0, gf:0, ga:0 };
  const wcB     = stats.wc_modern[away]  || { p:0, w:0, d:0, l:0, gf:0, ga:0 };
  const h2hRec  = stats.h2h_recent[h2hKey(home, away)];

  const lowFormA = formA.length < 5;
  const lowFormB = formB.length < 5;

  // Step 1 — form score
  function formScore(form) {
    if (!form.length) return 0.5;
    let score = 0;
    for (let i = 0; i < form.length; i++) {
      const w  = (i + 1) / 55;
      const cw = competitionWeight(form[i].tournament);
      const pts = form[i].result === 'W' ? 3 : form[i].result === 'D' ? 1 : 0;
      score += w * cw * pts;
    }
    return score / 3; // max = 3 × (55/55) = 3
  }

  // Step 2 — attack / defence (competition-weighted)
  function attackDefence(form) {
    if (!form.length) return { gfAvg: 1.0, gaAvg: 1.0 };
    let wSum = 0, gfSum = 0, gaSum = 0;
    for (let i = 0; i < form.length; i++) {
      const wc = ((i + 1) / 55) * competitionWeight(form[i].tournament);
      wSum += wc; gfSum += wc * form[i].gf; gaSum += wc * form[i].ga;
    }
    return { gfAvg: gfSum / wSum, gaAvg: gaSum / wSum };
  }

  // Step 3 — WC pedigree (2010-2022 only)
  function wcPedigree(wc) {
    if (wc.p >= 9)  return { winRate: wc.w / wc.p, gfPerGame: wc.gf / wc.p, gaPerGame: wc.ga / wc.p, confidence: 1.0 };
    if (wc.p >= 3)  return { winRate: wc.w / wc.p, gfPerGame: wc.gf / wc.p, gaPerGame: wc.ga / wc.p, confidence: 0.6 };
    return { winRate: 0.20, gfPerGame: 0.8, gaPerGame: 1.5, confidence: 0.3 };
  }

  // Step 4 — H2H (2018+)
  let h2hAdv = 0, h2hConf = 0, h2hCount = 0;
  if (h2hRec?.total > 0) {
    const t1IsHome = home === h2hRec.t1;
    const homeW    = t1IsHome ? h2hRec.t1w : h2hRec.t2w;
    const awayW    = t1IsHome ? h2hRec.t2w : h2hRec.t1w;
    h2hCount = h2hRec.total;
    h2hAdv   = (homeW - awayW) / h2hRec.total;
    h2hConf  = Math.min(h2hRec.total / 6, 1.0);
  }

  const fsA   = lowFormA ? 0.5 : formScore(formA);
  const fsB   = lowFormB ? 0.5 : formScore(formB);
  const adA   = attackDefence(formA);
  const adB   = attackDefence(formB);
  const pedA  = wcPedigree(wcA);
  const pedB  = wcPedigree(wcB);

  const gfNormA = Math.min(adA.gfAvg / 2.0, 1.0);
  const gaNormA = Math.min(adA.gaAvg / 2.0, 1.0);
  const gfNormB = Math.min(adB.gfAvg / 2.0, 1.0);
  const gaNormB = Math.min(adB.gaAvg / 2.0, 1.0);

  // Step 5 — strength
  let strA = 0.40 * fsA + 0.25 * pedA.winRate * pedA.confidence + 0.20 * gfNormA + 0.15 * (1 - gaNormA);
  let strB = 0.40 * fsB + 0.25 * pedB.winRate * pedB.confidence + 0.20 * gfNormB + 0.15 * (1 - gaNormB);
  strA += h2hAdv * h2hConf * 0.08;
  strB -= h2hAdv * h2hConf * 0.08;
  if (lowFormA || lowFormB) {
    strA = 0.5 + (strA - 0.5) * 0.6;
    strB = 0.5 + (strB - 0.5) * 0.6;
  }

  // Step 6 — probabilities (v2.1)
  const diff = strA - strB;
  let pWin  = 1 / (1 + Math.exp(-4 * diff));
  // Fix 2: tighter sigma (0.30), higher base (0.27)
  let pDraw = 0.27 * Math.exp(-(diff * diff) / (0.30 * 0.30));
  // Fix 2 secondary boost: evenly-matched form scores near zero diff
  if (Math.abs(fsA - fsB) <= 0.05 && Math.abs(diff) < 0.08) {
    pDraw = Math.min(pDraw * 1.25, 0.38);
  }
  let pLoss = 1 - pWin - pDraw;
  // Fix 3: near-even uncertainty widening when H2H is sparse
  if (Math.abs(diff) < 0.10 && h2hConf < 0.4) {
    pWin  = pWin  * 0.85 + pDraw * 0.15;
    pLoss = pLoss * 0.85 + pDraw * 0.15;
  }
  const clamp = v => Math.max(0.04, Math.min(0.93, v));
  pWin = clamp(pWin); pDraw = clamp(pDraw); pLoss = clamp(pLoss);
  const tot = pWin + pDraw + pLoss;
  pWin /= tot; pDraw /= tot; pLoss /= tot;

  // Step 7 — xG (v2.1)
  // Fix 1: mismatch multiplier — scale up the favoured team when diff is large
  const mismatch   = Math.max(Math.abs(diff) - 0.10, 0);
  const xgMult     = 1.0 + mismatch * 1.5;
  const homeIsFav  = diff > 0;
  let xgA = (0.5 * adA.gfAvg + 0.3 * (1 - adB.gaAvg / 2.0) + 0.2 * pedA.gfPerGame * pedA.confidence)
            * (homeIsFav ? xgMult : 1.0);
  let xgB = (0.5 * adB.gfAvg + 0.3 * (1 - adA.gaAvg / 2.0) + 0.2 * pedB.gfPerGame * pedB.confidence)
            * (homeIsFav ? 1.0 : xgMult);
  xgA = Math.max(0.3, Math.min(3.5, xgA));
  xgB = Math.max(0.3, Math.min(3.5, xgB));
  // Fix 4: hard cap for weak first-timers when they're heavy underdogs
  if (pedA.confidence <= 0.3 && diff < -0.20) xgA = Math.min(xgA, 0.5);
  if (pedB.confidence <= 0.3 && diff >  0.20) xgB = Math.min(xgB, 0.5);
  xgA = Math.round(xgA * 10) / 10;
  xgB = Math.round(xgB * 10) / 10;

  // Step 8 — verdict
  const fav = diff > 0 ? home : away;
  const abs = Math.abs(diff);
  let verdict;
  if (abs < 0.05) verdict = `${home} and ${away} are evenly matched`;
  else if (abs < 0.15) verdict = pDraw > pWin && pDraw > pLoss ? `Draw likely, slight edge to ${fav}` : `${fav} slight favourite`;
  else if (abs < 0.30) verdict = `${fav} moderate favourite`;
  else                 verdict = `${fav} strong favourite`;

  return {
    pWin: Math.round(pWin * 100), pDraw: Math.round(pDraw * 100), pLoss: Math.round(pLoss * 100),
    xgA, xgB, verdict, diff,
    flags: { lowFormData: lowFormA || lowFormB, wcConfA: pedA.confidence, wcConfB: pedB.confidence, h2hCount },
  };
}

// ── Sub-components ────────────────────────────────────────────────────
function ResultBadge({ r }) {
  const cls = r === 'W' ? 'msp-badge-w' : r === 'D' ? 'msp-badge-d' : 'msp-badge-l';
  return <span className={`msp-badge ${cls}`}>{r}</span>;
}

function PredictionCard({ home, away }) {
  const p = useMemo(() => computePrediction(home, away), [home, away]);
  const { pWin, pDraw, pLoss, xgA, xgB, verdict, flags } = p;

  return (
    <div className="msp-pred">
      <div className="msp-pred-probs">
        <div className="msp-pred-team">
          <FlagImg team={home} size={20} />
          <span>{home}</span>
          <strong>{pWin}%</strong>
        </div>
        <div className="msp-pred-draw">
          <span>Draw</span>
          <strong>{pDraw}%</strong>
        </div>
        <div className="msp-pred-team msp-pred-team-right">
          <strong>{pLoss}%</strong>
          <span>{away}</span>
          <FlagImg team={away} size={20} />
        </div>
      </div>

      <div className="msp-pred-bar">
        <div className="msp-bar-home" style={{ width: `${pWin}%` }}  title={`${home} win: ${pWin}%`} />
        <div className="msp-bar-draw" style={{ width: `${pDraw}%` }} title={`Draw: ${pDraw}%`} />
        <div className="msp-bar-away" style={{ width: `${pLoss}%` }} title={`${away} win: ${pLoss}%`} />
      </div>

      <div className="msp-pred-xg">
        <span className="msp-pred-xg-val">xG {xgA}</span>
        <span className="msp-pred-verdict">"{verdict}"</span>
        <span className="msp-pred-xg-val">xG {xgB}</span>
      </div>

      <div className="msp-pred-flags">
        {flags.lowFormData && <span className="msp-flag msp-flag-warn">⚠ low form data</span>}
        <span className="msp-flag">WC conf: {flags.wcConfA} / {flags.wcConfB}</span>
        <span className="msp-flag">H2H (2018+): {flags.h2hCount} games</span>
      </div>
    </div>
  );
}

function FormRow({ team }) {
  const recent = [...(stats.form[team] || [])].reverse();
  if (!recent.length) return <p className="msp-no-data">No data</p>;
  const gf = recent.reduce((s, m) => s + m.gf, 0);
  const ga = recent.reduce((s, m) => s + m.ga, 0);
  const n  = recent.length;
  return (
    <div className="msp-form-row">
      <div className="msp-badges">
        {recent.map((m, i) => (
          <span key={i} className="msp-form-item" title={`${m.date} vs ${m.opponent} ${m.gf}-${m.ga} (${m.tournament})`}>
            <ResultBadge r={m.result} />
          </span>
        ))}
      </div>
      <div className="msp-form-avgs">
        <span className="msp-avg-pill msp-avg-gf">GF {(gf / n).toFixed(1)}</span>
        <span className="msp-avg-pill msp-avg-ga">GA {(ga / n).toFixed(1)}</span>
        <span className="msp-avg-label">avg / match (last {n})</span>
      </div>
    </div>
  );
}

function H2HBar({ home, away }) {
  const data = stats.h2h[h2hKey(home, away)];
  if (!data) {
    return <div className="msp-h2h-empty">No recorded matches between {home} and {away}</div>;
  }
  const t1IsHome = home === data.t1;
  const homeW   = t1IsHome ? data.t1w : data.t2w;
  const awayW   = t1IsHome ? data.t2w : data.t1w;
  const homeG   = t1IsHome ? data.t1g : data.t2g;
  const awayG   = t1IsHome ? data.t2g : data.t1g;
  const { total, draws, last } = data;
  const homePct = total ? (homeW / total) * 100 : 0;
  const drawPct = total ? (draws / total) * 100 : 0;
  const awayPct = total ? (awayW / total) * 100 : 0;
  const lastHG  = t1IsHome ? last.t1g : last.t2g;
  const lastAG  = t1IsHome ? last.t2g : last.t1g;

  return (
    <div className="msp-h2h">
      <div className="msp-h2h-bar-wrap">
        <span className="msp-h2h-label-left">{home}<br /><strong>{homeW}W · {Math.round(homePct)}%</strong></span>
        <div className="msp-h2h-bar-col">
          <div className="msp-h2h-bar">
            {homePct > 0 && <div className="msp-bar-home" style={{ width: `${homePct}%` }} title={`${home} wins: ${homeW}`} />}
            {drawPct > 0 && <div className="msp-bar-draw" style={{ width: `${drawPct}%` }} title={`Draws: ${draws}`} />}
            {awayPct > 0 && <div className="msp-bar-away" style={{ width: `${awayPct}%` }} title={`${away} wins: ${awayW}`} />}
          </div>
          {drawPct > 0 && <div className="msp-h2h-draw-pct">{draws}D · {Math.round(drawPct)}%</div>}
        </div>
        <span className="msp-h2h-label-right">{away}<br /><strong>{awayW}W · {Math.round(awayPct)}%</strong></span>
      </div>
      <div className="msp-h2h-meta">
        <span>{total} matches · {draws} draws · {homeG}–{awayG} goals</span>
        {last && <span className="msp-h2h-last">Last: {last.date} · {lastHG}–{lastAG} · {last.tournament}</span>}
      </div>
    </div>
  );
}

function WCRecord({ team }) {
  const r = stats.wc[team];
  if (!r || r.apps === 0) return <p className="msp-no-data">No World Cup history</p>;
  return (
    <div className="msp-wc-grid">
      <div className="msp-wc-stat"><span className="msp-wc-val">{r.apps}</span><span className="msp-wc-lbl">WCs</span></div>
      <div className="msp-wc-stat"><span className="msp-wc-val">{r.p}</span><span className="msp-wc-lbl">Played</span></div>
      <div className="msp-wc-stat msp-wc-w"><span className="msp-wc-val">{r.w}</span><span className="msp-wc-lbl">Won</span></div>
      <div className="msp-wc-stat msp-wc-d"><span className="msp-wc-val">{r.d}</span><span className="msp-wc-lbl">Drawn</span></div>
      <div className="msp-wc-stat msp-wc-l"><span className="msp-wc-val">{r.l}</span><span className="msp-wc-lbl">Lost</span></div>
      <div className="msp-wc-stat"><span className="msp-wc-val">{r.gf}</span><span className="msp-wc-lbl">GF</span></div>
      <div className="msp-wc-stat"><span className="msp-wc-val">{r.ga}</span><span className="msp-wc-lbl">GA</span></div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────
export default function MatchStatsPanel() {
  const [selectedId, setSelectedId] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return GROUP_MATCHES.find(m => m.kickoff.startsWith(today))?.id || '';
  });

  const match = useMemo(
    () => GROUP_MATCHES.find(m => m.id === selectedId) || null,
    [selectedId]
  );

  return (
    <div className="msp-page">
      <div className="msp-panel">
        <div className="msp-select-wrap">
          <select className="msp-select" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            <option value="">— Select a match —</option>
            {GROUP_MATCHES.map(m => (
              <option key={m.id} value={m.id}>Group {m.group} · {m.home} vs {m.away} · {m.date}</option>
            ))}
          </select>
        </div>

        {match && (
          <div className="msp-body">
            {/* Match header */}
            <div className="msp-match-header">
              <div className="msp-team">
                <FlagImg team={match.home} size={32} />
                <span className="msp-team-name">{match.home}</span>
              </div>
              <div className="msp-vs-block">
                <span className="msp-vs">vs</span>
                <span className="msp-match-meta">{match.date} · Group {match.group}</span>
              </div>
              <div className="msp-team msp-team-right">
                <span className="msp-team-name">{match.away}</span>
                <FlagImg team={match.away} size={32} />
              </div>
            </div>

            {/* Prediction */}
            <div className="msp-section">
              <h4 className="msp-section-title">Prediction</h4>
              <PredictionCard home={match.home} away={match.away} />
            </div>

            {/* H2H */}
            <div className="msp-section">
              <h4 className="msp-section-title">Head-to-Head (all-time)</h4>
              <H2HBar home={match.home} away={match.away} />
            </div>

            {/* Recent form */}
            <div className="msp-section">
              <h4 className="msp-section-title">Recent Form (last 10)</h4>
              <div className="msp-two-col">
                <div className="msp-col">
                  <div className="msp-col-header"><FlagImg team={match.home} size={16} /><span>{match.home}</span></div>
                  <FormRow team={match.home} />
                </div>
                <div className="msp-col">
                  <div className="msp-col-header"><FlagImg team={match.away} size={16} /><span>{match.away}</span></div>
                  <FormRow team={match.away} />
                </div>
              </div>
            </div>

            {/* World Cup record */}
            <div className="msp-section">
              <h4 className="msp-section-title">World Cup Record (all-time)</h4>
              <div className="msp-two-col">
                <div className="msp-col">
                  <div className="msp-col-header"><FlagImg team={match.home} size={16} /><span>{match.home}</span></div>
                  <WCRecord team={match.home} />
                </div>
                <div className="msp-col">
                  <div className="msp-col-header"><FlagImg team={match.away} size={16} /><span>{match.away}</span></div>
                  <WCRecord team={match.away} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
