/* ============================================================
   WiFi Office Quality Checker — app.js
   All logic: state, tests, scoring, render
   ============================================================ */

'use strict';

/* ----------------------------------------------------------
   CONSTANTS
   ---------------------------------------------------------- */

const PHASES = [
  {
    id: 'latency',
    name: 'Latence',
    desc: 'Mesure du temps aller-retour vers Cloudflare (20 échantillons)',
  },
  {
    id: 'jitter',
    name: 'Gigue',
    desc: 'Calcul de la variation de latence (écart-type)',
  },
  {
    id: 'packetloss',
    name: 'Pertes de paquets',
    desc: 'Envoi de 30 sondes avec délai de 3 s',
  },
  {
    id: 'download',
    name: 'Téléchargement',
    desc: 'Téléchargement de 25 Mo depuis Cloudflare',
  },
  {
    id: 'upload',
    name: 'Envoi',
    desc: 'Envoi de 10 Mo vers Cloudflare',
  },
  {
    id: 'dns',
    name: 'Résolution DNS',
    desc: 'Mesure du temps de résolution de domaine',
  },
  {
    id: 'consistency',
    name: 'Consistance',
    desc: 'Trois × 5 Mo téléchargés, coefficient de variation',
  },
  {
    id: 'peremployee',
    name: 'Bande passante / utilisateur',
    desc: 'Calcul de la bande passante par utilisateur simultané',
  },
];

const SCORE_WEIGHTS = {
  download: 3,
  upload: 2,
  latency: 2,
  packetloss: 2,
  consistency: 2,
  jitter: 1,
  dns: 1,
};

const GRADE_POINTS = { excellent: 100, good: 75, fair: 40, poor: 10 };

const USE_CASES = [
  { name: 'VoIP / Appels vocaux',     threshold: 0.1,  label: '0,1 Mbps/util.' },
  { name: 'Visioconférence',           threshold: 2.0,  label: '2,0 Mbps/util.' },
  { name: 'Travail standard',          threshold: 5.0,  label: '5,0 Mbps/util.' },
  { name: 'Marge confortable',         threshold: 10.0, label: '10 Mbps/util.' },
];

/* ----------------------------------------------------------
   STATE
   ---------------------------------------------------------- */

const state = {
  officeName: '',
  employeeCount: 25,
  multiZone: false,
  zoneUserCount: 10,
  phase: 'setup',       // 'setup' | 'testing' | 'results'
  currentPhase: null,
  aborted: false,
  startTime: null,
  results: {},
  scores: {},
  overallScore: 0,
};

/* ----------------------------------------------------------
   VIEW HELPERS
   ---------------------------------------------------------- */

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
  document.getElementById('view-' + id).classList.add('view--active');
}

function setPhaseStatus(phaseId, status, value) {
  const el = document.querySelector(`.phase-item[data-phase="${phaseId}"]`);
  if (!el) return;
  el.setAttribute('data-status', status);
  if (value !== undefined) {
    el.querySelector('.phase-value').textContent = value;
  }
}

function setProgress(pct) {
  document.getElementById('progress-bar').style.width = pct + '%';
}

/* ----------------------------------------------------------
   EMPLOYEE VALIDATION
   ---------------------------------------------------------- */

function getEmployeeCount() {
  const val = parseInt(document.getElementById('employee-count').value, 10);
  return isNaN(val) ? 0 : val;
}

function getZoneUserCount() {
  const val = parseInt(document.getElementById('zone-count').value, 10);
  return isNaN(val) ? 0 : val;
}

function getEffectiveUserCount() {
  return state.multiZone ? state.zoneUserCount : state.employeeCount;
}

function validateEmployees() {
  const count = getEmployeeCount();
  const input = document.getElementById('employee-count');
  const error = document.getElementById('employee-error');
  let valid = true;

  if (count < 1 || count > 500) {
    input.classList.add('error');
    error.classList.add('visible');
    valid = false;
  } else {
    input.classList.remove('error');
    error.classList.remove('visible');
  }

  if (state.multiZone) {
    const zoneCount = getZoneUserCount();
    const zoneInput = document.getElementById('zone-count');
    const zoneError = document.getElementById('zone-error');
    if (zoneCount < 1 || zoneCount > 500) {
      zoneInput.classList.add('error');
      zoneError.classList.add('visible');
      valid = false;
    } else {
      zoneInput.classList.remove('error');
      zoneError.classList.remove('visible');
    }
  }

  return valid;
}

/* ----------------------------------------------------------
   SCORING
   ---------------------------------------------------------- */

function gradeDownload(mbps) {
  if (mbps >= 100) return 'excellent';
  if (mbps >= 50)  return 'good';
  if (mbps >= 20)  return 'fair';
  return 'poor';
}

