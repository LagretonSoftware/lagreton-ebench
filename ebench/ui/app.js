import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';

const HASH = new URLSearchParams(location.hash.slice(1));
const KEY = HASH.get('k') || '';
// In the Mac window the real traffic lights sit inside the header, so it leaves room for them.
const IN_WINDOW = HASH.has('window');
// Red only while eBench works on a board; green for connected, on board, all good.
const ACCENT = '#FF5A47';
const LIVE = '#5BE3A5';
const TABS = ['Overview', 'Library', 'My boards', 'Log'];

async function api(path, opts = {}) {
  const r = await fetch('/api/' + path, { ...opts, headers: { 'X-eBench-Key': KEY } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `The engine answered ${r.status}.`);
  return body;
}

const Strip = ({ ink, busy, inset = 30 }) => html`
  <div aria-hidden="true" style=${`position: absolute; left: ${inset}px; right: ${inset}px; top: 0; height: 2px; overflow: hidden; background: rgba(255,255,255,0.12)`}>
    <div class=${busy ? 'k-flicker' : 'k-breathe'} style=${`position: absolute; inset: 0; background: ${ink}; box-shadow: 0 0 18px 2px ${ink}`}></div>
  </div>`;

const mb = (n) => (n / 2 ** 20).toFixed(2).replace(/\.?0+$/, '') + ' MB';
const boardName = (b) => b.name || b.chip || 'ESP board';
const size = (n) => (n >= 2 ** 20 ? mb(n) : `${Math.round(n / 1024)} KB`);
const dayMonth = (iso) => new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const fwLabel = (fw) => (fw ? `${fw.project} ${fw.version}` : 'Unknown firmware');
const fits = (f) => !(f.checks || []).some((c) => !c.ok && !c.note);
const libStatus = (f) => (f.onBoard ? ['On board', LIVE] : fits(f) ? ['Ready', 'var(--faint)'] : [`For ${f.chip}`, 'var(--faint)']);
const libSub = (f) => [f.project, f.imported && `imported ${dayMonth(f.imported)}`].filter(Boolean).join(' · ');

function FirmwareAction({ f, b, onNote, style = '' }) {
  const on = f.onBoard;
  const base = 'position: relative; overflow: hidden; height: 32px; border-radius: 999px; border: 0; font-weight: 600; font-size: 13px; padding: 0 16px;';
  const quiet = 'background: rgba(255,255,255,0.10); color: var(--muted); box-shadow: inset 0 1px 0 rgba(255,255,255,0.2)';
  const loud = 'background: #FFFFFF; color: #1A1A1D; box-shadow: inset 0 -1px 0 rgba(0,0,0,0.08), 0 10px 26px rgba(0,0,0,0.3)';
  const sw = b.job && b.job.kind === 'switch' && b.job;
  if (sw) {
    return html`<button disabled style=${`${base} background: rgba(255,255,255,0.14); color: var(--ink); ${style}`}>
      <span class="k-fill" aria-hidden="true" style=${`position: absolute; left: 0; top: 0; bottom: 0; width: ${sw.phase === 'flash' ? sw.pct : sw.phase === 'check' ? 100 : 0}%; background: ${ACCENT}; opacity: 0.55`}></span>
      <span style="position: relative">${sw.phase === 'flash' ? `${sw.label} · ${sw.pct}%` : sw.label}</span></button>`;
  }
  if (on) return html`<button disabled style=${`${base} ${quiet}; ${style}`}>${f.name} is on the board</button>`;
  const bad = !fits(f);
  const go = () => api(`switch/${b.port}?id=${encodeURIComponent(f.id)}`, { method: 'POST' }).catch((e) => onNote(e.message));
  return html`<button onClick=${go} disabled=${bad} style=${`${base} ${bad ? quiet : loud}; ${style}`}>${bad ? "Doesn't fit this board" : `Switch to ${f.name}`}</button>`;
}
const COLORS = { data: '#FFFFFF', alloc: 'rgba(255,255,255,0.28)', free: 'rgba(255,255,255,0.10)' };

// 128 bars across the whole flash: data, allocated but empty, or unassigned.
function barsFor(flash, regions) {
  const per = flash / 128;
  const overlaps = (a, z, off, len) => len > 0 && off < z && off + len > a;
  return Array.from({ length: 128 }, (_, i) => {
    const a = i * per, z = a + per;
    if (regions.some((r) => overlaps(a, z, r.offset, r.used))) return COLORS.data;
    if (regions.some((r) => overlaps(a, z, r.offset, r.size))) return COLORS.alloc;
    return COLORS.free;
  });
}

const Icon = ({ d, size = 16, sw = 1.75 }) => html`
  <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${sw}
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d.map((p) => html`<path d=${p} />`)}</svg>`;
const I = {
  plus: ['M12 5v14M5 12h14'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5'],
  shield: ['M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z', 'M9 12l2 2 4-4'],
  pause: ['M9 6v12M15 6v12'],
  copy: ['M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2', 'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z'],
  lock: ['M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlock: ['M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z', 'M8 11V8a4 4 0 0 1 7.5-2'],
  usb: ['M12 3v13', 'M8.5 6.5L12 3l3.5 3.5', 'M7 11v2l5 3 5-3v-2', 'M12 16v2.5', 'M10 21h4'],
  info: ['M12 11v5', 'M12 8h.01', 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17z'],
  back: ['M15 6l-6 6 6 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
};

function Header({ title, tab, setTab }) {
  return html`
    <header class="k-glass pywebview-drag-region" style=${`flex: 0 0 auto; position: relative; height: 40px; box-sizing: border-box; margin: 6px 10px 0; display: flex; align-items: center; padding: 0 4px 0 ${IN_WINDOW ? 76 : 20}px; border-radius: 999px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 18px 40px rgba(0,0,0,0.3)`}>
      <div class="pywebview-drag-region" style="flex: 1 1 0; min-width: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${title}</div>
      <div role="tablist" aria-label="Views" style="position: relative; display: flex; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.18); box-shadow: inset 0 1px 2px rgba(0,0,0,0.25)">
        <span aria-hidden="true" class="k-thumb" style=${`position: absolute; top: 3px; bottom: 3px; left: ${3 + tab * 92}px; width: 92px; border-radius: 999px; background: rgba(255,255,255,0.24); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 14px rgba(0,0,0,0.25)`}></span>
        ${TABS.map((label, i) => html`
          <button role="tab" aria-selected=${String(tab === i)} onClick=${() => setTab(i)}
            style=${`position: relative; width: 92px; height: 26px; border: 0; border-radius: 999px; background: transparent; font-size: 13px; font-weight: 500; color: ${tab === i ? 'var(--ink)' : 'var(--muted)'}`}>${label}</button>`)}
      </div>
      <div class="pywebview-drag-region" style="flex: 1 1 0; min-width: 0; display: flex; justify-content: flex-end">
        <button class="k-btn" onClick=${() => setTab(1)} style="height: 32px"><${Icon} d=${I.plus} size=${14} sw=${2} /> Import</button>
      </div>
    </header>`;
}

function DeviceRow({ b, current, onClick }) {
  const dot = b.status === 'error' ? 'var(--warn)' : b.job ? ACCENT : LIVE;
  return html`
    <button class="k-side" aria-current=${String(current)} onClick=${onClick}
      style=${`display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-radius: 16px; text-align: left; ${current ? 'background: rgba(255,255,255,0.16); box-shadow: inset 0 1px 0 rgba(255,255,255,0.3)' : 'background: transparent'}`}>
      <span class=${b.status === 'reading' || b.job ? 'k-flicker' : 'k-breathe'} aria-hidden="true" style=${`width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: ${dot}; box-shadow: 0 0 10px ${dot}`}></span>
      <span style="min-width: 0">
        <span style="display: block; font-weight: 500">${b.status === 'ready' ? (b.new ? `New ${b.chip}` : boardName(b)) : b.status === 'reading' ? 'Reading…' : 'Needs attention'}</span>
        <span class="k-mono" style="display: block; margin-top: 2px; font-size: 11px; color: var(--muted)">${b.port}</span>
      </span>
    </button>`;
}

function Sidebar({ boards, profiles, current, setPort, library, sel, pick, openImport }) {
  const kept = profiles.reduce((n, p) => n + p.saves.reduce((m, x) => m + x.size, 0), 0);
  return html`
    <aside aria-label="Sidebar" class="k-glass" style="flex: 0 0 200px; margin-bottom: 10px; overflow-y: auto; box-sizing: border-box; background: linear-gradient(180deg, rgba(255,255,255,0.13), rgba(255,255,255,0.05)); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px">
      <div style="padding: 4px 12px 6px; font-size: 12px; font-weight: 600; color: var(--faint)">Plugged in</div>
      ${boards.length ? boards.map((b) => html`<${DeviceRow} b=${b} current=${b === current} onClick=${() => setPort(b.port)} />`)
        : html`<div class="k-cap" style="padding: 4px 12px">None plugged in</div>`}
      <div style="padding: 16px 12px 6px; font-size: 12px; font-weight: 600; color: var(--faint)">Library</div>
      ${library.map((f) => html`
        <button class="k-side" onClick=${() => pick(f.id)} style=${`display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; border: 0; border-radius: 16px; text-align: left; background: ${sel === f.id ? 'rgba(255,255,255,0.12)' : 'transparent'}`}>
          <span aria-hidden="true" class="k-doto" style="width: 24px; height: 24px; flex: 0 0 auto; border-radius: 8px; background: rgba(255,255,255,0.12); box-shadow: inset 0 1px 0 rgba(255,255,255,0.25); display: grid; place-items: center; font-size: 10px">${f.mono}</span>
          <span style="flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${f.name}</span>
          <span class="k-cap">${f.ver}</span>
        </button>`)}
      ${!library.length && html`
        <button class="k-side" onClick=${openImport} style="display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; border: 0; border-radius: 16px; background: transparent; text-align: left; color: var(--muted)">
          <span aria-hidden="true" style="width: 24px; height: 24px; flex: 0 0 auto; border-radius: 8px; border: 1px dashed rgba(255,255,255,0.35)"></span>
          Import firmware
        </button>`}
      <div style="flex: 1 1 auto; min-height: 16px"></div>
      <div class="k-well" style="padding: 14px">
        <div style="font-weight: 600; font-size: 13px">${profiles.length} ${profiles.length === 1 ? 'board' : 'boards'}</div>
        <div style="margin-top: 2px; font-size: 12px; color: var(--muted)">${size(kept)} of saves on this Mac, never uploaded.</div>
      </div>
    </aside>`;
}

function Settings({ settings, cls = 'k-well', style = '' }) {
  let ns = null;
  return html`
    <div class=${cls} style=${`flex: 1 1 0; min-height: 150px; display: flex; flex-direction: column; overflow: hidden; ${style}`}>
      <div style="display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px 6px">
        <h2 style="font-size: 13px; font-weight: 600">Settings</h2>
        <span class="k-cap">${settings.length} in nvs</span>
      </div>
      <div class="k-mono" style="flex: 1 1 auto; overflow-y: auto; padding: 0 16px 12px; font-size: 12px; line-height: 1.5">
        ${settings.length === 0 && html`<p class="k-cap" style="font-family: Geist, sans-serif; padding-top: 6px">No settings stored on this board.</p>`}
        ${settings.map((s) => {
          const head = s.ns !== ns && (ns = s.ns);
          return html`
            ${head && html`<div style="padding: 10px 0 4px; color: var(--faint); font-family: Geist, sans-serif; font-size: 11px; font-weight: 600">${s.ns}</div>`}
            <div style="display: flex; gap: 12px; padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.08)">
              <span style="flex: 0 0 auto; min-width: 128px; color: var(--muted)">${s.key}</span>
              <span title=${s.value} style="flex: 1 1 auto; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${s.value}</span>
            </div>`;
        })}
      </div>
    </div>`;
}

function BoardStrip({ b }) {
  const r = b.running;
  const spec = [b.model || b.chip, `rev ${b.rev}`, `${mb(b.flash)} flash`, b.psram && `${b.psram} PSRAM`].filter(Boolean).join(' · ');
  return html`
    <section aria-label="Connected board" class="k-glass" style="position: relative; overflow: hidden; padding: 12px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px">
      <${Strip} ink=${b.job ? ACCENT : LIVE} busy=${!!b.job} inset=${20} />
      <h1 class="k-doto" style="font-size: 30px; line-height: 1">${boardName(b)}</h1>
      <div style="flex: 1 1 260px; min-width: 0">
        <div style="color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${spec}</div>
        <div class="k-mono" style="margin-top: 2px; font-size: 11px; color: var(--faint)">${b.mac} · ${b.port} · ${b.usb}</div>
      </div>
      <span class="k-chip" title=${r ? `${r.project} · built ${r.date}` : ''} style="color: var(--ink)">
        <span aria-hidden="true" style=${`width: 6px; height: 6px; border-radius: 50%; background: ${r ? LIVE : 'var(--warn)'}`}></span>
        ${r ? fwLabel(r) : 'No firmware'}${r && html`<span class="k-lab">${r.slot} · IDF ${r.idf.replace(/^v/, '')}</span>`}
      </span>
      <${ShareButton} b=${b} />
      <button class="k-btn k-sm" onClick=${() => api('restart/' + b.port, { method: 'POST' })} disabled=${!!b.job || b.share}
        title=${b.share ? 'Take the port back to restart from here' : ''}><${Icon} d=${I.refresh} size=${12} sw=${2} /> Restart</button>
    </section>`;
}

// Free the board's port for another app, or take it back for the live log.
function ShareButton({ b }) {
  return html`
    <button class="k-btn k-sm" aria-pressed=${String(!!b.share)} onClick=${() => api(`share/${b.mac}?on=${b.share ? 0 : 1}`, { method: 'POST' })}
      title=${b.share ? 'The live log is off so another app can open this port' : 'Let another app open this port'}
      style=${b.share ? 'background: rgba(255,255,255,0.22); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35)' : ''}>
      <${Icon} d=${['M8 7h11', 'M15 3l4 4-4 4', 'M16 17H5', 'M9 13l-4 4 4 4']} size=${12} sw=${2} /> ${b.share ? 'Port shared' : 'Share port'}
    </button>`;
}

function Stats({ b }) {
  const end = Math.max(...b.regions.map((r) => r.offset + r.size));
  const last = b.saves[0];
  const cards = [
    ['Flash', mb(b.flash), end < b.flash ? `${mb(b.flash - end)} unassigned` : 'all assigned'],
    ['PSRAM', b.psram || 'None', b.psram ? 'on the module' : 'not on this module'],
    ['Settings', String(b.settings.length), b.nvs ? `in nvs · ${size(b.nvs.size)}` : 'no settings area'],
    ['Saves', String(b.saves.length), last ? `last ${dayMonth(last.created)} · ${last.created.slice(11, 16)}` : 'none yet'],
  ];
  return html`
    <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px">
      ${cards.map(([label, value, sub]) => html`
        <section class="k-glass" style="padding: 10px 14px; border-radius: 16px">
          <div class="k-lab">${label}</div>
          <div class="k-doto" style="margin-top: 6px; font-size: 20px; line-height: 1">${value}</div>
          <div class="k-lab" style="margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${sub}</div>
        </section>`)}
    </div>`;
}

function LibraryPanel({ b, library: all, fromName, sel, pick, goLibrary }) {
  const [note, setNote] = useState('');
  const library = all.filter(fits);
  const to = library.find((f) => f.id === sel) || library[0];
  const same = to && to.onBoard;
  const sw = b.job && b.job.kind === 'switch' ? b.job : null;
  const target = sw ? sw.target : to ? to.name : 'firmware';
  const steps = [`Save ${fromName} settings`, `Scan ${target}`, `Flash ${target}`, 'Check switches'];
  const phaseAt = sw ? ['save', 'scan', 'flash', 'check'].indexOf(sw.phase) : -1;
  const last = !sw && b.lastJob && b.lastJob.kind === 'switch' ? b.lastJob : null;
  const live = sw && ({
    save: `Copying the ${fromName} settings off the board.`,
    scan: `Checking ${target} for code that flips lockout switches.`,
    flash: `Writing ${target} · ${sw.pct}%`,
    check: 'Board restarted. Reading it again to check the security switches.',
  })[sw.phase];
  useEffect(() => setNote(''), [sel]);
  return html`
    <section aria-label="Library" class="k-glass" style="min-width: 0; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px">
      <div style="display: flex; align-items: center; justify-content: space-between">
        <h2 class="k-h3">Library</h2>
      </div>
      ${library.map((f) => {
        const on = f.id === to.id;
        const [status, ink] = libStatus(f);
        return html`
          <button class="k-card" onClick=${() => pick(f.id)} aria-pressed=${String(on)}
            style=${`display: flex; align-items: center; gap: 12px; padding: 7px 10px; border-radius: 14px; border: 1px solid; text-align: left; ${on
              ? 'transform: translateY(-2px) scale(1.01); border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 14px 30px rgba(0,0,0,0.28)'
              : 'border-color: rgba(255,255,255,0.10); background: rgba(255,255,255,0.04)'}`}>
            <span aria-hidden="true" class="k-doto" style="width: 28px; height: 28px; flex: 0 0 auto; border-radius: 9px; background: rgba(255,255,255,0.10); box-shadow: inset 0 1px 0 rgba(255,255,255,0.22); display: grid; place-items: center; font-size: 12px">${f.mono}</span>
            <span style="flex: 1 1 auto; min-width: 0">
              <span style="display: block; font-weight: 500">${f.name} ${f.ver}</span>
              <span class="k-cap" style="display: block; margin-top: 2px">${libSub(f)}</span>
            </span>
            <span style=${`font-size: 12px; color: ${ink}`}>${status}</span>
          </button>`;
      })}
      <button class="k-card" onClick=${goLibrary} style="display: flex; align-items: center; gap: 12px; padding: 7px 10px; border-radius: 14px; border: 1px dashed rgba(255,255,255,0.28); background: transparent; text-align: left; color: var(--muted)">
        <span aria-hidden="true" style="width: 28px; height: 28px; flex: 0 0 auto; display: grid; place-items: center"><${Icon} d=${I.plus} size=${16} /></span>
        Import .bin, .zip or build folder
      </button>
      <div style="flex: 1 1 auto"></div>
      ${to && html`<${FirmwareAction} f=${to} b=${b} onNote=${setNote} />
      <ol aria-label="Switch steps" style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px">
        ${steps.map((label, i) => html`
          <li style="display: flex; flex-direction: column; gap: 6px">
            <span aria-hidden="true" style=${`height: 3px; border-radius: 3px; transition: background .3s; background: ${i < phaseAt ? '#FFFFFF' : i === phaseAt ? ACCENT : 'rgba(255,255,255,0.18)'}`}></span>
            <span style=${`font-size: 11px; line-height: 1.3; color: ${i <= phaseAt ? 'var(--ink)' : 'var(--faint)'}`}>${label}</span>
          </li>`)}
      </ol>`}
      <p aria-live="polite" style=${`font-size: 12px; color: ${note || (last && !last.ok) ? 'var(--warn)' : 'var(--muted)'}`}>
        ${live || note || (last && last.msg) || (!to ? 'Import firmware to switch this board to it.' : same ? 'Pick another firmware to switch.' : `First the ${fromName} settings are saved, then ${to.name} is scanned before anything is written.`)}
      </p>
    </section>`;
}

function FlashMap({ b }) {
  const { flash, regions } = b;
  const per = flash / 128;
  const sw = b.job && b.job.kind === 'switch' && b.job.phase === 'flash' && b.job;
  // While a switch writes, the bars it has reached so far light up in the accent.
  const bars = barsFor(flash, regions).map((c, i) => (sw && (i + 1) * per <= sw.end * sw.pct / 100 ? ACCENT : c));
  const end = Math.max(...regions.map((r) => r.offset + r.size));
  const labels = regions.filter((r) => 'app' in r)
    .map((r) => ({ at: r.offset, text: `${r.name} · ${mb(r.size)} · ${r.app || 'empty'}` }))
    .concat(end < flash ? [{ at: end, text: `Unassigned · ${mb(flash - end)}` }] : []);
  return html`
    <section aria-label="Flash map" class="k-glass" style="padding: 12px 16px 8px">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px">
        <h2 class="k-h3">Flash · ${mb(flash)}</h2>
        <div class="k-cap" style="display: flex; gap: 12px; flex-wrap: wrap">
          ${[['#FFFFFF', 'Data'], ['rgba(255,255,255,0.28)', 'Allocated, empty'], ['rgba(255,255,255,0.10)', 'Unassigned']].map(([c, t]) => html`
            <span style="display: flex; align-items: center; gap: 6px"><span aria-hidden="true" style=${`width: 8px; height: 8px; border-radius: 2px; background: ${c}`}></span>${t}</span>`)}
          <span>Each bar is ${per / 1024} KB</span>
        </div>
      </div>
      <div role="img" aria-label=${'Flash map: ' + labels.map((l) => l.text).join(', ')} style="height: 34px; display: flex; gap: 2px">
        ${bars.map((c) => html`<span class="k-bar" style=${`flex: 1 1 0; min-width: 1px; border-radius: 3px; background: ${c}`}></span>`)}
      </div>
      <div style="position: relative; height: 30px; margin-top: 6px; font-size: 11px; color: var(--muted)">
        <span class="k-mono" style="position: absolute; left: 0; top: 0">0x0</span>
        ${labels.map((l, i) => html`
          <span style=${`position: absolute; left: ${(l.at / flash) * 100}%; top: ${i % 2 ? 0 : 14}px; border-left: 1px solid rgba(255,255,255,0.3); padding-left: 6px; white-space: nowrap`}>${l.text}</span>`)}
        <span class="k-mono" style="position: absolute; right: 0; top: 0">0x${flash.toString(16).toUpperCase()}</span>
      </div>
    </section>`;
}

const LEVEL_INK = { W: 'var(--warn)', E: '#FF8A80' };
const lineText = (l) => `${l.t} ${l.lvl || '-'} ${l.tag ? l.tag + ': ' : ''}${l.msg}`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// Keep a log pinned to its newest line, unless the reader has scrolled up to look at something.
function useStickToBottom(dep) {
  const ref = useRef(null);
  const stick = useRef(true);
  useEffect(() => { if (ref.current && stick.current) ref.current.scrollTop = ref.current.scrollHeight; }, [dep]);
  const onScroll = (e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  return [ref, onScroll];
}

function LogLine({ l, tagWidth = 96 }) {
  return html`
    <div class="k-line" style=${`display: flex; gap: 12px; color: ${LEVEL_INK[l.lvl] || (l.src === 'lab' ? 'var(--ink)' : '#F2F2F7')}`}>
      <span title=${l.ms != null ? `${l.ms} ms since boot` : ''} style="flex: 0 0 64px; color: #AEAEB2">${l.t}</span>
      <span style=${`flex: 0 0 ${tagWidth}px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: ${l.src === 'lab' ? 'var(--ink)' : 'var(--faint)'}; font-weight: ${l.src === 'lab' ? 600 : 400}`}>${l.tag}</span>
      <span style="min-width: 0; overflow-wrap: anywhere">${l.msg}</span>
    </div>`;
}

function PauseButton({ log }) {
  return html`
    <button class="k-icon" onClick=${log.togglePause} aria-label=${log.paused ? 'Resume log' : 'Pause log'}>
      ${log.paused ? html`<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>` : html`<${Icon} d=${I.pause} />`}
    </button>`;
}

function Shared({ b }) {
  return b && b.share && html`
    <div style="margin: 0 18px 8px 24px; align-self: flex-start; display: inline-flex; align-items: center; gap: 10px; min-height: 26px; padding: 0 4px 0 12px; border-radius: 999px; background: rgba(255,255,255,0.08); color: var(--muted); font-size: 12px">
      Port shared with other apps · the live log is off
      <button class="k-btn k-sm" onClick=${() => api(`share/${b.mac}?on=0`, { method: 'POST' })} style="height: 22px; padding: 0 10px; font-size: 11px">Take it back</button>
    </div>`;
}

function Held({ log }) {
  return log.paused && html`
    <div style="margin: 0 18px 8px 24px; align-self: flex-start; display: inline-flex; align-items: center; height: 26px; padding: 0 12px; border-radius: 999px; background: rgba(255,194,77,0.14); color: var(--warn); font-size: 12px">
      Paused · ${log.held} new ${log.held === 1 ? 'line' : 'lines'} held until you resume
    </div>`;
}

function LiveLog({ b, log }) {
  const lines = log.lines.slice(-200);
  const [ref, onScroll] = useStickToBottom(lines.length && lines[lines.length - 1].n);
  return html`
    <section aria-label="Live log" class="k-glass k-dark" style="flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; display: flex; flex-direction: column">
      <div aria-hidden="true" class=${log.paused ? 'k-breathe' : 'k-flicker'} style=${`position: absolute; left: 0; top: 28px; bottom: 28px; width: 2px; background: ${LIVE}; box-shadow: 0 0 14px 1px ${LIVE}`}></div>
      <div style="display: flex; align-items: center; gap: 12px; padding: 10px 12px 6px 20px">
        <h2 class="k-h3">Live log</h2>
        <span class="k-cap">115200 baud · USB</span>
        <div style="margin-left: auto; display: flex; gap: 4px">
          <${PauseButton} log=${log} />
          <button class="k-icon" aria-label="Copy log" onClick=${() => copyText(lines.map(lineText).join('\n'))}><${Icon} d=${I.copy} /></button>
        </div>
      </div>
      <${Shared} b=${b} />
      <${Held} log=${log} />
      <div ref=${ref} onScroll=${onScroll} class="k-mono" style="flex: 1 1 auto; height: 170px; overflow-y: auto; padding: 0 16px 12px 20px; font-size: 11.5px; line-height: 1.7">
        ${lines.length ? lines.map((l) => html`<${LogLine} key=${l.n} l=${l} />`)
          : html`<p class="k-cap" style="font-family: Geist, sans-serif">Waiting for the board to say something…</p>`}
      </div>
    </section>`;
}

const FILTERS = [['all', 'All'], ['board', 'Board'], ['lab', 'eBench'], ['warn', 'Warnings']];

function LogView({ b, log }) {
  const [filter, setFilter] = useState('all');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const q = text.trim().toLowerCase();
  const shown = log.lines.filter((l) => (filter === 'all' || (filter === 'warn' ? l.lvl === 'W' || l.lvl === 'E' : l.src === filter))
    && (!q || `${l.tag} ${l.msg}`.toLowerCase().includes(q))).slice(-1000);
  const warns = shown.filter((l) => l.lvl === 'W' || l.lvl === 'E').length;
  const [ref, onScroll] = useStickToBottom(shown.length && shown[shown.length - 1].n);
  const act = (path, done) => api(path + '/' + b.port, { method: 'POST' }).then(done).catch((e) => setNote(e.message));
  return html`
    <section aria-label="Live log" class="k-glass k-dark k-view" style="min-height: 100%; box-sizing: border-box; position: relative; overflow: hidden; display: flex; flex-direction: column">
      <div aria-hidden="true" class=${log.paused ? 'k-breathe' : 'k-flicker'} style=${`position: absolute; left: 0; top: 28px; bottom: 28px; width: 2px; background: ${LIVE}; box-shadow: 0 0 14px 1px ${LIVE}`}></div>
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 18px 18px 12px 26px">
        <h2 class="k-h3">Live log</h2>
        <span class="k-cap" style="flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${log.lines.length ? `Since ${log.lines[0].t} · ` : ''}115200 baud · USB</span>
        <div role="group" aria-label="Show" style="display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.18); box-shadow: inset 0 1px 2px rgba(0,0,0,0.25)">
          ${FILTERS.map(([id, label]) => html`
            <button aria-pressed=${String(filter === id)} onClick=${() => setFilter(id)}
              style=${`height: 28px; padding: 0 12px; border: 0; border-radius: 999px; font-size: 12px; font-weight: 500; transition: background .25s; ${filter === id ? 'background: rgba(255,255,255,0.22); color: var(--ink); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35)' : 'background: transparent; color: var(--muted)'}`}>${label}</button>`)}
        </div>
        <div style="margin-left: auto; display: flex; align-items: center; gap: 8px">
          <label style="display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 999px; background: rgba(255,255,255,0.08); box-shadow: inset 0 1px 0 rgba(255,255,255,0.12)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
            <input aria-label="Filter log text" placeholder="Filter text" value=${text} onInput=${(e) => setText(e.currentTarget.value)}
              style="width: 110px; border: 0; background: transparent; font-size: 13px; outline: none" />
          </label>
          <button class="k-btn" onClick=${() => act('restart', () => setNote(''))} disabled=${b.share} style="height: 32px; padding: 0 14px; white-space: nowrap"><${Icon} d=${I.refresh} size=${13} sw=${2} /> Restart board</button>
          <${PauseButton} log=${log} />
          <button class="k-icon" aria-label="Copy log" onClick=${() => copyText(shown.map(lineText).join('\n')).then(() => setNote(`Copied ${shown.length} lines.`))}><${Icon} d=${I.copy} /></button>
          <button class="k-icon" aria-label="Save log to a file" onClick=${() => act('save-log', (r) => setNote(`Saved to ${r.path.replace(/^\/Users\/[^/]+/, '~')}`))}>
            <${Icon} d=${['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1']} />
          </button>
        </div>
      </div>
      <${Shared} b=${b} />
      <${Held} log=${log} />
      <div ref=${ref} onScroll=${onScroll} class="k-mono" style="flex: 1 1 0; min-height: 300px; overflow-y: auto; padding: 0 18px 12px 26px; font-size: 12px; line-height: 1.8">
        ${shown.length ? shown.map((l) => html`<${LogLine} key=${l.n} l=${l} tagWidth=${120} />`)
          : html`<p class="k-cap" style="font-family: Geist, sans-serif">${log.lines.length ? 'No lines match.' : 'Waiting for the board to say something…'}</p>`}
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 18px 16px 26px; border-top: 1px solid rgba(255,255,255,0.10)">
        <span class="k-cap">${shown.length} lines · ${warns} ${warns === 1 ? 'warning' : 'warnings'}</span>
        <span class="k-cap" aria-live="polite">${note || 'Raw board output, nothing filtered or hidden.'}</span>
      </div>
    </section>`;
}

const saveTitle = (s) => `${fwLabel(s.firmware)} · ${s.kind === 'full' ? 'full backup' : 'settings'}`;
const saveMeta = (s) => `${dayMonth(s.created)} · ${s.created.slice(11, 16)} · ${size(s.size)}${s.verified ? ' · checked' : ''}`;

function SavesPanel({ b, openSave }) {
  const recent = b.saves.slice(0, 3);
  return html`
    <section aria-label="Saves and safety" class="k-glass" style="flex: 1 1 auto; min-width: 0; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px">
      <h2 class="k-h3">Saves</h2>
      ${recent.length === 0 && html`<p class="k-cap">No saves yet. Take a full backup in My boards.</p>`}
      ${recent.map((s) => html`
        <div key=${s.id} class="k-line" style="display: flex; align-items: center; gap: 12px">
          <div style="flex: 1 1 auto; min-width: 0">
            <div style="font-weight: 500">${saveTitle(s)}</div>
            <div class="k-cap" style="margin-top: 2px">${saveMeta(s)}</div>
          </div>
          <button class="k-btn" onClick=${() => openSave(s.id)} style="height: 32px; padding: 0 14px; font-size: 12px">Restore</button>
        </div>`)}
      <div style="height: 1px; background: rgba(255,255,255,0.14)"></div>
      <h2 class="k-h3">Security switches</h2>
      <ul style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; font-size: 13px">
        ${b.switches.map((s) => html`
          <li title=${s.field} style=${`display: flex; align-items: center; gap: 8px; color: ${s.safe ? 'var(--ink)' : 'var(--warn)'}`}>
            <span style="color: var(--muted); display: flex"><${Icon} d=${s.frozen ? I.lock : I.unlock} size=${14} /></span>${s.label}
          </li>`)}
      </ul>
      <p class="k-cap">${b.lockedOpen ? `All four frozen${b.lockedSince ? ` on ${b.lockedSince}` : ''}. No firmware can change them.`
        : 'Not locked open yet. Firmware could still flip these on.'}</p>
    </section>`;
}

const lift = (on) => (on
  ? 'transform: translateY(-2px) scale(1.01); border-color: rgba(255,255,255,0.4); background: rgba(255,255,255,0.18); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), 0 14px 30px rgba(0,0,0,0.28)'
  : 'border-color: rgba(255,255,255,0.10); background: rgba(255,255,255,0.04)');

// A full-width pill whose fill tracks a running job. off: the board isn't plugged in.
function JobButton({ b, kind, idle, onClick, off = false, style = '' }) {
  const job = b.job;
  const mine = job && job.kind === kind;
  return html`
    <button onClick=${onClick} disabled=${!!job || off}
      style=${`position: relative; overflow: hidden; height: 32px; border-radius: 999px; border: 0; background: rgba(255,255,255,0.12); box-shadow: inset 0 1px 0 rgba(255,255,255,0.25); font-weight: 500; font-size: 13px; ${(job && !mine) || off ? 'color: var(--faint);' : ''} ${style}`}>
      <span class="k-fill" aria-hidden="true" style=${`position: absolute; left: 0; top: 0; bottom: 0; width: ${mine ? job.pct : 0}%; background: ${ACCENT}; opacity: 0.55`}></span>
      <span style="position: relative">${mine ? `${job.label} · ${job.pct}%` : idle}</span>
    </button>`;
}

function SaveCard({ s, on, pick }) {
  return html`
    <button class="k-card k-line" onClick=${pick} aria-pressed=${String(on)}
      style=${`display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 14px; border: 1px solid; text-align: left; ${lift(on)}`}>
      <span style="flex: 1 1 auto; min-width: 0">
        <span style="display: block; font-weight: 500">${fwLabel(s.firmware)}</span>
        <span class="k-cap" style="display: block; margin-top: 2px">${saveMeta(s)}${s.why ? ` · ${s.why}` : ''}</span>
      </span>
    </button>`;
}

// One save of board p. live is the plugged-in board, or null: then it can be looked at, not restored.
function SaveDetail({ p, live, s }) {
  const [info, setInfo] = useState(null);
  const [armed, setArmed] = useState(null);  // 'restore' | 'delete': each takes a second click
  const [note, setNote] = useState('');
  useEffect(() => {
    setInfo(null); setArmed(null); setNote('');
    api(`save/${p.mac}?id=${encodeURIComponent(s.id)}`).then(setInfo).catch((e) => setNote(e.message));
  }, [s.id]);
  const full = s.kind === 'full';
  const busy = !!(live && live.job);
  const byMac = (action) => api(`${action}/${p.mac}?id=${encodeURIComponent(s.id)}`, { method: 'POST' }).catch((e) => setNote(e.message));
  const restore = () => {
    if (armed !== 'restore') return setArmed('restore');
    setArmed(null);
    api(`restore/${live.port}?id=${encodeURIComponent(s.id)}`, { method: 'POST' }).catch((e) => setNote(e.message));
  };
  const del = () => { if (armed !== 'delete') return setArmed('delete'); setArmed(null); byMac('delete-save'); };
  const otherFw = !full && s.firmware && p.running && s.firmware.project !== p.running.project;
  const last = live && live.lastJob;
  const status = busy ? `${live.job.label} · ${live.job.pct}%` : note || (last && last.msg) || (live ? '' : `Plug ${boardName(p)} in to restore.`);
  return html`
    <section aria-label="Save details" class="k-glass k-view" style="flex: 7 1 440px; min-width: 0; position: relative; overflow: hidden; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px">
      <${Strip} ink=${busy ? ACCENT : live ? LIVE : 'rgba(255,255,255,0.3)'} busy=${busy} />
      <div>
        <div class="k-cap">${full ? 'Full backup' : 'Settings save'}</div>
        <h2 class="k-doto" style="margin-top: 8px; font-size: 30px; line-height: 0.9">${dayMonth(s.created).toUpperCase()}</h2>
        <p style="margin-top: 12px; color: var(--muted)">${fwLabel(s.firmware)} · ${s.created.slice(11, 16)}${s.why ? ` · ${s.why}` : ''}</p>
      </div>
      <dl style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px">
        <div><dt class="k-cap">Size</dt><dd style="margin-top: 4px; font-size: 13px">${s.size.toLocaleString('en')} bytes</dd></div>
        ${full ? html`
          <div><dt class="k-cap">Read</dt><dd style="margin-top: 4px; font-size: 13px">${s.seconds} s</dd></div>
          <div><dt class="k-cap">Check</dt><dd style="margin-top: 4px; font-size: 13px">${s.verified ? 'Matches the board' : 'Not checked'}</dd></div>`
        : html`
          <div><dt class="k-cap">Address</dt><dd class="k-mono" style="margin-top: 4px; font-size: 13px">0x${s.offset.toString(16).toUpperCase()}</dd></div>
          <div><dt class="k-cap">Firmware</dt><dd style="margin-top: 4px; font-size: 13px">${s.firmware ? s.firmware.project : 'unknown'}</dd></div>`}
      </dl>
      <div class="k-well" style="display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 16px">
        <span class="k-cap" style="flex: 0 0 auto">SHA-256</span>
        <span class="k-mono" style="flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${s.sha256}</span>
        <button class="k-icon" aria-label="Copy SHA-256" onClick=${() => copyText(s.sha256).then(() => setNote('Fingerprint copied.'))}><${Icon} d=${I.copy} size=${15} /></button>
      </div>
      ${full && info && info.regions && html`
        <div>
          <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px">
            <h3 style="font-size: 13px; font-weight: 600">What's inside</h3>
            <span class="k-cap">${info.running ? `${fwLabel(info.running)} in ${info.running.slot}` : 'No firmware'}</span>
          </div>
          <div role="img" aria-label="Backup flash map" style="height: 36px; display: flex; gap: 2px">
            ${barsFor(s.flash, info.regions).map((c) => html`<span class="k-bar" style=${`flex: 1 1 0; min-width: 1px; border-radius: 2px; background: ${c}`}></span>`)}
          </div>
        </div>`}
      <div style="height: 240px; display: flex"><${Settings} settings=${info ? info.settings : []} /></div>
      <div style="margin-top: auto; display: flex; flex-direction: column; gap: 10px">
        ${armed === 'restore' && html`<p class="k-fade" style="font-size: 13px">${full
          ? `This replaces all ${mb(s.flash)} on the board. Its current settings are saved first. About a minute.`
          : `This puts these settings back on the board (${size(s.size)} at 0x${s.offset.toString(16).toUpperCase()}). Its current settings are saved first.${otherFw ? ` They came from ${s.firmware.project}; the board runs ${p.running.project}.` : ''}`}</p>`}
        ${armed === 'delete' && html`<p class="k-fade" style="font-size: 13px">This deletes the file from this Mac for good.</p>`}
        <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center">
          <${JobButton} b=${live || p} kind="restore" off=${!live} idle=${!live ? 'Plug it in to restore' : armed === 'restore' ? 'Yes, restore it' : 'Restore to board'} onClick=${restore}
            style=${`height: 32px; padding: 0 16px; font-weight: 600; font-size: 13px; ${armed === 'restore' ? `background: ${ACCENT}; color: #FFFFFF;` : busy || !live ? '' : 'background: #FFFFFF; color: #1A1A1D;'}`} />
          ${armed && html`<button class="k-btn" onClick=${() => setArmed(null)} style="height: 32px; padding: 0 14px">Cancel</button>`}
          <button class="k-btn" onClick=${() => byMac('reveal')} style="height: 32px; padding: 0 14px">Show in Finder</button>
          <button class="k-btn" onClick=${del} disabled=${busy} style=${`height: 32px; padding: 0 14px; margin-left: auto; ${armed === 'delete' ? `color: ${ACCENT}` : 'color: var(--muted)'}`}>${armed === 'delete' ? 'Yes, delete' : 'Delete'}</button>
        </div>
        <p class="k-cap" aria-live="polite" style=${last && !last.ok && !busy ? 'color: var(--warn)' : ''}>${status}</p>
      </div>
    </section>`;
}

const savesText = (saves) => {
  const fulls = saves.filter((s) => s.kind === 'full').length;
  const sets = saves.length - fulls;
  if (!saves.length) return 'No backup yet';
  return [`${fulls} ${fulls === 1 ? 'backup' : 'backups'}`, sets && `${sets} settings`, size(saves.reduce((n, x) => n + x.size, 0))].filter(Boolean).join(' · ');
};
// ~6 s per MB over native USB: the XIAO's 8 MB took 47 s.
const backupTime = (flash) => `about ${Math.max(10, Math.round(flash / 2 ** 20 * 0.6) * 10)} s`;

function SavesView({ p, live, saveSel, setSaveSel }) {
  const fulls = p.saves.filter((s) => s.kind === 'full');
  const sets = p.saves.filter((s) => s.kind !== 'full');
  const s = p.saves.find((x) => x.id === saveSel) || p.saves[0];
  const run = (action) => api(`${action}/${live.port}`, { method: 'POST' });
  const job = live && live.job;
  return html`
    <div class="k-view" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch">
      <section aria-label="Saves" class="k-glass" style="flex: 4 1 280px; min-width: 0; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px">
        <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 8px">
          <h2 class="k-h3">Saves</h2>
          <span class="k-cap">${savesText(p.saves)}</span>
        </div>
        <${JobButton} b=${live || p} kind="backup" off=${!live} idle=${live ? `Take a full backup · ${backupTime(p.flash)}` : 'Plug it in to back up'} onClick=${() => run('backup')} />
        <div class="k-cap" style="margin-top: 8px">Full backups</div>
        ${fulls.length ? fulls.map((x) => html`<${SaveCard} key=${x.id} s=${x} on=${x === s} pick=${() => setSaveSel(x.id)} />`)
          : html`<div class="k-well" style="padding: 14px 16px; display: flex; gap: 10px; align-items: flex-start">
              <span style="display: flex; flex: 0 0 auto; margin-top: 1px; color: var(--warn)"><${Icon} d=${I.info} sw=${1.8} /></span>
              <span style="font-size: 13px">No backup yet. Switching firmware stays off until there's one, so there's always a way back.</span>
            </div>`}
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 10px">
          <span class="k-cap">Settings saves</span>
          <button class="k-btn" onClick=${() => run('save-settings')} disabled=${!live || !!job || !live.nvs} style="height: 28px; padding: 0 12px; font-size: 12px">
            ${job && job.kind === 'save-settings' ? 'Saving…' : 'Save current settings'}
          </button>
        </div>
        ${sets.length ? sets.map((x) => html`<${SaveCard} key=${x.id} s=${x} on=${x === s} pick=${() => setSaveSel(x.id)} />`)
          : html`<p class="k-cap">None yet. Each switch saves the outgoing firmware's settings here, and puts them back when you switch back.</p>`}
        <div style="flex: 1 1 auto"></div>
        <div style="display: flex; gap: 10px; align-items: flex-start; padding: 0 4px">
          <span style="color: var(--muted); display: flex; flex: 0 0 auto; margin-top: 1px"><${Icon} d=${I.lock} size=${16} /></span>
          <span class="k-cap">Saves hold your Wi-Fi password. They stay on this Mac and are never uploaded or synced.</span>
        </div>
      </section>
      ${s ? html`<${SaveDetail} key=${s.id} p=${p} live=${live} s=${s} />`
        : html`<section class="k-glass" style="flex: 7 1 440px; min-width: 0; min-height: 300px; display: grid; place-items: center; padding: 28px; text-align: center">
            <div style="max-width: 44ch; display: flex; flex-direction: column; gap: 12px; align-items: center">
              <div class="k-doto" style="font-size: 28px; line-height: 0.9">NO BACKUP</div>
              <p style="color: var(--muted); line-height: 1.5">Take one first: an exact copy of everything on this board, kept only on this Mac.</p>
            </div>
          </section>`}
    </div>`;
}

function DropZone({ onNote }) {
  const [over, setOver] = useState(false);
  const send = (file) => {
    onNote(`Importing ${file.name}…`);
    api(`import/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      .then((r) => onNote(`Imported ${r.name}.`)).catch((e) => onNote(e.message));
  };
  const pickNative = (how) => api(`import/${how}`, { method: 'POST' })
    .then((r) => onNote(r.cancelled ? '' : `Imported ${r.name}.`)).catch((e) => onNote(e.message));
  return html`
    <div onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); }}
      style=${`flex: 0 0 auto; min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; border-radius: 24px; text-align: center; transition: border-color .3s, background .3s; border: 1.5px dashed ${over ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.28)'}; background: ${over ? 'rgba(255,255,255,0.08)' : 'transparent'}`}>
      <span style="color: var(--muted); display: flex"><${Icon} d=${['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3']} size=${22} sw=${1.5} /></span>
      <div style="font-weight: 500">Drop firmware here</div>
      <div class="k-cap" style="max-width: 30ch">A .bin, a .zip or .tar.gz release, or an ESP-IDF build folder</div>
      <div style="display: flex; gap: 8px; margin-top: 4px">
        <button class="k-btn" onClick=${() => pickNative('file')}>Choose file…</button>
        <button class="k-btn" onClick=${() => pickNative('folder')}>Build folder…</button>
      </div>
    </div>`;
}

function Check({ c }) {
  return html`
    <li style="display: flex; gap: 10px; align-items: flex-start">
      <span style=${`display: flex; flex: 0 0 auto; margin-top: 1px; color: ${c.ok ? 'var(--ink)' : c.note ? 'var(--warn)' : ACCENT}`}>
        <${Icon} d=${c.ok ? ['M5 12.5l4.5 4.5L19 7.5'] : c.note ? ['M12 11v5', 'M12 8h.01', 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17z'] : ['M6 6l12 12', 'M18 6L6 18']} sw=${2} />
      </span>
      <span style="min-width: 0">
        <span style="display: block; font-weight: 500">${c.label}</span>
        <span class="k-cap" style="display: block; margin-top: 2px">${c.detail}</span>
      </span>
    </li>`;
}

function LibraryView({ b, library, sel, pick }) {
  const [note, setNote] = useState('');
  const f = library.find((x) => x.id === sel) || library[0];
  const r = b.running;
  const row = (x) => {
    const [status, ink] = libStatus(x);
    return html`
      <button key=${x.id} class="k-card" onClick=${() => { pick(x.id); setNote(''); }} aria-pressed=${String(x.id === f.id)}
        style=${`display: flex; align-items: center; gap: 12px; padding: 7px 10px; border-radius: 14px; border: 1px solid; text-align: left; ${lift(x.id === f.id)}`}>
        <span aria-hidden="true" class="k-doto" style="width: 28px; height: 28px; flex: 0 0 auto; border-radius: 9px; background: rgba(255,255,255,0.10); box-shadow: inset 0 1px 0 rgba(255,255,255,0.22); display: grid; place-items: center; font-size: 12px">${x.mono}</span>
        <span style="flex: 1 1 auto; min-width: 0">
          <span style="display: block; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${x.name} ${x.ver}</span>
          <span class="k-cap" style="display: block; margin-top: 2px">${libSub(x)}</span>
        </span>
        <span style=${`font-size: 12px; color: ${ink}; white-space: nowrap`}>${status}</span>
      </button>`;
  };
  const p = f && f.plan;
  const settingsNote = f && (f.onBoard ? 'Live on the board now. Saved by themselves when you switch away, and put back when you return.'
    : `${b.saves.some((s) => s.kind === 'settings' && s.firmware && s.firmware.project === f.project) ? 'Its last settings save goes back on after flashing.' : 'None saved yet, so its first start will be fresh.'}${r ? ` ${r.project}'s settings are saved and wiped from the board before this is written.` : ''}`);
  return html`
    <div class="k-view" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch; min-height: 100%">
      <section aria-label="Firmware" class="k-glass" style="flex: 4 1 280px; min-width: 0; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px">
        <h2 class="k-h3">Library</h2>
        ${library.map(row)}
        <${DropZone} onNote=${setNote} />
        ${note && html`<p class="k-cap" aria-live="polite">${note}</p>`}
      </section>

      ${f ? html`
      <section aria-label="Firmware details" class="k-glass" style="flex: 7 1 440px; min-width: 0; position: relative; overflow: hidden; padding: 16px 18px; display: flex; flex-direction: column; gap: 14px">
        <${Strip} ink=${f.onBoard ? LIVE : 'rgba(255,255,255,0.45)'} />
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap">
          <div style="min-width: 0">
            <h2 class="k-doto" style="font-size: 30px; line-height: 0.9; overflow-wrap: anywhere">${f.name.toUpperCase()}</h2>
            <p style="margin-top: 12px; color: var(--muted)">${[f.ver, f.chip, libSub(f)].filter(Boolean).join(' · ')}</p>
          </div>
          <span style="display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px; border-radius: 999px; background: rgba(255,255,255,0.12); box-shadow: inset 0 1px 0 rgba(255,255,255,0.25); font-size: 13px">
            <span aria-hidden="true" style=${`width: 7px; height: 7px; border-radius: 50%; background: ${f.onBoard ? LIVE : '#FFFFFF'}`}></span>
            ${libStatus(f)[0]}
          </span>
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 24px">
          <div style="flex: 1 1 240px; min-width: 0">
            <h3 style="font-size: 13px; font-weight: 600; margin-bottom: 10px">What gets written</h3>
            <div style="display: grid; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 12px; font-size: 13px">
              <span class="k-cap" style="padding-bottom: 8px">Part</span>
              <span class="k-cap" style="padding-bottom: 8px">Address</span>
              <span class="k-cap" style="padding-bottom: 8px; text-align: right">Size</span>
              ${p.parts.map((x) => html`
                <span title=${x.file} style="padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.12)">${x.name}</span>
                <span class="k-mono" style="padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.12); color: var(--muted)">0x${x.address.toString(16).toUpperCase()}</span>
                <span style="padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.12); text-align: right">${size(x.size)}</span>`)}
            </div>
          </div>
          <div style="flex: 1 1 240px; min-width: 0">
            <h3 style="font-size: 13px; font-weight: 600; margin-bottom: 10px">Checks</h3>
            <ul style="display: flex; flex-direction: column; gap: 12px">${f.checks.map((c) => html`<${Check} c=${c} />`)}</ul>
          </div>
        </div>

        <div class="k-well" style="padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start">
          <span style="display: flex; flex: 0 0 auto; margin-top: 1px"><${Icon} d=${['M4 7h16', 'M4 12h10', 'M4 17h7']} size=${18} sw=${1.6} /></span>
          <div>
            <div style="font-weight: 500">Settings</div>
            <div class="k-cap" style="margin-top: 2px">${settingsNote}</div>
          </div>
        </div>

        <div style="margin-top: auto; display: flex; flex-wrap: wrap; gap: 10px; align-items: center">
          <${FirmwareAction} f=${f} b=${b} onNote=${setNote} />
          <button class="k-btn" onClick=${() => api(`delete-import?id=${encodeURIComponent(f.id)}`, { method: 'POST' })}
            style="height: 32px; padding: 0 14px; margin-left: auto; color: var(--muted)">Remove from library</button>
        </div>
      </section>`
      : html`<${Notice} title="Your library is empty"
          text="Import a firmware file once and it stays here, ready for any board it fits. Each firmware's settings are kept apart, per board." />`}
    </div>`;
}

const seenAt = (iso) => (iso ? `${dayMonth(iso)} · ${iso.slice(11, 16)}` : 'never');
const chipShort = (chip) => (chip || '').replace('ESP32-', '');
// Lock open has been checked on a virtual chip for these only (ebench/lock.py CHIPS).
const LOCKABLE = ['ESP32-S3', 'ESP32-C6'];
const lockText = (p) => (p.lockedOpen ? `Locked open${p.lockedSince ? ` · ${p.lockedSince}` : ''}`
  : LOCKABLE.includes(p.chip) ? 'Not locked' : `Not available for ${chipShort(p.chip)} yet`);
const statusOf = (p, live) => (live && live.job ? `${live.job.label} · ${live.job.pct}%` : live ? `Plugged in · ${live.port}` : `Last seen ${seenAt(p.seen)}`);
const dotOf = (live) => (live && live.job ? ACCENT : live ? LIVE : 'rgba(255,255,255,0.3)');

function BoardCardSmall({ p, live, open }) {
  const fulls = p.saves.some((s) => s.kind === 'full');
  const lockInk = p.lockedOpen ? 'var(--ink)' : LOCKABLE.includes(p.chip) ? 'var(--warn)' : 'var(--faint)';
  return html`
    <button class="k-card k-glass" onClick=${open} aria-label=${`Open ${boardName(p)}`}
      style=${`position: relative; overflow: hidden; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; text-align: left; ${live
        ? `box-shadow: inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 1px rgba(91,227,165,0.35), 0 30px 70px rgba(0,0,0,0.32)` : 'opacity: 0.88'}`}>
      ${live && html`<${Strip} ink=${dotOf(live)} busy=${!!live.job} inset=${26} />`}
      <span style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px">
        <span style="min-width: 0">
          <span class="k-doto" style="display: block; font-size: 24px; line-height: 0.95; overflow-wrap: anywhere">${boardName(p).toUpperCase()}</span>
          <span style="display: block; margin-top: 10px; color: var(--muted); font-size: 13px">${p.model}</span>
        </span>
        <span style="flex: 0 0 auto; height: 26px; padding: 0 10px; border-radius: 999px; background: rgba(255,255,255,0.12); box-shadow: inset 0 1px 0 rgba(255,255,255,0.22); display: inline-flex; align-items: center; font-size: 12px; font-weight: 600">${chipShort(p.chip)}</span>
      </span>
      <span style="display: flex; align-items: center; gap: 8px; font-size: 13px">
        <span aria-hidden="true" class=${live && live.job ? 'k-flicker' : 'k-breathe'} style=${`width: 7px; height: 7px; border-radius: 50%; background: ${dotOf(live)}; box-shadow: 0 0 8px ${dotOf(live)}`}></span>
        <span style=${`color: ${live ? 'var(--ink)' : 'var(--faint)'}`}>${statusOf(p, live)}</span>
      </span>
      <span class="k-well" style="display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; padding: 14px 16px; font-size: 13px">
        <span class="k-cap">Running</span><span style="text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${fwLabel(p.running)}</span>
        <span class="k-cap">Lock</span><span style=${`text-align: right; color: ${lockInk}`}>${lockText(p)}</span>
        <span class="k-cap">Saves</span><span style=${`text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: ${fulls ? 'var(--ink)' : 'var(--warn)'}`}>${savesText(p.saves)}</span>
      </span>
      <span class="k-mono" style="font-size: 11px; color: #AEAEB2">${p.mac}</span>
    </button>`;
}

const BOARD_FILTERS = [['all', 'All'], ['plugged', 'Plugged in'], ['open', 'Not locked']];

function BoardsGrid({ list, open }) {
  const [filter, setFilter] = useState('all');
  const shown = list.filter(({ p, live }) => filter === 'all' || (filter === 'plugged' ? live : !p.lockedOpen && LOCKABLE.includes(p.chip)));
  const plugged = list.filter((x) => x.live).length;
  return html`
    <section aria-label="My boards" class="k-view" style="display: flex; flex-direction: column; gap: 12px">
      <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 4px 6px 0">
        <div>
          <h1 class="k-doto" style="font-size: 30px; line-height: 0.9">MY BOARDS</h1>
          <p style="margin-top: 10px; color: var(--muted)">${list.length} ${list.length === 1 ? 'board' : 'boards'} · ${plugged} plugged in · each keeps its own saves and security</p>
        </div>
        <div role="group" aria-label="Show" style="display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.18); box-shadow: inset 0 1px 2px rgba(0,0,0,0.25)">
          ${BOARD_FILTERS.map(([id, label]) => html`
            <button aria-pressed=${String(filter === id)} onClick=${() => setFilter(id)}
              style=${`height: 28px; padding: 0 12px; border: 0; border-radius: 999px; font-size: 12px; font-weight: 500; transition: background .25s; ${filter === id ? 'background: rgba(255,255,255,0.22); color: var(--ink); box-shadow: inset 0 1px 0 rgba(255,255,255,0.35)' : 'background: transparent; color: var(--muted)'}`}>${label}</button>`)}
        </div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px">
        ${shown.map(({ p, live }) => html`<${BoardCardSmall} key=${p.mac} p=${p} live=${live} open=${() => open(p.mac)} />`)}
        <div style="border-radius: 30px; border: 1.5px dashed rgba(255,255,255,0.26); padding: 14px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; min-height: 200px">
          <span style="color: var(--muted); display: flex"><${Icon} d=${I.usb} size=${26} sw=${1.5} /></span>
          <div style="font-weight: 500">Plug in a new board</div>
          <div class="k-cap" style="max-width: 26ch">eBench spots it and asks for a name before anything else.</div>
        </div>
      </div>
    </section>`;
}

const SWITCH_TECH = { DIS_DOWNLOAD_MODE: 'DIS_DOWNLOAD_MODE · DIS_USB_SERIAL_JTAG' };
const LOCK_FIELDS = ['SPI_BOOT_CRYPT_CNT', 'SECURE_BOOT_EN', 'DIS_DOWNLOAD_MODE', 'DIS_USB_SERIAL_JTAG'];
const LOCK_STEPS = [
  ['Simulate', 'Burn on a virtual copy of this chip first; stop if anything but the write-protect bits would change'],
  ['Burn', 'Write the four write-protect fuses on the real chip'],
  ['Read back', 'Confirm all four switches report frozen'],
];

function SecurityView({ p, live }) {
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState('');
  const sw = p.switches || [];
  const frozen = p.lockedOpen;
  const unsafe = sw.filter((s) => !s.safe);
  const can = LOCKABLE.includes(p.chip);
  const job = live && live.job && live.job.kind === 'lock' ? live.job : null;
  const last = live && !job && live.lastJob && live.lastJob.kind === 'lock' ? live.lastJob : null;
  const stepAt = job ? Math.max(0, ['simulate', 'burn', 'check'].indexOf(job.phase)) : frozen ? 3 : -1;
  const go = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    api(`lock/${live.port}`, { method: 'POST' }).catch((e) => setNote(e.message));
  };
  const blocked = !live || !!live.job || unsafe.length > 0;
  const label = !live ? 'Plug it in to lock' : job ? `${job.label} · ${job.pct}%` : armed ? 'Click again to lock forever' : 'Lock open';
  const look = blocked && !job ? 'background: rgba(255,255,255,0.10); color: var(--faint)'
    : job ? 'background: rgba(255,255,255,0.14); color: var(--ink)'
    : armed ? `background: ${ACCENT}; color: #FFFFFF; box-shadow: 0 10px 26px rgba(255,90,71,0.35)`
    : 'background: #FFFFFF; color: #1A1A1D; box-shadow: inset 0 -1px 0 rgba(0,0,0,0.08), 0 10px 26px rgba(0,0,0,0.3)';
  const checks = p.checks || [];
  return html`
    <div class="k-view" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch">
      <section aria-label="Security state" class="k-glass" style="flex: 5 1 340px; min-width: 0; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px">
        <div>
          <div class="k-cap">Security · ${p.chip}</div>
          <h2 class="k-doto" style="margin-top: 8px; font-size: 26px; line-height: 0.9">${frozen ? 'LOCKED OPEN' : unsafe.length ? 'NOT SAFE' : 'NOT LOCKED'}</h2>
          <p style="margin-top: 12px; color: var(--muted); line-height: 1.55">${frozen
            ? 'The four switches that could lock you out of this board are frozen. No firmware, not even a hostile one, can change them.'
            : unsafe.length ? `Already switched on: ${unsafe.map((s) => s.label.replace(/ (on|off)$/, '')).join(', ')}. Lock open only freezes switches in their safe positions.`
            : 'All four switches are safe right now, but firmware could still flip them. Locking open freezes them where they are.'}</p>
        </div>
        <ul style="display: flex; flex-direction: column; gap: 6px">
          ${sw.map((s) => html`
            <li class="k-well" style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 12px">
              <span style="display: flex; flex: 0 0 auto; color: var(--muted)"><${Icon} d=${s.frozen ? I.lock : I.unlock} /></span>
              <span style="flex: 1 1 auto; min-width: 0">
                <span style="display: block; font-weight: 500">${s.label.replace(/ (on|off)$/, '')}</span>
                <span class="k-mono" style="display: block; margin-top: 2px; font-size: 11px; color: var(--faint); overflow-wrap: anywhere">${SWITCH_TECH[s.field] || s.field}</span>
              </span>
              <span style=${`flex: 0 0 auto; height: 26px; padding: 0 10px; border-radius: 999px; background: rgba(255,255,255,0.12); display: inline-flex; align-items: center; font-size: 12px; color: ${s.safe ? 'var(--ink)' : 'var(--warn)'}`}>
                ${s.on ? 'On' : 'Off'} · ${s.frozen ? 'frozen' : 'can change'}</span>
            </li>`)}
        </ul>
        <div>
          <h3 style="font-size: 13px; font-weight: 600; margin-bottom: 10px">Checked after every flash</h3>
          ${checks.length ? checks.slice(0, 6).map((e) => html`
            <div style="display: flex; gap: 14px; padding: 9px 0; border-top: 1px solid rgba(255,255,255,0.10); font-size: 13px">
              <span class="k-mono" style="flex: 0 0 96px; color: var(--faint); font-size: 12px">${dayMonth(e.when)} ${e.when.slice(11, 16)}</span>
              <span style=${e.what.includes('CHANGED') ? 'color: var(--warn)' : ''}>${e.what}</span>
            </div>`)
            : html`<p class="k-cap">Nothing recorded yet. Every switch and lock adds a line here.</p>`}
        </div>
      </section>

      <section aria-label="Lock open" class="k-glass" style="flex: 4 1 300px; min-width: 0; position: relative; overflow: hidden; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px">
        <${Strip} ink=${job ? ACCENT : frozen ? LIVE : 'rgba(255,255,255,0.35)'} busy=${!!job} />
        <h2 class="k-h3">${frozen ? 'Lock open · done' : can ? 'Lock open' : `Lock open · not available for ${chipShort(p.chip)} yet`}</h2>
        <p style="color: var(--muted); line-height: 1.55">${frozen
          ? 'Burned and read back. There is no undo: eFuses are physical, so this board stays open for good.'
          : !can ? 'Lock open is offered on ESP32-S3 boards, where it has been checked.'
          : `${live ? '' : `Plug ${boardName(p)} in to lock it. `}Freezes the four switches in their safe positions with write-protect fuses. Each fuse freezes a group, so some harmless neighbours freeze too.`}</p>
        ${can && !frozen && html`
          <ol style="display: flex; flex-direction: column; gap: 10px">
            ${LOCK_STEPS.map(([name, detail], i) => html`
              <li style="display: flex; gap: 12px; align-items: flex-start">
                <span style=${`width: 24px; height: 24px; flex: 0 0 auto; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600; transition: background .3s; background: ${i < stepAt ? '#FFFFFF' : i === stepAt ? ACCENT : 'rgba(255,255,255,0.12)'}; color: ${i < stepAt ? '#1A1A1D' : '#FFFFFF'}`}>
                  ${i < stepAt ? html`<${Icon} d=${I.check} size=${13} sw=${3} />` : i + 1}</span>
                <span style="min-width: 0">
                  <span style="display: block; font-weight: 500">${name}</span>
                  <span class="k-cap" style="display: block; margin-top: 2px">${detail}</span>
                </span>
              </li>`)}
          </ol>
          <div style="display: flex; gap: 10px; align-items: flex-start">
            <span style="display: flex; flex: 0 0 auto; margin-top: 2px; color: var(--warn)"><${Icon} d=${I.info} sw=${1.8} /></span>
            <span style="font-size: 13px">Permanent. The cost: this board can never turn on encryption or secure boot later.</span>
          </div>
          <div style="margin-top: auto; display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
            <button onClick=${go} disabled=${blocked}
              style=${`position: relative; overflow: hidden; height: 32px; padding: 0 16px; border-radius: 999px; border: 0; font-weight: 600; font-size: 13px; transition: background .3s, color .3s; ${look}`}>
              <span class="k-fill" aria-hidden="true" style=${`position: absolute; left: 0; top: 0; bottom: 0; width: ${job ? job.pct : 0}%; background: ${ACCENT}; opacity: 0.55`}></span>
              <span style="position: relative">${label}</span>
            </button>
            ${armed && !job && html`<button class="k-btn" onClick=${() => setArmed(false)} style="height: 32px; padding: 0 14px">Cancel</button>`}
          </div>
          <p class="k-cap" aria-live="polite" style=${note || (last && !last.ok) ? 'color: var(--warn)' : ''}>${note || (last && last.msg) || ''}</p>`}
        ${frozen && html`
          <div class="k-well" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 8px">
            <div style="font-weight: 600">Frozen groups</div>
            <div class="k-mono" style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px">
              ${LOCK_FIELDS.map((f) => html`<span style="padding: 4px 8px; border-radius: 8px; background: rgba(255,255,255,0.08)">${f}</span>`)}
              ${p.lock && html`<span style="padding: 4px 8px; border-radius: 8px; background: rgba(255,255,255,0.08)">+ ${p.lock.frozen.length - LOCK_FIELDS.length} neighbours</span>`}
            </div>
            ${p.lock && html`<div class="k-cap">WR_DIS 0x${p.lock.before.toString(16).toUpperCase()} → 0x${p.lock.after.toString(16).toUpperCase()} · ${seenAt(p.lock.when)}</div>`}
          </div>`}
        ${!can && html`
          <div class="k-well" style="padding: 14px 16px; display: flex; gap: 10px; align-items: flex-start">
            <span style="display: flex; flex: 0 0 auto; margin-top: 2px; color: var(--muted)"><${Icon} d=${I.info} /></span>
            <span style="font-size: 13px; line-height: 1.5">Each fuse freezes a group of settings, and the ${chipShort(p.chip)} groups them differently from the S3. The button appears once a virtual ${chipShort(p.chip)} shows the lock freezes only what it should (GitHub issue #1).</span>
          </div>`}
      </section>
    </div>`;
}

const SUBS = [['saves', 'Saves'], ['security', 'Security']];

function BoardPage({ p, live, sub, setSub, back, saveSel, setSaveSel }) {
  const [edit, setEdit] = useState(null);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [note, setNote] = useState('');
  const busy = !!(live && live.job);
  const spec = [p.chip, `rev ${p.rev}`, `${mb(p.flash)} flash`, p.psram ? `${p.psram} PSRAM` : 'no PSRAM'].join(' · ');
  const saveEdit = () => api(`profile/${p.mac}`, { method: 'POST', body: JSON.stringify(edit) })
    .then(() => { setEdit(null); setNote(''); }).catch((e) => setNote(e.message));
  const forget = () => {
    if (!forgetArmed) return setForgetArmed(true);
    api(`forget/${p.mac}`, { method: 'POST' }).then(back).catch((e) => setNote(e.message));
  };
  const field = (key, label, grow, extra = '') => html`
    <label style=${`flex: ${grow}; display: flex; flex-direction: column; gap: 6px`}>
      <span class="k-h3">${label}${extra}</span>
      <input class="k-field" value=${edit[key]} onInput=${(e) => setEdit({ ...edit, [key]: e.currentTarget.value })} />
    </label>`;
  const at = SUBS.findIndex(([id]) => id === sub);
  return html`
    <div class="k-view" style="display: flex; flex-direction: column; gap: 12px">
      <section aria-label="Board" class="k-glass" style="position: relative; overflow: hidden; padding: 14px 18px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px">
        <${Strip} ink=${busy ? ACCENT : live ? LIVE : 'rgba(255,255,255,0.2)'} busy=${busy} />
        <button class="k-icon" onClick=${back} aria-label="Back to My boards" style="width: 36px; height: 36px; background: rgba(255,255,255,0.10)"><${Icon} d=${I.back} sw=${2} /></button>
        <div style="flex: 1 1 320px; min-width: 0">
          <h1 class="k-doto" style="font-size: 30px; line-height: 0.9; overflow-wrap: anywhere">${boardName(p).toUpperCase()}</h1>
          <p style="margin-top: 10px; color: var(--muted)">${p.model} · ${spec}</p>
          ${p.notes && html`<p style="margin-top: 4px; font-size: 12px; color: var(--faint)">${p.notes}</p>`}
        </div>
        <dl style="display: grid; grid-template-columns: repeat(3, auto); gap: 4px 26px; font-size: 13px">
          <dt class="k-cap">Status</dt><dt class="k-cap">MAC</dt><dt class="k-cap">Running</dt>
          <dd style=${`display: flex; align-items: center; gap: 6px; color: ${live ? 'var(--ink)' : 'var(--faint)'}`}>
            <span aria-hidden="true" style=${`width: 7px; height: 7px; border-radius: 50%; background: ${dotOf(live)}`}></span>${statusOf(p, live)}</dd>
          <dd class="k-mono">${p.mac}</dd>
          <dd>${fwLabel(p.running)}</dd>
        </dl>
        <div style="display: flex; gap: 8px">
          <button class="k-btn" onClick=${() => (edit ? saveEdit() : setEdit({ name: p.name || '', model: p.model || '', notes: p.notes || '' }))}>${edit ? 'Save details' : 'Edit details'}</button>
          ${edit && html`<button class="k-btn" onClick=${() => { setEdit(null); setNote(''); }}>Cancel</button>`}
          <button class="k-btn" onClick=${forget} disabled=${busy} style=${`color: ${forgetArmed ? ACCENT : 'var(--muted)'}`}>${forgetArmed ? 'Yes, forget it' : 'Forget board'}</button>
          ${forgetArmed && html`<button class="k-btn" onClick=${() => setForgetArmed(false)}>Cancel</button>`}
        </div>
        ${forgetArmed && html`<p class="k-fade" style="flex: 1 1 100%; font-size: 13px">Forgetting deletes this board's profile and its saves (${savesText(p.saves)}) from this Mac. The board itself isn't touched.${live ? " It's plugged in, so eBench asks for its name again." : ''}</p>`}
        ${edit && html`
          <div class="k-fade" style="flex: 1 1 100%; display: flex; flex-wrap: wrap; gap: 14px; padding-top: 4px">
            ${field('name', 'Name', '1 1 180px')}
            ${field('model', 'Model', '1 1 220px')}
            ${field('notes', 'Notes', '2 1 280px', html` <span style="font-weight: 400; color: var(--faint)">· optional</span>`)}
          </div>`}
        ${note && html`<p class="k-cap" style="flex: 1 1 100%; color: var(--warn)">${note}</p>`}
      </section>
      <div role="tablist" aria-label="Board sections" style="align-self: flex-start; position: relative; display: flex; padding: 3px; border-radius: 999px; background: rgba(0,0,0,0.18); box-shadow: inset 0 1px 2px rgba(0,0,0,0.25)">
        <span aria-hidden="true" class="k-thumb" style=${`position: absolute; top: 3px; bottom: 3px; left: ${3 + at * 110}px; width: 110px; border-radius: 999px; background: rgba(255,255,255,0.24); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4), 0 4px 14px rgba(0,0,0,0.25)`}></span>
        ${SUBS.map(([id, label]) => html`
          <button role="tab" aria-selected=${String(sub === id)} onClick=${() => setSub(id)}
            style=${`position: relative; width: 110px; height: 30px; border: 0; border-radius: 999px; background: transparent; font-size: 13px; font-weight: 500; color: ${sub === id ? 'var(--ink)' : 'var(--muted)'}`}>${label}</button>`)}
      </div>
      ${sub === 'saves' ? html`<${SavesView} p=${p} live=${live} saveSel=${saveSel} setSaveSel=${setSaveSel} />`
        : html`<${SecurityView} key=${p.mac} p=${p} live=${live} />`}
    </div>`;
}

const boardList = (profiles, boards) => profiles.map((saved) => {
  const live = boards.find((b) => b.mac === saved.mac && b.status === 'ready' && !b.new) || null;
  return { p: live ? { ...saved, ...live } : saved, live };
});

const MODELS = {
  'ESP32-S3': ['Seeed XIAO ESP32-S3', 'ESP32-S3-DevKitC-1', 'LilyGO T-Display-S3'],
  'ESP32-C6': ['Seeed XIAO ESP32-C6', 'ESP32-C6-DevKitC-1'],
};

// The sheet for a board this Mac hasn't seen: a name and model before anything else, and a backup if it isn't empty.
function Onboard({ b, step, onSaved, onOpen }) {
  const [form, setForm] = useState({ name: '', model: '', notes: '' });
  const [backup, setBackup] = useState(true);
  const [note, setNote] = useState('');
  const [started, setStarted] = useState(false);
  useEffect(() => { if (b.job) setStarted(true); }, [!!b.job]);
  const r = b.running;
  const notEmpty = !!r || (b.settings || []).length > 0;
  const models = [...(MODELS[b.chip] || []), `Generic ${b.chip}`];
  const ready = form.name.trim() && form.model;
  const save = () => api(`profile/${b.mac}`, { method: 'POST', body: JSON.stringify(form) })
    .then(() => (backup && notEmpty ? api(`backup/${b.port}`, { method: 'POST' }).then(() => onSaved(true)) : onSaved(false)))
    .catch((e) => setNote(e.message));
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const done = started && !b.job;
  const ok = done && b.lastJob && b.lastJob.ok;
  const pct = b.job ? b.job.pct : done ? 100 : 0;
  const edge = Math.floor(pct * 1.28);
  const flashMb = b.flash / 2 ** 20;
  const reading = step === 'backup' && !done;
  const left = Math.max(1, Math.round((100 - pct) / 100 * flashMb * 6));
  const what = r ? `runs ${fwLabel(r)}${(b.library || []).some((f) => f.onBoard) ? '' : ", not in your library"}` : 'empty';
  const primary = 'height: 30px; padding: 0 16px; border-radius: 999px; border: 0; font-weight: 600; font-size: 13px';
  return html`
    <div class="k-fade" style="position: absolute; inset: 0; z-index: 10; background: rgba(12,12,14,0.42)">
      <section role="dialog" aria-modal="true" aria-label="Add this board" class="k-glass k-drop"
        style="position: absolute; top: 46px; left: 50%; transform: translateX(-50%); width: 520px; max-width: calc(100% - 32px); max-height: calc(100% - 60px); overflow-y: auto; box-sizing: border-box; border-radius: 0 0 18px 18px; border-top: 0; padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; background: linear-gradient(180deg, #3E3E44, #2C2C30)">
        <${Strip} ink=${reading ? ACCENT : LIVE} busy=${reading} inset=${0} />
        ${step === 'form' ? html`
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px">
            <h2 class="k-h2" style="font-size: 14px">New ${b.chip} on ${b.port}</h2>
            <span class="k-mono k-lab">${b.mac}</span>
          </div>
          <div class="k-lab" style="margin-top: -8px">${[`rev ${b.rev}`, `${mb(b.flash)} flash`, b.psram ? `${b.psram} PSRAM` : 'no PSRAM', what].join(' · ')}</div>
          <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px">
            <label style="display: flex; flex-direction: column; gap: 4px"><span class="k-lab">Name</span>
              <input class="k-in" autofocus maxlength="40" placeholder=${`${chipShort(b.chip)} #2`} value=${form.name} onInput=${set('name')} /></label>
            <label style="display: flex; flex-direction: column; gap: 4px"><span class="k-lab">Board</span>
              <span style="position: relative; display: block">
                <select class="k-in" value=${form.model} onChange=${set('model')} style="padding-right: 28px">
                  <option value="" disabled>Pick one…</option>
                  ${models.map((m) => html`<option value=${m}>${m.startsWith('Generic') ? `Not sure · generic ${chipShort(b.chip)}` : m}</option>`)}
                </select>
                <span aria-hidden="true" style="position: absolute; right: 10px; top: 10px; display: flex; pointer-events: none; color: var(--muted)"><${Icon} d=${['M6 9l6 6 6-6']} size=${12} sw=${2} /></span>
              </span>
            </label>
          </div>
          <label style="display: flex; flex-direction: column; gap: 4px"><span class="k-lab">Notes · optional</span>
            <input class="k-in" maxlength="200" placeholder="What it's for, where it lives" value=${form.notes} onInput=${set('notes')} /></label>
          ${note && html`<p class="k-lab" style="color: var(--warn)">${note}</p>`}
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 2px">
            ${notEmpty ? html`
              <button onClick=${() => setBackup(!backup)} aria-pressed=${String(backup)} style="display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; font-size: 13px; text-align: left">
                <span aria-hidden="true" style=${`width: 16px; height: 16px; flex: 0 0 auto; border-radius: 5px; display: grid; place-items: center; color: #1A1A1D; ${backup ? 'background: #FFFFFF' : 'border: 1.5px solid rgba(255,255,255,0.45)'}`}>
                  ${backup && html`<${Icon} d=${I.check} size=${11} sw=${3.5} />`}</span>
                Back up what's on it first <span class="k-lab">· ${backupTime(b.flash)}</span>
              </button>` : html`<span class="k-lab">Nothing is written to the board.</span>`}
            <button onClick=${save} disabled=${!ready} class="k-primary" style=${primary}>${backup && notEmpty ? 'Add and back up' : 'Add board'}</button>
          </div>`
        : html`
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
            <div><h2 class="k-h2" style="font-size: 14px">Backing up ${boardName(b)}</h2><div class="k-lab" style="margin-top: 2px">An exact copy, kept only on this Mac</div></div>
            <div class="k-doto" aria-live="polite" style="font-size: 30px; line-height: 1">${pct}%</div>
          </div>
          <div role="img" aria-label="Flash being read" style="height: 16px; display: flex; gap: 1px">
            ${Array.from({ length: 128 }, (_, i) => html`<span class="k-bar" style=${`flex: 1 1 0; min-width: 1px; border-radius: 1px; background: ${i < edge ? COLORS.data : i === edge && !done ? ACCENT : COLORS.free}`}></span>`)}
          </div>
          ${done ? html`
            <div class="k-fade" style="display: flex; align-items: center; justify-content: space-between; gap: 12px">
              <span style=${`display: flex; align-items: center; gap: 6px; font-size: 12px; color: ${ok ? 'var(--ink)' : 'var(--warn)'}`}>
                ${ok && html`<span aria-hidden="true" style=${`width: 6px; height: 6px; border-radius: 50%; background: ${LIVE}`}></span>`}
                ${ok ? `Checked against the board · in ${boardName(b)} › Saves` : b.lastJob.msg}</span>
              <button class="k-primary" onClick=${onOpen} style=${primary}>Open ${boardName(b)}</button>
            </div>`
          : html`<div class="k-lab" style="display: flex; justify-content: space-between"><span>${b.job && b.job.pct === 100 ? b.job.label : `Reading flash · ${(pct * flashMb / 100).toFixed(1)} of ${flashMb} MB`}</span><span>about ${left} s left</span></div>`}`}
      </section>
    </div>`;
}

function Overview({ b, library, sel, pick, log, openSave, goLibrary }) {
  const r = b.running;
  return html`
    <div class="k-view" style="display: flex; flex-direction: column; gap: 12px">
      <${BoardStrip} b=${b} />
      <${Stats} b=${b} />
      <${FlashMap} b=${b} />
      <div style="display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 12px; align-items: stretch">
        <div style="display: flex; flex-direction: column; gap: 12px; min-width: 0">
          <${Settings} settings=${b.settings} cls="k-glass" style="flex: 0 0 280px" />
          <${LiveLog} b=${b} log=${log} />
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px; min-width: 0">
          <${LibraryPanel} b=${b} library=${library} fromName=${r ? r.project : 'current'} sel=${sel} pick=${pick} goLibrary=${goLibrary} />
          <${SavesPanel} b=${b} openSave=${openSave} />
        </div>
      </div>
    </div>`;
}

function Notice({ big, title, text, busy, action }) {
  return html`
    <section class="k-glass k-view" style="min-height: 100%; box-sizing: border-box; position: relative; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 28px; text-align: center">
      <${Strip} ink=${busy ? LIVE : 'rgba(255,255,255,0.45)'} busy=${busy} />
      <h2 class="k-doto" style="font-size: 40px; line-height: 0.9">${big}</h2>
      <p style="font-size: 15px; font-weight: 600">${title}</p>
      <p style="max-width: 46ch; color: var(--muted); line-height: 1.5">${text}</p>
      ${action}
    </section>`;
}

function BoardView({ b, tab, setTab, library, sel, pick, log, openSave }) {
  if (b.status === 'reading') {
    return html`<${Notice} big="READING" busy title=${`Reading the board on ${b.port}`}
      text="Chip, firmware, flash layout, settings and security switches. The board restarts once while this happens, about 2 seconds." />`;
  }
  if (b.status === 'error') {
    return html`<${Notice} big="HMM" title=${`Couldn't read the board on ${b.port}`} text=${b.error}
      action=${html`<button class="k-btn" onClick=${() => api('read/' + b.port, { method: 'POST' })} style="height: 40px; padding: 0 20px"><${Icon} d=${I.refresh} size=${14} /> Try again</button>`} />`;
  }
  if (tab === 0) return html`<${Overview} b=${b} library=${library} sel=${sel} pick=${pick} log=${log} openSave=${openSave} goLibrary=${() => setTab(1)} />`;
  if (tab === 1) return html`<${LibraryView} b=${b} library=${library} sel=${sel} pick=${pick} />`;
  return html`<${LogView} b=${b} log=${log} />`;
}

function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(0);
  const [port, setPort] = useState(null);
  const [sel, setSel] = useState(null);
  const [logs, setLogs] = useState({});
  const [pausedAt, setPausedAt] = useState(0); // last line number shown while paused, 0 = live
  const [saveSel, setSaveSel] = useState(null);
  const [page, setPage] = useState(null);     // My boards: the MAC whose page is open, or null for the grid
  const [sub, setSub] = useState('saves');
  const [ob, setOb] = useState(null);         // the new-board popup: {mac, step: 'form' | 'backup'}
  useEffect(() => {
    const es = new EventSource(`/api/events?k=${encodeURIComponent(KEY)}`);
    es.addEventListener('state', (e) => { setState(JSON.parse(e.data)); setError(''); });
    es.addEventListener('log', (e) => {
      const fresh = JSON.parse(e.data);
      setLogs((prev) => {
        const next = { ...prev };
        for (const [p, lines] of Object.entries(fresh)) {
          const have = prev[p] || [];
          const last = have.length ? have[have.length - 1].n : 0;  // a reconnect resends the backlog
          next[p] = have.concat(lines.filter((l) => l.n > last)).slice(-3000);
        }
        return next;
      });
    });
    es.onerror = () => setError("Can't reach the eBench engine. It retries by itself.");
    // A file dropped anywhere but the drop zone must not navigate the window to it.
    const stop = (e) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { es.close(); window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);
  // A board this Mac hasn't named gets the popup first. It stays up through its backup,
  // and closes once the board has its name, or when it's unplugged.
  useEffect(() => {
    if (!state) return;
    const fresh = state.boards.find((x) => x.status === 'ready' && x.new);
    const here = ob && state.boards.find((x) => x.mac === ob.mac && x.status === 'ready');
    if (!ob && fresh) setOb({ mac: fresh.mac, step: 'form' });
    else if (ob && (!here || (ob.step === 'done' && !here.new))) setOb(null);
  }, [state, ob]);

  if (error && !state) {
    return html`<div class="k-root"><${Notice} big="OFFLINE" title="Can't reach the eBench engine" text=${error} /></div>`;
  }
  const boards = state ? state.boards : [];
  const profiles = state ? state.profiles : [];
  const b = boards.find((x) => x.port === port) || boards[0];
  const list = boardList(profiles, boards);
  const pageItem = page && list.find((x) => x.p.mac === page);
  const obBoard = ob && ob.step !== 'done' && boards.find((x) => x.mac === ob.mac && x.status === 'ready');
  const openBoard = (mac) => { setPage(mac); setSub('saves'); setSaveSel(null); setTab(2); };
  const title = tab === 2 ? (pageItem ? boardName(pageItem.p) : 'My boards')
    : b && b.status === 'ready' && !b.new ? b.title || boardName(b) : 'Lagreton eBench';
  const library = (b && b.library) || (state ? state.library : []);
  const effSel = sel || (library.find((f) => !f.onBoard && fits(f)) || library[0] || {}).id;
  const all = (b && logs[b.port]) || [];
  const log = {
    lines: pausedAt ? all.filter((l) => l.n <= pausedAt) : all,
    paused: !!pausedAt,
    held: pausedAt ? all.filter((l) => l.n > pausedAt).length : 0,
    togglePause: () => setPausedAt(pausedAt ? 0 : (all.length ? all[all.length - 1].n : 1)),
  };
  return html`
    <div class="k-root">
      <div aria-hidden="true" class="k-drift" style="position: absolute; inset: -10%; background: radial-gradient(40% 44% at 78% 18%, rgba(255,255,255,0.16), transparent 70%), radial-gradient(36% 40% at 14% 86%, rgba(255,255,255,0.10), transparent 70%)"></div>
      <div aria-hidden="true" class=${boards.some((x) => x.job) ? 'k-halo busy' : 'k-halo'} style=${`position: absolute; left: 22%; top: 90px; width: 46%; height: 360px; border-radius: 50%; background: radial-gradient(closest-side, ${boards.some((x) => x.job) ? 'rgba(255,90,71,0.3)' : 'rgba(91,227,165,0.14)'}, transparent); filter: blur(30px)`}></div>
      <div aria-hidden="true" class="k-dots"></div>
      <div style="position: relative; height: 100%; display: flex; flex-direction: column">
        <${Header} title=${title} tab=${tab} setTab=${(i) => { setTab(i); if (i === 2) setPage(null); }} />
        ${state && html`
          <div style="flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; padding: 12px 0 0 10px">
            <${Sidebar} boards=${boards} profiles=${profiles} current=${b} library=${library} sel=${effSel} pick=${(id) => { setSel(id); setTab(1); }} openImport=${() => setTab(1)}
              setPort=${(p) => { setPort(p); const x = boards.find((y) => y.port === p); if (tab === 2 && x && list.some((y) => y.p.mac === x.mac)) openBoard(x.mac); }} />
            <main style="flex: 1 1 auto; min-width: 0; overflow-y: auto; margin: -12px 0 0 -12px; padding: 12px 10px 10px 12px">
              ${tab === 2 ? (pageItem
                  ? html`<${BoardPage} key=${pageItem.p.mac} p=${pageItem.p} live=${pageItem.live}
                      sub=${sub} setSub=${setSub} back=${() => setPage(null)} saveSel=${saveSel} setSaveSel=${setSaveSel} />`
                  : html`<${BoardsGrid} list=${list} open=${openBoard} />`)
                : b ? html`<${BoardView} b=${b} tab=${tab} setTab=${setTab} library=${library} sel=${effSel} pick=${setSel} log=${log}
                  openSave=${(id) => { openBoard(b.mac); setSaveSel(id); }} />`
                : html`<${Notice} big="NO BOARD" title="Plug in an ESP32 board"
                    text="Connect it over USB. eBench spots it and reads what's on it by itself." />`}
            </main>
          </div>`}
      </div>
      ${ob && obBoard && html`<${Onboard} key=${ob.mac} b=${obBoard} step=${ob.step}
        onSaved=${(backingUp) => (backingUp ? setOb({ ...ob, step: 'backup' }) : (setOb({ ...ob, step: 'done' }), openBoard(ob.mac)))}
        onOpen=${() => { setOb({ ...ob, step: 'done' }); openBoard(ob.mac); }} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
