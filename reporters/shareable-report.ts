import fs from 'fs';
import path from 'path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/**
 * Writes the whole run as one self-contained HTML file (styles, data and screenshots embedded),
 * so it can be emailed or uploaded and opened offline. Videos are left out to keep the file small;
 * they stay in the Playwright HTML report.
 */

type Options = { outputFile?: string; title?: string };
type Status = 'passed' | 'failed' | 'flaky' | 'skipped';
type Entry = { test: TestCase; result: TestResult };

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_PER_TEST = 12;
const STATUS_LABEL: Record<Status, string> = { passed: 'Passed', failed: 'Failed', flaky: 'Flaky', skipped: 'Skipped' };

const escapeHtml = (text: unknown) =>
  String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function statusOf(test: TestCase): Status {
  switch (test.outcome()) {
    case 'expected':
      return 'passed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

export default class ShareableReport implements Reporter {
  private config!: FullConfig;
  private startedAt = new Date();
  private entries = new Map<TestCase, Entry>();

  constructor(private readonly options: Options = {}) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Retries replace the earlier attempt; the final one decides the status.
    this.entries.set(test, { test, result });
  }

  onEnd(result: FullResult): void {
    // Nothing ran (e.g. `--list`): keep the last real report.
    if (this.entries.size === 0) return;
    const rootDir = this.config.configFile ? path.dirname(this.config.configFile) : process.cwd();
    const outputFile = path.resolve(rootDir, this.options.outputFile ?? 'shareable-report/test-report.html');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, this.render(result, rootDir), 'utf8');
    console.log(`\nShareable report: ${outputFile}`);
  }

  private render(run: FullResult, rootDir: string): string {
    const entries = [...this.entries.values()];
    const counts: Record<Status, number> = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
    for (const { test } of entries) counts[statusOf(test)]++;
    const total = entries.length;
    const executed = total - counts.skipped;
    const passRate = executed ? Math.round(((counts.passed + counts.flaky) / executed) * 100) : 0;

    const groups = new Map<string, Entry[]>();
    for (const entry of entries.sort((a, b) => a.test.location.file.localeCompare(b.test.location.file) || a.test.location.line - b.test.location.line)) {
      const relative = path.relative(rootDir, entry.test.location.file).split(path.sep);
      const group = relative.length > 2 ? relative[1] : relative[0];
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }

    const projectNames = [...new Set(entries.map(e => e.test.parent.project()?.name).filter(Boolean))];
    const baseURL = this.config.projects.find(p => p.use?.baseURL)?.use.baseURL ?? '';
    const pct = (n: number) => (total ? (n / total) * 100 : 0);
    const donut = `conic-gradient(var(--passed) 0 ${pct(counts.passed)}%, var(--flaky) 0 ${pct(counts.passed + counts.flaky)}%, var(--failed) 0 ${pct(counts.passed + counts.flaky + counts.failed)}%, var(--skipped) 0 100%)`;
    const overall: Status = counts.failed ? 'failed' : counts.flaky ? 'flaky' : 'passed';
    const title = this.options.title ?? 'HLS Sales List – Automated Test Report';

    const groupSections = [...groups.entries()]
      .map(([group, groupEntries]) => {
        const groupCounts = groupEntries.reduce((acc, { test }) => ((acc[statusOf(test)] = (acc[statusOf(test)] ?? 0) + 1), acc), {} as Partial<Record<Status, number>>);
        const bar = (['passed', 'flaky', 'failed', 'skipped'] as Status[])
          .filter(s => groupCounts[s])
          .map(s => `<span class="seg ${s}" style="flex:${groupCounts[s]}" title="${groupCounts[s]} ${STATUS_LABEL[s]}"></span>`)
          .join('');
        return `
        <section class="group" data-group="${escapeHtml(group)}">
          <header class="group-head">
            <h2>${escapeHtml(group.replace(/-/g, ' '))}</h2>
            <span class="group-meta">${groupEntries.length} test${groupEntries.length === 1 ? '' : 's'} · ${(['passed', 'flaky', 'failed', 'skipped'] as Status[])
              .filter(s => groupCounts[s])
              .map(s => `<span class="txt-${s}">${groupCounts[s]} ${STATUS_LABEL[s].toLowerCase()}</span>`)
              .join(' · ')}</span>
            <div class="mini-bar">${bar}</div>
          </header>
          ${groupEntries.map(entry => this.renderTest(entry, rootDir)).join('\n')}
        </section>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="hero ${overall}">
  <div class="hero-inner">
    <div>
      <div class="eyebrow">Playwright · ${escapeHtml(projectNames.join(', ') || 'all projects')}</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="hero-meta">
        <span>📅 ${escapeHtml(this.startedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
        <span>⏱ ${formatDuration(run.duration)}</span>
        ${baseURL ? `<span>🌐 ${escapeHtml(baseURL)}</span>` : ''}
      </div>
    </div>
    <div class="verdict ${overall}">${overall === 'passed' ? '✔ All tests passed' : overall === 'flaky' ? '⚠ Passed with flaky tests' : `✖ ${counts.failed} test${counts.failed === 1 ? '' : 's'} failed`}</div>
  </div>
</header>

<main>
  <section class="summary">
    <div class="donut-card">
      <div class="donut" style="background:${donut}"><div class="donut-hole"><strong>${passRate}%</strong><span>pass rate</span></div></div>
    </div>
    ${(['passed', 'failed', 'flaky', 'skipped'] as Status[])
      .map(s => `<button class="stat ${s}" data-filter="${s}"><span class="stat-num">${counts[s]}</span><span class="stat-label">${STATUS_LABEL[s]}</span></button>`)
      .join('')}
    <button class="stat total active" data-filter="all"><span class="stat-num">${total}</span><span class="stat-label">Total</span></button>
  </section>

  <div class="toolbar">
    <input id="search" type="search" placeholder="Search tests, steps, line items, users…" aria-label="Search tests">
    <div class="toolbar-actions">
      <button id="expand">Expand all</button>
      <button id="collapse">Collapse all</button>
      <button id="print">Print / PDF</button>
    </div>
  </div>
  <p id="empty" class="empty" hidden>No tests match the current filter.</p>

  ${groupSections}
</main>

<footer>Generated ${escapeHtml(new Date().toLocaleString('en-GB'))} · Playwright ${escapeHtml(this.config.version)} · ${total} tests</footer>

<div id="lightbox" hidden><img alt=""><button aria-label="Close">✕</button></div>
<script>${SCRIPT}</script>
</body>
</html>`;
  }

  private renderTest({ test, result }: Entry, rootDir: string): string {
    const status = statusOf(test);
    const title = test.titlePath().slice(3).join(' › ');
    const project = test.parent.project()?.name ?? '';
    const location = `${path.relative(rootDir, test.location.file).replace(/\\/g, '/')}:${test.location.line}`;

    const seen = new Set<string>();
    const annotations = [...test.annotations, ...((result as { annotations?: TestCase['annotations'] }).annotations ?? [])].filter(a => {
      const key = `${a.type}\u0000${a.description}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });

    const steps = result.steps.filter(s => s.category === 'test.step');
    const longestStep = Math.max(1, ...steps.map(s => s.duration));
    const errors = result.errors.map(e => stripAnsi(e.message ?? e.value ?? '')).filter(Boolean);

    const images: string[] = [];
    let videos = 0;
    for (const attachment of result.attachments) {
      if (attachment.contentType.startsWith('video/')) videos++;
      if (!attachment.contentType.startsWith('image/') || images.length >= MAX_IMAGES_PER_TEST) continue;
      const body = attachment.body ?? (attachment.path && fs.existsSync(attachment.path) ? fs.readFileSync(attachment.path) : undefined);
      if (!body || body.length > MAX_IMAGE_BYTES) continue;
      images.push(
        `<figure><img loading="lazy" src="data:${attachment.contentType};base64,${body.toString('base64')}" alt="${escapeHtml(attachment.name)}"><figcaption>${escapeHtml(attachment.name)}</figcaption></figure>`,
      );
    }

    const searchText = [title, project, location, ...annotations.map(a => `${a.type} ${a.description ?? ''}`), ...steps.map(s => s.title), ...errors]
      .join(' ')
      .toLowerCase();

    return `
    <details class="test ${status}" data-status="${status}" data-text="${escapeHtml(searchText)}"${status === 'failed' ? ' open' : ''}>
      <summary>
        <span class="badge ${status}">${STATUS_LABEL[status]}</span>
        <span class="test-title">${escapeHtml(title)}</span>
        <span class="test-meta">
          <span class="chip">${escapeHtml(project)}</span>
          ${result.retry ? `<span class="chip warn">retry ${result.retry}</span>` : ''}
          <span class="duration">${formatDuration(result.duration)}</span>
        </span>
      </summary>
      <div class="test-body">
        <div class="location">📄 ${escapeHtml(location)}</div>
        ${errors.length ? `<div class="block"><h3>Error</h3>${errors.map(e => `<pre class="error">${escapeHtml(e)}</pre>`).join('')}</div>` : ''}
        ${annotations.length ? `<div class="block"><h3>Details</h3><dl class="annotations">${annotations.map(renderAnnotation).join('')}</dl></div>` : ''}
        ${steps.length ? `<div class="block"><h3>Steps</h3><ol class="steps">${steps.map(s => renderStep(s, longestStep)).join('')}</ol></div>` : ''}
        ${images.length ? `<div class="block"><h3>Screenshots</h3><div class="shots">${images.join('')}</div></div>` : ''}
        ${videos ? `<p class="note">🎬 ${videos} video${videos === 1 ? '' : 's'} recorded. See the Playwright HTML report.</p>` : ''}
      </div>
    </details>`;
  }
}

function renderAnnotation(annotation: TestCase['annotations'][number]): string {
  const description = annotation.description ?? '';
  const parts = description.split(/;\s+|,\s+(?=\S+@)/).filter(Boolean);
  const value =
    parts.length > 2
      ? `<ul class="chips">${parts.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
      : `<span>${escapeHtml(description)}</span>`;
  return `<dt>${escapeHtml(annotation.type)}</dt><dd>${value}</dd>`;
}

function renderStep(step: TestStep, longest: number): string {
  const failed = !!step.error;
  const children = step.steps.filter(s => s.category === 'test.step');
  const width = Math.max(2, (step.duration / longest) * 100);
  return `<li class="step ${failed ? 'failed' : 'passed'}">
    <span class="step-icon">${failed ? '✖' : '✔'}</span>
    <span class="step-title">${escapeHtml(step.title)}</span>
    <span class="step-bar"><span style="width:${width}%"></span></span>
    <span class="step-time">${formatDuration(step.duration)}</span>
    ${failed ? `<pre class="error small">${escapeHtml(stripAnsi(step.error?.message ?? '').split('\n').slice(0, 6).join('\n'))}</pre>` : ''}
    ${children.length ? `<ol class="steps nested">${children.map(c => renderStep(c, longest)).join('')}</ol>` : ''}
  </li>`;
}

const STYLES = `
:root{--bg:#f4f6fb;--card:#fff;--text:#1d2433;--muted:#6b7385;--border:#e3e7ef;--passed:#1f9d55;--failed:#d64545;--flaky:#e0a100;--skipped:#9aa3b2;--accent:#3157d5;--shadow:0 1px 2px rgba(16,24,40,.06),0 4px 16px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0f131b;--card:#171c26;--text:#e6e9f0;--muted:#97a0b3;--border:#273041;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 "Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
.hero{color:#fff;background:linear-gradient(135deg,#1e2a4a,#3157d5)}
.hero.failed{background:linear-gradient(135deg,#3a1d27,#b23a48)}
.hero.flaky{background:linear-gradient(135deg,#3b2f12,#b07d00)}
.hero-inner{max-width:1200px;margin:0 auto;padding:32px 24px;display:flex;gap:24px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:12px;opacity:.8}
h1{margin:4px 0 10px;font-size:28px;font-weight:650}
.hero-meta{display:flex;gap:18px;flex-wrap:wrap;opacity:.9;font-size:13px}
.verdict{padding:10px 18px;border-radius:999px;background:rgba(255,255,255,.15);font-weight:600;font-size:15px;backdrop-filter:blur(4px)}
main{max-width:1200px;margin:-20px auto 0;padding:0 24px 40px}
.summary{display:grid;grid-template-columns:150px repeat(5,1fr);gap:14px;margin-bottom:18px}
.donut-card,.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
.donut-card{display:grid;place-items:center;padding:14px}
.donut{width:112px;height:112px;border-radius:50%;display:grid;place-items:center}
.donut-hole{width:80px;height:80px;border-radius:50%;background:var(--card);display:flex;flex-direction:column;align-items:center;justify-content:center}
.donut-hole strong{font-size:22px}.donut-hole span{font-size:11px;color:var(--muted)}
.stat{cursor:pointer;padding:18px;text-align:left;color:inherit;font:inherit;border-top:4px solid var(--skipped);transition:transform .12s}
.stat:hover{transform:translateY(-2px)}
.stat.active{outline:2px solid var(--accent);outline-offset:-2px}
.stat.passed{border-top-color:var(--passed)}.stat.failed{border-top-color:var(--failed)}.stat.flaky{border-top-color:var(--flaky)}.stat.total{border-top-color:var(--accent)}
.stat-num{display:block;font-size:30px;font-weight:700}.stat-label{color:var(--muted)}
.toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:8px 0 18px;flex-wrap:wrap}
#search{flex:1;min-width:240px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:inherit;font:inherit}
.toolbar-actions{display:flex;gap:8px}
.toolbar button{padding:9px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:inherit;font:inherit;cursor:pointer}
.toolbar button:hover{border-color:var(--accent)}
.group{margin-bottom:26px}
.group-head{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:baseline;margin-bottom:10px}
.group-head h2{margin:0;font-size:18px;text-transform:capitalize}
.group-meta{color:var(--muted);font-size:13px}
.mini-bar{grid-column:1/-1;display:flex;height:6px;border-radius:6px;overflow:hidden;background:var(--border)}
.seg.passed{background:var(--passed)}.seg.failed{background:var(--failed)}.seg.flaky{background:var(--flaky)}.seg.skipped{background:var(--skipped)}
.txt-passed{color:var(--passed)}.txt-failed{color:var(--failed)}.txt-flaky{color:var(--flaky)}.txt-skipped{color:var(--skipped)}
.test{background:var(--card);border:1px solid var(--border);border-left:5px solid var(--skipped);border-radius:12px;margin-bottom:10px;box-shadow:var(--shadow);overflow:hidden}
.test.passed{border-left-color:var(--passed)}.test.failed{border-left-color:var(--failed)}.test.flaky{border-left-color:var(--flaky)}
.test>summary{list-style:none;cursor:pointer;display:flex;gap:12px;align-items:center;padding:14px 16px}
.test>summary::-webkit-details-marker{display:none}
.test>summary::after{content:"▸";color:var(--muted);transition:transform .15s}
.test[open]>summary::after{transform:rotate(90deg)}
.test-title{flex:1;font-weight:550}
.test-meta{display:flex;gap:8px;align-items:center;color:var(--muted);white-space:nowrap}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:999px;color:#fff;background:var(--skipped)}
.badge.passed{background:var(--passed)}.badge.failed{background:var(--failed)}.badge.flaky{background:var(--flaky)}
.chip{font-size:12px;padding:2px 8px;border-radius:6px;background:var(--bg);border:1px solid var(--border)}
.chip.warn{color:var(--flaky);border-color:var(--flaky)}
.duration{font-variant-numeric:tabular-nums;min-width:70px;text-align:right}
.test-body{padding:0 18px 18px;border-top:1px solid var(--border)}
.location{color:var(--muted);font-size:12px;margin:12px 0}
.block h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 8px}
.annotations{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}
.annotations dt{font-weight:600;text-transform:capitalize}
.annotations dd{margin:0;word-break:break-word}
.chips{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px}
.chips li{font-size:12px;padding:2px 8px;border-radius:6px;background:var(--bg);border:1px solid var(--border)}
.steps{list-style:none;padding:0;margin:0}
.steps.nested{margin:6px 0 0 26px}
.step{display:grid;grid-template-columns:22px 1fr 160px 80px;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--border)}
.step:last-child{border-bottom:0}
.step>pre,.step>.steps{grid-column:2/-1}
.step-icon{font-weight:700}.step.passed .step-icon{color:var(--passed)}.step.failed .step-icon{color:var(--failed)}
.step-bar{height:6px;background:var(--bg);border-radius:6px;overflow:hidden}
.step-bar span{display:block;height:100%;background:var(--accent);opacity:.55;border-radius:6px}
.step.failed .step-bar span{background:var(--failed)}
.step-time{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
pre.error{background:rgba(214,69,69,.08);border:1px solid rgba(214,69,69,.35);color:var(--text);padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font:12px/1.5 Consolas,"Cascadia Code",monospace;margin:0 0 8px}
pre.error.small{padding:8px;margin-top:6px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.shots figure{margin:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)}
.shots img{display:block;width:100%;height:150px;object-fit:cover;object-position:top;cursor:zoom-in}
.shots figcaption{font-size:11px;padding:6px 8px;color:var(--muted);word-break:break-all}
.note{color:var(--muted);font-size:12px}
.empty{text-align:center;color:var(--muted);padding:40px}
#lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:grid;place-items:center;z-index:10;padding:30px}
#lightbox[hidden]{display:none}
#lightbox img{max-width:100%;max-height:100%;border-radius:8px}
#lightbox button{position:absolute;top:16px;right:20px;font-size:22px;color:#fff;background:none;border:0;cursor:pointer}
footer{text-align:center;color:var(--muted);font-size:12px;padding:20px}
@media (max-width:800px){.summary{grid-template-columns:repeat(2,1fr)}.donut-card{grid-column:1/-1}.step{grid-template-columns:22px 1fr 70px}.step-bar{display:none}}
@media print{.toolbar,#lightbox{display:none}.test{break-inside:avoid;box-shadow:none}main{margin-top:0}body{background:#fff}}
`;

const SCRIPT = `
(() => {
  const tests = [...document.querySelectorAll('.test')];
  const groups = [...document.querySelectorAll('.group')];
  const stats = [...document.querySelectorAll('.stat')];
  const search = document.getElementById('search');
  let filter = 'all';
  function apply() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    tests.forEach(t => {
      const ok = (filter === 'all' || t.dataset.status === filter) && (!q || t.dataset.text.includes(q));
      t.hidden = !ok;
      if (ok) shown++;
    });
    groups.forEach(g => (g.hidden = !g.querySelector('.test:not([hidden])')));
    document.getElementById('empty').hidden = shown > 0;
  }
  stats.forEach(s => s.addEventListener('click', () => {
    filter = s.dataset.filter;
    stats.forEach(x => x.classList.toggle('active', x === s));
    apply();
  }));
  search.addEventListener('input', apply);
  document.getElementById('expand').onclick = () => tests.forEach(t => !t.hidden && (t.open = true));
  document.getElementById('collapse').onclick = () => tests.forEach(t => (t.open = false));
  document.getElementById('print').onclick = () => { tests.forEach(t => (t.open = true)); window.print(); };
  const lightbox = document.getElementById('lightbox');
  document.querySelectorAll('.shots img').forEach(img => img.addEventListener('click', () => {
    lightbox.querySelector('img').src = img.src;
    lightbox.hidden = false;
  }));
  lightbox.addEventListener('click', () => (lightbox.hidden = true));
  document.addEventListener('keydown', e => e.key === 'Escape' && (lightbox.hidden = true));
})();
`;
