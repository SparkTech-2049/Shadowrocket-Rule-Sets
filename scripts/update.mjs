import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractRules, hash, isStale, mergeRules, renderRules } from './rules.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const limit = 8_000_000;
const now = new Date();

async function download(source) {
  const failures = [];
  for (const url of [source.mainUrl, source.mirrorUrl].filter(Boolean)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > limit) throw new Error('upstream file exceeds eight megabytes');
      const rules = extractRules(text, source.format);
      if (rules.length < source.minimumRules) throw new Error(`only ${rules.length} valid rules`);
      return { rules, text };
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`${source.id}: ${failures.join('; ')}`);
}

function upstreamDate(text, format) {
  const match = format === 'shadowrocket-conf'
    ? text.match(/^# build time: UTC (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/m)
    : text.match(/^# UPDATED: (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/m);
  if (!match) throw new Error('upstream did not include its publication date');
  const date = Date.parse(`${match[1]}T${match[2]}${format === 'shadowrocket-conf' ? 'Z' : '+08:00'}`);
  if (!Number.isFinite(date) || date > now.getTime() + 300_000) throw new Error('invalid upstream publication date');
  return new Date(Math.min(date, now.getTime())).toISOString();
}

function textFile(lines) {
  return `${lines.join('\n')}\n`;
}

try {
  const [config, previous, directText, proxyText] = await Promise.all([
    read('sources.json').then(JSON.parse),
    read('dist/manifest.json').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return { sources: [] };
      throw error;
    }),
    read('rules/direct.list'),
    read('rules/proxy.list'),
  ]);

  const fetched = await Promise.all(config.map(async (source) => {
    const { rules, text } = await download(source);
    const digest = hash(textFile(rules));
    const stored = previous.sources.find(({ id }) => id === source.id);
    const sourceDate = upstreamDate(text, source.format);
    const lastRuleChange = stored?.inputSha256 === digest ? stored.lastRuleChange : sourceDate;
    const active = !isStale(lastRuleChange, now);
    return {
      id: source.id, project: source.project, license: source.license, active,
      lastRuleChange, inputCount: rules.length, inputSha256: digest, rules: active ? rules : [],
    };
  }));
  const direct = extractRules(directText, 'local');
  const proxy = extractRules(proxyText, 'local');
  const result = mergeRules(direct, proxy, fetched);
  const directLines = renderRules(result.direct, 'DIRECT');
  const baseLines = renderRules(result.own, 'PROXY');
  const linesBySource = result.proxy.map(({ rules, ...source }) => ({ ...source, lines: renderRules(rules, 'PROXY') }));
  const sections = linesBySource.flatMap(({ id, project, license, lines }) => lines.length
    ? [`# ${id} — ${project} — ${license}; normalized and deduplicated`, ...lines]
    : []);
  const bundle = textFile(['# Shadowrocket-Rule-Sets v1', ...directLines, ...baseLines, ...sections]);
  const ruleCount = directLines.length + baseLines.length + linesBySource.reduce((sum, item) => sum + item.lines.length, 0);
  if (ruleCount < 50 || Buffer.byteLength(bundle) > 3_000_000) throw new Error('aggregate rule count or file size is out of bounds');
  const manifest = {
    version: 1, sha256: hash(bundle), bytes: Buffer.byteLength(bundle), ruleCount,
    localDirectCount: directLines.length, localProxyCount: baseLines.length,
    sources: linesBySource.map(({ lines, ...source }) => ({ ...source, publishedCount: lines.length })),
  };
  const files = {
    'direct.list': textFile(directLines),
    'proxy.list': textFile([...baseLines, ...sections]),
    'shadowrocket.rules': bundle,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
  await mkdir(new URL('dist/', root), { recursive: true });
  await Promise.all(Object.entries(files).map(([filename, body]) => writeFile(new URL(`dist/${filename}`, root), body, 'utf8')));
  console.log(`Compiled ${ruleCount} rules (${manifest.bytes} bytes)`);
  for (const source of manifest.sources) {
    console.log(`${source.id}: ${source.active ? source.publishedCount + ' rules' : 'skipped as stale'}; rules updated ${source.lastRuleChange}`);
  }
} catch (error) {
  console.error(`Rule collection failed: ${error.message}`);
  process.exitCode = 1;
}
