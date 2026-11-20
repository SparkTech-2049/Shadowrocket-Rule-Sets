import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extractRules } from './rules.mjs';
import { discoverSources } from './discovery.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
try {
  const [approved, previous, direct, proxy] = await Promise.all([
    read('sources.json').then(JSON.parse),
    read('reports/candidates.json').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return { repositories: [] };
      throw error;
    }),
    read('dist/direct.list').then((text) => extractRules(text, 'shadowrocket-rule-list')),
    read('dist/proxy.list').then((text) => extractRules(text, 'shadowrocket-rule-list')),
  ]);
  if (!direct.length || !proxy.length) throw new Error('published rule baseline is incomplete');
  const repositories = await discoverSources(approved, previous, direct, proxy, new Date());
  await mkdir(new URL('reports/', root), { recursive: true });
  await writeFile(new URL('reports/candidates.json', root), `${JSON.stringify({ version: 1, repositories }, null, 2)}\n`, 'utf8');
  console.log(`Checked ${repositories.length} repositories; ${repositories.filter(({ state }) => state === 'candidate').length} candidates found`);
} catch (error) {
  console.error(`Source discovery failed: ${error.message}`);
  process.exitCode = 1;
}
