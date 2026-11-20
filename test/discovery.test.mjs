import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCoverage, discoverSources, linkedRepositories, rankedRulePaths, readCandidateRules } from '../scripts/discovery.mjs';

test('follows references without rediscovering the project itself', () => {
  const docs = ['https://github.com/Owner/Things', 'https://raw.githubusercontent.com/TEST/List/main/proxy.list', 'https://github.com/test/list/issues'].join('\n');
  assert.deepEqual(linkedRepositories(docs, 'owner/things'), ['test/list']);
});

test('looks for stable Shadowrocket proxy files ahead of generic configurations', () => {
  const paths = ['shadowrocket/Proxy_Domain.list', 'sr_proxy_list.module', 'Clash/ProxyGFWlist.list', 'backup/shadowrocket/Proxy.list', 'main.conf', 'dist/shadowrocket/adblock.list', 'data/runs/latest/shadowrocket/Global.list', 'shadowrocket/Direct.list'];
  assert.deepEqual(rankedRulePaths(paths.map((path) => ({ path, type: 'blob', size: 100 }))), [
    'shadowrocket/Proxy_Domain.list', 'sr_proxy_list.module', 'Clash/ProxyGFWlist.list', 'main.conf',
  ]);
});

test('counts actual additional coverage and finds direct-route conflicts', () => {
  const direct = ['DOMAIN,login.firm.example', 'DOMAIN-SUFFIX,apple.com'];
  const proxy = ['DOMAIN-SUFFIX,already.example'];
  const rules = [
    'DOMAIN-SUFFIX,firm.example', 'DOMAIN,account.apple.com', 'DOMAIN-SUFFIX,movie.cn',
    'DOMAIN,something.already.example', 'DOMAIN-SUFFIX,new.example', 'DOMAIN,api.new.example',
  ];
  assert.deepEqual(assessCoverage(rules, direct, proxy), {
    inputCount: 6, conflictsWithDirect: 3, alreadyCoveredOrRedundant: 2, additionalRules: 1,
    examples: ['DOMAIN-SUFFIX,new.example'],
  });
});

test('parses policy-free lists without treating explicitly direct rules as proxy candidates', () => {
  const text = 'DOMAIN-SUFFIX,valid.example\nDOMAIN,domestic.example,DIRECT\nIP-CIDR,91.108.4.0/22,no-resolve';
  assert.deepEqual(readCandidateRules(text, 'proxy.list'), {
    format: 'shadowrocket-rule-list',
    rules: ['DOMAIN-SUFFIX,valid.example', 'IP-CIDR,91.108.4.0/22'],
  });
  assert.deepEqual(readCandidateRules('[Rule]\nDOMAIN,only.example,PROXY\n[Script]\nDOMAIN,excluded.example,PROXY', 'sr_proxy_list.module'), {
    format: 'shadowrocket-conf', rules: ['DOMAIN,only.example'],
  });
});

test('reports a new published file and retires a known fingerprint despite recent pushes', async (t) => {
  const repository = {
    full_name: 'example/routing', html_url: 'https://github.com/example/routing', default_branch: 'main',
    pushed_at: '2026-11-20T00:00:00Z', license: { spdx_id: 'MIT' },
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    if (path === '/search/repositories') return Response.json({ items: [repository] });
    if (path.endsWith('/git/trees/main')) return Response.json({ tree: [
      { type: 'blob', path: 'README.md', size: 100 },
    ] });
    if (path.endsWith('/main/README.md')) return new Response([
      '## Sources', '- https://github.com/evidence/source',
      '## Downloads', '- https://raw.githubusercontent.com/example/routing/release/proxy.list',
    ].join('\n'));
    if (path.endsWith('/release/proxy.list')) return new Response('DOMAIN-SUFFIX,new.example');
    if (path.endsWith('/commits')) return Response.json([{ commit: { committer: { date: '2026-11-19T00:00:00Z' } } }]);
    throw new Error(`Unexpected path ${path}`);
  });
  const now = new Date('2026-11-20T00:00:00Z');
  const [candidate] = await discoverSources([], { repositories: [] }, [], [], now);
  assert.equal(candidate.state, 'candidate');
  assert.equal(candidate.ref, 'release');
  assert.equal(candidate.coverage.additionalRules, 1);
  assert.deepEqual(candidate.sources, ['evidence/source']);
  const previous = [{ ...candidate, lastRuleChange: '2026-07-19T00:00:00Z' }];
  const [stale] = await discoverSources([], { repositories: previous }, [], [], now);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.lastRuleChange, previous[0].lastRuleChange);
});