function gradeUpload(mbps) {
  if (mbps >= 50) return 'excellent';
  if (mbps >= 20) return 'good';
  if (mbps >= 10) return 'fair';
  return 'poor';
}

function gradeLatency(ms) {
  if (ms <= 10) return 'excellent';
  if (ms <= 30) return 'good';
  if (ms <= 60) return 'fair';
  return 'poor';
}

function gradeJitter(ms) {
  if (ms <= 5)  return 'excellent';
  if (ms <= 15) return 'good';
  if (ms <= 30) return 'fair';
  return 'poor';
}

function gradePacketLoss(pct) {
  if (pct === 0)    return 'excellent';
  if (pct <= 1)     return 'good';
  if (pct <= 3)     return 'fair';
  return 'poor';
}

function gradeDns(ms) {
  if (ms === 0)   return 'excellent'; // cached
  if (ms <= 20)   return 'excellent';
  if (ms <= 50)   return 'good';
  if (ms <= 100)  return 'fair';
  return 'poor';
}

function gradeConsistency(pct) {
  if (pct >= 95) return 'excellent';
  if (pct >= 85) return 'good';
  if (pct >= 70) return 'fair';
  return 'poor';
}

function computeScores(results) {
  const scores = {
    download:    gradeDownload(results.downloadMbps),
    upload:      gradeUpload(results.uploadMbps),
    latency:     gradeLatency(results.latencyMs),
    jitter:      gradeJitter(results.jitterMs),
    packetloss:  gradePacketLoss(results.packetLossPct),
    dns:         gradeDns(results.dnsMs),
    consistency: gradeConsistency(results.consistencyPct),
  };

  let totalWeight = 0;
  let weightedSum = 0;
  for (const [metric, weight] of Object.entries(SCORE_WEIGHTS)) {
    const grade = scores[metric];
    weightedSum += GRADE_POINTS[grade] * weight;
    totalWeight += weight;
  }

  const overallScore = Math.round(weightedSum / totalWeight);
  return { scores, overallScore };
}

/* ----------------------------------------------------------
   GRADE TAG HTML
   ---------------------------------------------------------- */

function gradeTagHtml(grade) {
  const map = {
    excellent: ['tag-green',  'Excellent'],
    good:      ['tag-blue',   'Bon'],
    fair:      ['tag-orange', 'Moyen'],
    poor:      ['tag-red',    'Faible'],
  };
  const [cls, label] = map[grade] || ['tag-white', '—'];
  return `<span class="tag ${cls}">${label}</span>`;
}

/* ----------------------------------------------------------
   SCORE RING COLOR
   ---------------------------------------------------------- */

function scoreColor(score) {
  if (score >= 80) return '#00AB8C'; // green
  if (score >= 60) return '#8CC8FF'; // blue
  if (score >= 35) return '#FF733C'; // orange
  return '#FF4545';                  // red
}

/* ----------------------------------------------------------
   TEST FUNCTIONS
   ---------------------------------------------------------- */

