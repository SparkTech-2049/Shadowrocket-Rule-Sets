import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractRules, hash, mergeRules, renderRules } from './rules.mjs';
import { resolveSource, textFile } from './sources.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const now = new Date();

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

  if (!config.length || new Set(config.map(({ id }) => id)).size !== config.length) {
    throw new Error('source list must contain unique source ids');
  }
  const snapshots = new Map();
  const fetched = await Promise.all(config.map((source) => resolveSource(
    source,
    previous.sources.find(({ id }) => id === source.id),
    now,
    { readSnapshot: read, saveSnapshot: (path, body) => snapshots.set(path, body) },
  )));
  if (!fetched.some(({ verified }) => verified)) throw new Error('no upstream could be verified');
  const direct = extractRules(directText, 'local');
  const proxy = extractRules(proxyText, 'local');
  const result = mergeRules(direct, proxy, fetched);
  const directLines = renderRules(result.direct, 'DIRECT');
  const baseLines = renderRules(result.own, 'PROXY');
  const sections = (format) => result.proxy.flatMap(({ id, project, license, rules }) => rules.length
    ? [`# ${id} — ${project} — ${license}; normalized and deduplicated`, ...format(rules)]
    : []);
  const bundle = textFile(['# Shadowrocket-Rule-Sets v1', ...directLines, ...baseLines, ...sections((rules) => renderRules(rules, 'PROXY'))]);
  const ruleCount = directLines.length + baseLines.length + result.proxy.reduce((sum, item) => sum + item.rules.length, 0);
  if (ruleCount < 50 || Buffer.byteLength(bundle) > 3_000_000) throw new Error('aggregate rule count or file size is out of bounds');
  const manifest = {
    version: 1, sha256: hash(bundle), bytes: Buffer.byteLength(bundle), ruleCount,
    localDirectCount: directLines.length, localProxyCount: baseLines.length,
    sources: result.proxy.map(({ rules, verified, ...source }) => ({ ...source, publishedCount: rules.length })),
  };
  const files = {
    'direct.list': textFile(result.direct),
    'proxy.list': textFile([...result.own, ...sections((rules) => rules)]),
    'shadowrocket.rules': bundle,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
  await Promise.all(['dist/', 'snapshots/'].map((path) => mkdir(new URL(path, root), { recursive: true })));
  await Promise.all([
    ...Object.entries(files).map(([filename, body]) => writeFile(new URL(`dist/${filename}`, root), body, 'utf8')),
    ...[...snapshots].map(([path, body]) => writeFile(new URL(path, root), body, 'utf8')),
  ]);
  console.log(`Compiled ${ruleCount} rules (${manifest.bytes} bytes)`);
  for (const source of manifest.sources) {
    console.log(`${source.id}: ${source.status}, ${source.publishedCount} rules; content last changed ${source.lastRuleChange ?? 'unknown'}`);
  }
} catch (error) {
  console.error(`Rule collection failed: ${error.message}`);
  process.exitCode = 1;
}