async function testLatency() {
  const SAMPLES = 20;
  const url = 'https://1.1.1.1/cdn-cgi/trace';
  const times = [];

  for (let i = 0; i < SAMPLES; i++) {
    if (state.aborted) throw new Error('aborted');
    const t0 = performance.now();
    try {
      await fetch(url + '?_=' + Date.now() + i, { cache: 'no-store' });
      times.push(performance.now() - t0);
    } catch {
      // count as high latency sample
      times.push(3000);
    }
    // Live update
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    setPhaseStatus('latency', 'active', Math.round(avg) + ' ms moy.');
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  // Jitter = std deviation
  const mean = avg;
  const variance = times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / times.length;
  const jitter = Math.sqrt(variance);

  return {
    latencyMs: Math.round(avg * 10) / 10,
    latencyMin: Math.round(min * 10) / 10,
    latencyMax: Math.round(max * 10) / 10,
    jitterMs: Math.round(jitter * 10) / 10,
    samples: times,
  };
}

async function testPacketLoss() {
  const PROBES = 30;
  const TIMEOUT_MS = 3000;
  const url = 'https://1.1.1.1/cdn-cgi/trace';
  let failed = 0;

  for (let i = 0; i < PROBES; i++) {
    if (state.aborted) throw new Error('aborted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await fetch(url + '?probe=' + i + '_' + Date.now(), {
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      failed++;
    } finally {
      clearTimeout(timer);
    }
    const lossPct = Math.round((failed / (i + 1)) * 1000) / 10;
    setPhaseStatus('packetloss', 'active', lossPct + '% perte');
  }

  return {
    packetLossPct: Math.round((failed / PROBES) * 1000) / 10,
    failedProbes: failed,
    totalProbes: PROBES,
  };
}

async function testDownload(sizeBytes, onProgress) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  const t0 = performance.now();
  let received = 0;

  try {
    const resp = await fetch(
      `https://speed.cloudflare.com/__down?bytes=${sizeBytes}&_=${Date.now()}`,
      { signal: controller.signal, cache: 'no-store' }
    );
    const reader = resp.body.getReader();

    while (true) {
      if (state.aborted) {
        reader.cancel();
        throw new Error('aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      const elapsed = (performance.now() - t0) / 1000;
      const mbps = (received * 8) / (elapsed * 1_000_000);
      if (onProgress) onProgress(mbps, received);
    }
  } finally {
    clearTimeout(timeout);
  }

  const elapsed = (performance.now() - t0) / 1000;
  return (received * 8) / (elapsed * 1_000_000);
}

async function uploadWithProgress(sizeBytes, onProgress) {
  const CHUNKS = 5;
  const chunkSize = Math.ceil(sizeBytes / CHUNKS);
  const data = new Uint8Array(chunkSize);
  crypto.getRandomValues(data.subarray(0, Math.min(65536, chunkSize)));

  const t0 = performance.now();
  let totalSent = 0;

  for (let i = 0; i < CHUNKS; i++) {
    if (state.aborted) throw new Error('aborted');
    const blob = new Blob([data], { type: 'text/plain' });
    await fetch(`https://speed.cloudflare.com/__up?_=${Date.now()}`, {
      method: 'POST',
      body: blob,
    });
    totalSent += chunkSize;
    const elapsed = (performance.now() - t0) / 1000;
    const mbps = (totalSent * 8) / (elapsed * 1_000_000);
    if (onProgress) onProgress(mbps, totalSent);
  }

  const elapsed = (performance.now() - t0) / 1000;
  return (totalSent * 8) / (elapsed * 1_000_000);
}

async function testDns() {
  // Load a unique URL and use PerformanceResourceTiming
  const uniqueUrl = `https://speed.cloudflare.com/favicon.ico?dns=${Date.now()}`;
  try {
    await fetch(uniqueUrl, { cache: 'no-store', mode: 'no-cors' });
  } catch { /* ignore */ }

  await new Promise(r => setTimeout(r, 100)); // let perf entries settle

  const entries = performance.getEntriesByType('resource');
  // Find our entry
  const entry = entries.slice().reverse().find(e => e.name.includes('speed.cloudflare.com'));

  if (entry && entry.domainLookupEnd && entry.domainLookupStart) {
    const dns = entry.domainLookupEnd - entry.domainLookupStart;
    return { dnsMs: Math.round(dns * 10) / 10, cached: dns < 1 };
  }
  // Fallback: try 1.1.1.1
  const fallbackUrl = `https://1.1.1.1/cdn-cgi/trace?dns=${Date.now()}`;
  try {
    await fetch(fallbackUrl, { cache: 'no-store' });
  } catch { /* ignore */ }

  await new Promise(r => setTimeout(r, 100));
  const entries2 = performance.getEntriesByType('resource');
  const entry2 = entries2.slice().reverse().find(e => e.name.includes('1.1.1.1'));

  if (entry2 && entry2.domainLookupEnd && entry2.domainLookupStart) {
    const dns = entry2.domainLookupEnd - entry2.domainLookupStart;
    return { dnsMs: Math.round(dns * 10) / 10, cached: dns < 1 };
  }

  return { dnsMs: 0, cached: true, unavailable: true };
}

async function testConsistency() {
  const SIZE = 5 * 1024 * 1024; // 5 MB
  const RUNS = 3;
  const speeds = [];

  for (let i = 0; i < RUNS; i++) {
    if (state.aborted) throw new Error('aborted');
    const mbps = await testDownload(SIZE, (liveMbps) => {
      setPhaseStatus('consistency', 'active', `Essai ${i + 1}/3 · ${liveMbps.toFixed(1)} Mbps`);
    });
    speeds.push(mbps);
  }

  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const variance = speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length;
  const cv = mean > 0 ? (Math.sqrt(variance) / mean) : 1;
  const consistencyPct = Math.max(0, Math.round((1 - cv) * 100));

  return { consistencyPct, runs: speeds };
}

async function fetchIspInfo() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch('https://ipinfo.io/json', {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    const data = await resp.json();
    // org is e.g. "AS12322 Free SAS" — strip the ASN prefix
    const org = data.org || '';
    const ispName = org.replace(/^AS\d+\s*/, '') || null;
    const publicIp = data.ip || null;
    const asnMatch = org.match(/^AS(\d+)/);
    const asn = asnMatch ? asnMatch[1] : null;

    // Try to get the upstream/transit operator (e.g. Orange France for ielo)
    let managerName = null;
    if (asn) {
      try {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 4000);
        const resp2 = await fetch(`https://api.bgpview.io/asn/${asn}/upstreams`, {
          signal: ctrl2.signal,
          cache: 'no-store',
        });
        clearTimeout(t2);
        const data2 = await resp2.json();
        const upstreams = data2?.data?.ipv4_upstreams || [];
        if (upstreams.length > 0) {
          const name = upstreams[0].description || upstreams[0].name || '';
          if (name && name.toLowerCase() !== ispName?.toLowerCase()) {
            managerName = name;
          }
        }
      } catch { /* ignore */ }
    }

    return { ispName, managerName, publicIp };
  } catch {
    return { ispName: null, managerName: null, publicIp: null };
  }
}

/* ----------------------------------------------------------
   MAIN TEST RUNNER
   ---------------------------------------------------------- */

async function runAllTests() {
  if (state.phase === 'testing') return;

  if (!validateEmployees()) return;

  state.officeName = document.getElementById('office-name').value.trim();
  state.employeeCount = getEmployeeCount();
  state.multiZone = document.getElementById('zone-toggle').checked;
  state.zoneUserCount = state.multiZone ? getZoneUserCount() : state.employeeCount;
  state.aborted = false;
  state.phase = 'testing';
  state.results = {};
  state.startTime = Date.now();

  const ispPromise = fetchIspInfo();

  buildPhaseList();
  showView('testing');

  const officeName = state.officeName || 'Analyse';
  document.getElementById('testing-office-name').textContent = officeName;

  const totalPhases = PHASES.length;

  for (let i = 0; i < PHASES.length; i++) {
    if (state.aborted) break;

    const phase = PHASES[i];
    setPhaseStatus(phase.id, 'active');
    setProgress((i / totalPhases) * 100);

    try {
      let result;

      if (phase.id === 'latency') {
        const r = await testLatency();
        state.results.latencyMs   = r.latencyMs;
        state.results.latencyMin  = r.latencyMin;
        state.results.latencyMax  = r.latencyMax;
        state.results._latencySamples = r.samples;
        setPhaseStatus('latency', 'done', r.latencyMs + ' ms');

      } else if (phase.id === 'jitter') {
        // Computed from latency samples — instant
        const samples = state.results._latencySamples || [];
        if (samples.length > 0) {
          const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
          const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
          state.results.jitterMs = Math.round(Math.sqrt(variance) * 10) / 10;
        } else {
          state.results.jitterMs = 0;
        }
        setPhaseStatus('jitter', 'done', state.results.jitterMs + ' ms');

      } else if (phase.id === 'packetloss') {
        result = await testPacketLoss();
        state.results.packetLossPct  = result.packetLossPct;
        state.results.failedProbes   = result.failedProbes;
        state.results.totalProbes    = result.totalProbes;
        setPhaseStatus('packetloss', 'done', result.packetLossPct + '%');

      } else if (phase.id === 'download') {
        const SIZE = 25 * 1024 * 1024; // 25 MB
        const mbps = await testDownload(SIZE, (liveMbps) => {
          setPhaseStatus('download', 'active', liveMbps.toFixed(1) + ' Mbps');
        });
        state.results.downloadMbps = Math.round(mbps * 10) / 10;
        setPhaseStatus('download', 'done', state.results.downloadMbps + ' Mbps');

      } else if (phase.id === 'upload') {
        const SIZE = 10 * 1024 * 1024; // 10 MB
        const mbps = await uploadWithProgress(SIZE, (liveMbps) => {
          setPhaseStatus('upload', 'active', liveMbps.toFixed(1) + ' Mbps');
        });
        state.results.uploadMbps = Math.round(mbps * 10) / 10;
        setPhaseStatus('upload', 'done', state.results.uploadMbps + ' Mbps');

      } else if (phase.id === 'dns') {
        result = await testDns();
        state.results.dnsMs        = result.dnsMs;
        state.results.dnsCached    = result.cached;
        state.results.dnsUnavail   = result.unavailable;
        const label = result.unavailable
          ? '—'
          : result.cached
          ? '<1 ms'
          : result.dnsMs + ' ms';
        setPhaseStatus('dns', 'done', label);

      } else if (phase.id === 'consistency') {
        result = await testConsistency();
        state.results.consistencyPct  = result.consistencyPct;
        state.results.consistencyRuns = result.runs;
        setPhaseStatus('consistency', 'done', result.consistencyPct + '%');

      } else if (phase.id === 'peremployee') {
        const effectiveCount = getEffectiveUserCount();
        const mbpsPerUser = state.results.downloadMbps / effectiveCount;
        state.results.mbpsPerEmployee = Math.round(mbpsPerUser * 100) / 100;
        state.results.effectiveUserCount = effectiveCount;
        setPhaseStatus('peremployee', 'done', state.results.mbpsPerEmployee + ' Mbps/util.');
      }

    } catch (err) {
      if (err.message === 'aborted' || state.aborted) {
        break;
      }
      // Mark as errored but continue
      console.error(`Phase ${phase.id} failed:`, err);
      setPhaseStatus(phase.id, 'error', 'erreur');
      // Set fallback values
      if (phase.id === 'latency')     { state.results.latencyMs = 999; state.results.jitterMs = 0; }
      if (phase.id === 'jitter')      { state.results.jitterMs = 0; }
      if (phase.id === 'packetloss')  { state.results.packetLossPct = 100; }
      if (phase.id === 'download')    { state.results.downloadMbps = 0; }
      if (phase.id === 'upload')      { state.results.uploadMbps = null; }
      if (phase.id === 'dns')         { state.results.dnsMs = 0; state.results.dnsUnavail = true; }
      if (phase.id === 'consistency') { state.results.consistencyPct = 0; }
      if (phase.id === 'peremployee') { state.results.mbpsPerEmployee = 0; }
    }
  }

  if (state.aborted) {
    state.phase = 'setup';
    showView('setup');
    return;
  }

  setProgress(100);
  state.phase = 'results';

  // Fill missing per-employee if download somehow skipped
  if (!state.results.mbpsPerEmployee && state.results.downloadMbps) {
    const effectiveCount = getEffectiveUserCount();
    state.results.mbpsPerEmployee = Math.round(
      (state.results.downloadMbps / effectiveCount) * 100
    ) / 100;
    state.results.effectiveUserCount = effectiveCount;
  }

  await new Promise(r => setTimeout(r, 400)); // brief pause for UX

  try {
    const isp = await ispPromise;
    state.results.ispName = isp.ispName;
    state.results.managerName = isp.managerName;
    state.results.publicIp = isp.publicIp;
  } catch {
    // ISP fetch failed silently — no impact on results
  }

  const { scores, overallScore } = computeScores(state.results);
  state.scores = scores;
  state.overallScore = overallScore;

  renderResults();
  showView('results');
}

/* ----------------------------------------------------------
   BUILD PHASE LIST DOM
   ---------------------------------------------------------- */

function buildPhaseList() {
  const list = document.getElementById('phase-list');
  list.innerHTML = PHASES.map(p => `
    <div class="phase-item" data-phase="${p.id}" data-status="waiting">
      <div class="phase-dot-wrap">
        <div class="phase-dot"></div>
      </div>
      <div class="phase-content">
        <div class="phase-header">
          <div class="phase-name">${p.name}</div>
          <div class="phase-value"></div>
        </div>
        <div class="phase-desc">${p.desc}</div>
      </div>
    </div>
  `).join('');
}

/* ----------------------------------------------------------
   RENDER RESULTS
   ---------------------------------------------------------- */

function renderResults() {
  const r = state.results;
  const s = state.scores;
  const elapsed = Math.round((Date.now() - state.startTime) / 1000);

  // Header
  const title = state.officeName ? `${state.officeName} — Résultats` : 'Résultats de l\'analyse';
  document.getElementById('results-title').textContent = title;

  const effectiveCount = r.effectiveUserCount || state.employeeCount;
  if (state.multiZone) {
    document.getElementById('results-meta').textContent =
      `${effectiveCount} util. dans la zone · ${state.employeeCount} dans le bureau`;
  } else {
    document.getElementById('results-meta').textContent =
      `${state.employeeCount} utilisateur${state.employeeCount !== 1 ? 's' : ''}`;
  }

  // Per-user section heading
  const peruserHeading = document.getElementById('peruser-heading');
  if (peruserHeading) {
    peruserHeading.textContent = state.multiZone
      ? `Bande passante par utilisateur — zone (${effectiveCount} personnes)`
      : 'Bande passante par utilisateur';
  }

  // ISP bar
  const ispBar = document.getElementById('isp-bar');
  if (r.ispName || r.managerName) {
    ispBar.style.display = '';
    ispBar.innerHTML = `
      ${r.ispName ? `
        <div class="isp-bar-item">
          <span class="isp-bar-label">Fournisseur</span>
          <span class="isp-bar-value">${r.ispName}</span>
        </div>
      ` : ''}
      ${r.ispName && r.managerName ? `<div class="isp-bar-sep"></div>` : ''}
      ${r.managerName ? `
        <div class="isp-bar-item">
          <span class="isp-bar-label">Opérateur réseau</span>
          <span class="isp-bar-value">${r.managerName}</span>
        </div>
      ` : ''}
      ${r.publicIp ? `<span class="isp-bar-ip">${r.publicIp}</span>` : ''}
    `;
  } else {
    ispBar.style.display = 'none';
  }

  // Metric cards
  const metricsGrid = document.getElementById('metrics-grid');
  metricsGrid.innerHTML = [
    {
      id: 'download',
      name: 'Téléchargement',
      value: r.downloadMbps != null ? r.downloadMbps.toFixed(1) + ' Mbps' : '—',
      grade: s.download,
      sub: r.downloadMbps != null ? gradeDownload(r.downloadMbps) === 'poor' ? 'En dessous du seuil de 20 Mbps' : '' : 'Test échoué',
    },
    {
      id: 'upload',
      name: 'Envoi',
      value: r.uploadMbps != null ? r.uploadMbps.toFixed(1) + ' Mbps' : '—',
      grade: s.upload,
      sub: '',
    },
    {
      id: 'latency',
      name: 'Latence (RTT)',
      value: r.latencyMs != null ? r.latencyMs + ' ms' : '—',
      grade: s.latency,
      sub: r.latencyMin != null
        ? `Min ${r.latencyMin} ms · Max ${r.latencyMax} ms`
        : '',
    },
    {
      id: 'jitter',
      name: 'Gigue',
      value: r.jitterMs != null ? r.jitterMs + ' ms' : '—',
      grade: s.jitter,
      sub: 'Écart-type de la latence',
    },
    {
      id: 'packetloss',
      name: 'Pertes de paquets',
      value: r.packetLossPct != null ? r.packetLossPct + '%' : '—',
      grade: s.packetloss,
      sub: r.failedProbes != null
        ? `${r.failedProbes} sur ${r.totalProbes} sondes perdues`
        : '',
    },
    {
      id: 'dns',
      name: 'Résolution DNS',
      value: r.dnsUnavail
        ? '—'
        : r.dnsCached
        ? '<1 ms'
        : r.dnsMs + ' ms',
      grade: s.dns,
      sub: r.dnsUnavail
        ? 'Indisponible (cross-origin)'
        : r.dnsCached
        ? 'Résultat en cache'
        : '',
    },
    {
      id: 'consistency',
      name: 'Consistance',
      value: r.consistencyPct != null ? r.consistencyPct + '%' : '—',
      grade: s.consistency,
      sub: r.consistencyRuns
        ? r.consistencyRuns.map(v => v.toFixed(1) + ' Mbps').join(' · ')
        : '',
    },
  ].map(m => `
    <div class="card-dark metric-card">
      <div class="metric-card-name">${m.name}</div>
      <div class="metric-card-value-row">
        <div class="metric-card-value">${m.value}</div>
        ${gradeTagHtml(m.grade)}
      </div>
      ${m.sub ? `<div class="metric-card-sub">${m.sub}</div>` : ''}
    </div>
  `).join('');

  // Per-employee card
  const mppu = r.mbpsPerEmployee || 0;
  const employeeCard = document.getElementById('employee-card');
  employeeCard.innerHTML = `
    <div class="employee-card-top">
      <div class="employee-mbps">${mppu.toFixed(2)}</div>
      <div class="employee-mbps-unit">Mbps / util.</div>
    </div>
    <div class="usecase-list">
      ${USE_CASES.map(uc => {
        const supported = mppu >= uc.threshold;
        return `
          <div class="usecase-row">
            <div>
              <div class="usecase-name">${uc.name}</div>
              <div class="usecase-threshold">${uc.label} requis</div>
            </div>
            <span class="tag ${supported ? 'tag-blue' : 'tag-red'}">
              ${supported ? 'SUPPORTÉ' : 'LIMITÉ'}
            </span>
          </div>
        `;
      }).join('')}
    </div>
    <div class="employee-summary">${employeeSummaryText(mppu, effectiveCount, state.multiZone)}</div>
  `;

  // Summary card
  const score = state.overallScore;
  const summaryCard = document.getElementById('summary-card');
  summaryCard.innerHTML = `
    <div class="score-ring-wrap">
      ${buildScoreRingSvg(score)}
    </div>
    <div class="summary-content">
      <h3 class="verdict-headline">${verdictHeadline(score, r, s)}</h3>
      <ul class="recommendations-list" id="recommendations-list">
        ${buildRecommendations(score, r, s).map(rec => `<li>${rec}</li>`).join('')}
      </ul>
    </div>
  `;

  // Animate ring after render
  requestAnimationFrame(() => {
    const fillEl = summaryCard.querySelector('.score-ring-fill');
    if (fillEl) {
      const circ = 2 * Math.PI * 52;
      const dashOffset = circ * (1 - score / 100);
      fillEl.style.strokeDashoffset = dashOffset;
      fillEl.style.stroke = scoreColor(score);
    }
  });

  // Timestamp
  const now = new Date();
  const duration = elapsed < 60
    ? `${elapsed}s`
    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  document.getElementById('results-timestamp').textContent =
    `Testé à ${now.toLocaleTimeString('fr-FR')} · Durée ${duration}`;
}

function buildScoreRingSvg(score) {
  const circ = 2 * Math.PI * 52;
  return `
    <svg class="score-svg" viewBox="0 0 120 120">
      <circle class="score-ring-track" cx="60" cy="60" r="52"/>
      <circle
        class="score-ring-fill"
        cx="60" cy="60" r="52"
        stroke-dasharray="${circ}"
        stroke-dashoffset="${circ}"
        stroke="${scoreColor(score)}"
      />
      <text class="score-number" x="60" y="60">${score}</text>
    </svg>
  `;
}

function verdictHeadline(score, results, scores) {
  if (score >= 85) return 'Connectivité excellente — votre bureau est bien équipé.';
  if (score >= 70) return 'Bonne connectivité avec quelques points d\'amélioration.';
  if (score >= 50) return 'Connectivité moyenne — certains utilisateurs peuvent rencontrer des limitations.';
  if (score >= 30) return 'Connectivité faible — des problèmes significatifs doivent être traités.';
  return 'Problèmes critiques de connectivité — une action immédiate est recommandée.';
}

function employeeSummaryText(mbpsPerUser, count, multiZone) {
  const context = multiZone
    ? `${count} utilisateurs dans votre zone WiFi`
    : `${count} utilisateurs simultanés`;
  if (mbpsPerUser >= 10) {
    return `Avec ${context}, chaque personne dispose de ${mbpsPerUser.toFixed(2)} Mbps — une marge confortable pour toutes les tâches.`;
  }
  if (mbpsPerUser >= 5) {
    return `Avec ${context}, chaque personne dispose de ${mbpsPerUser.toFixed(2)} Mbps — suffisant pour le travail standard, limité pour la vidéo intensive.`;
  }
  if (mbpsPerUser >= 2) {
    return `Avec ${context}, chaque personne dispose de ${mbpsPerUser.toFixed(2)} Mbps — adapté aux appels vidéo, serré pour les tâches gourmandes en données.`;
  }
  if (mbpsPerUser >= 0.1) {
    return `Avec ${context}, chaque personne dispose de ${mbpsPerUser.toFixed(2)} Mbps — seule la communication de base est supportée. Une mise à niveau est conseillée.`;
  }
  return `Avec ${context}, la bande passante par personne est critiquement basse. Une mise à niveau significative est nécessaire.`;
}

function buildRecommendations(score, results, scores) {
  const recs = [];

  if (scores.download === 'poor') {
    recs.push('La vitesse de téléchargement est inférieure à 20 Mbps — contactez votre FAI ou changez votre offre internet.');
  } else if (scores.download === 'fair') {
    recs.push('La vitesse de téléchargement est modérée — envisagez une offre supérieure pour un usage intensif.');
  }

  if (scores.upload === 'poor') {
    recs.push('La vitesse d\'envoi est très faible — les visioconférences et transferts de fichiers volumineux seront affectés.');
  } else if (scores.upload === 'fair') {
    recs.push('La vitesse d\'envoi est limitée — les visioconférences avec plusieurs participants peuvent être perturbées.');
  }

  if (scores.latency === 'poor') {
    recs.push('Latence élevée détectée — vérifiez la congestion réseau ou privilégiez une connexion filaire plutôt que le WiFi.');
  } else if (scores.latency === 'fair') {
    recs.push('La latence est élevée — les applications temps réel comme la VoIP peuvent être occasionnellement affectées.');
  }

  if (scores.jitter === 'poor' || scores.jitter === 'fair') {
    recs.push('Une gigue élevée indique une instabilité réseau — cela provoque souvent des coupures audio/vidéo lors des appels.');
  }

  if (scores.packetloss === 'poor') {
    recs.push('Des pertes de paquets importantes ont été détectées — vérifiez les câbles, le firmware du routeur et le signal WiFi.');
  } else if (scores.packetloss === 'fair') {
    recs.push('Des pertes de paquets occasionnelles — vérifiez l\'emplacement du routeur et réduisez les sources d\'interférence.');
  }

  if (scores.consistency === 'poor') {
    recs.push('La vitesse est très instable — votre connexion est peut-être bridée ou subit une congestion.');
  } else if (scores.consistency === 'fair') {
    recs.push('La vitesse fluctue — envisagez une ligne internet dédiée pour des performances plus prévisibles.');
  }

  if (results.mbpsPerEmployee < 2 && results.downloadMbps > 0) {
    const zoneCtx = state.multiZone
      ? ` (${results.effectiveUserCount} utilisateurs dans la zone)`
      : '';
    recs.push(`À ${results.mbpsPerEmployee.toFixed(2)} Mbps par utilisateur${zoneCtx}, la visioconférence sera difficile — augmentez la bande passante ou réduisez le nombre d'utilisateurs simultanés.`);
  }

  if (recs.length === 0) {
    recs.push('Votre connexion est performante sur toutes les métriques — aucune action immédiate requise.');
    if (score >= 90) {
      recs.push('Maintenez votre configuration actuelle et retestez après tout changement d\'infrastructure.');
    }
  }

  return recs;
}

/* ----------------------------------------------------------
   CONTROLS & EVENT LISTENERS
   ---------------------------------------------------------- */

function setupControls() {
  // Employee count ↔ slider sync
  const countInput = document.getElementById('employee-count');
  const slider = document.getElementById('employee-slider');
  const decBtn = document.getElementById('employee-dec');
  const incBtn = document.getElementById('employee-inc');

  countInput.addEventListener('input', () => {
    const val = parseInt(countInput.value, 10);
    if (!isNaN(val) && val >= 1 && val <= 500) {
      slider.value = val;
    }
    validateEmployees();
  });

  slider.addEventListener('input', () => {
    countInput.value = slider.value;
    validateEmployees();
  });

  decBtn.addEventListener('click', () => {
    const val = Math.max(1, (parseInt(countInput.value, 10) || 1) - 1);
    countInput.value = val;
    slider.value = val;
    validateEmployees();
  });

  incBtn.addEventListener('click', () => {
    const val = Math.min(500, (parseInt(countInput.value, 10) || 1) + 1);
    countInput.value = val;
    slider.value = val;
    validateEmployees();
  });

  // Zone toggle + zone stepper
  const zoneToggle = document.getElementById('zone-toggle');
  const zoneSection = document.getElementById('zone-section');
  const zoneCountInput = document.getElementById('zone-count');
  const zoneSlider = document.getElementById('zone-slider');
  const zoneDecBtn = document.getElementById('zone-dec');
  const zoneIncBtn = document.getElementById('zone-inc');

  zoneToggle.addEventListener('change', () => {
    state.multiZone = zoneToggle.checked;
    if (state.multiZone) {
      zoneSection.classList.add('visible');
    } else {
      zoneSection.classList.remove('visible');
      // Clear zone error when hiding
      document.getElementById('zone-count').classList.remove('error');
      document.getElementById('zone-error').classList.remove('visible');
    }
  });

  zoneCountInput.addEventListener('input', () => {
    const val = parseInt(zoneCountInput.value, 10);
    if (!isNaN(val) && val >= 1 && val <= 500) {
      zoneSlider.value = val;
    }
    if (state.multiZone) validateEmployees();
  });

  zoneSlider.addEventListener('input', () => {
    zoneCountInput.value = zoneSlider.value;
    if (state.multiZone) validateEmployees();
  });

  zoneDecBtn.addEventListener('click', () => {
    const val = Math.max(1, (parseInt(zoneCountInput.value, 10) || 1) - 1);
    zoneCountInput.value = val;
    zoneSlider.value = val;
    if (state.multiZone) validateEmployees();
  });

  zoneIncBtn.addEventListener('click', () => {
    const val = Math.min(500, (parseInt(zoneCountInput.value, 10) || 1) + 1);
    zoneCountInput.value = val;
    zoneSlider.value = val;
    if (state.multiZone) validateEmployees();
  });

  // Run button
  document.getElementById('run-btn').addEventListener('click', () => {
    runAllTests();
  });

  // Cancel button
  document.getElementById('cancel-btn').addEventListener('click', () => {
    state.aborted = true;
    // If still mid-test, the loop will notice and call showView('setup')
    // Belt-and-suspenders fallback:
    setTimeout(() => {
      if (state.phase === 'testing') {
        state.phase = 'setup';
        showView('setup');
      }
    }, 500);
  });

  // Run again button
  document.getElementById('run-again-btn').addEventListener('click', () => {
    state.phase = 'setup';
    showView('setup');
    // Pre-populate with previous values (already in inputs)
  });

  // Allow Enter key on office name input to start test
  document.getElementById('office-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAllTests();
  });
}

/* ----------------------------------------------------------
   INIT
   ---------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  setupControls();
  showView('setup');
});
