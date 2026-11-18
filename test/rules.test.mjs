import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { extractRules, hash, isStale, mergeRules, normalizeRule, renderRules } from '../scripts/rules.mjs';

test('reads routing rules from the proxy section only and rejects broad or unsafe rule types', () => {
  const input = `[General]
DOMAIN-SUFFIX,outside.example,PROXY
[Rule]
DOMAIN-SUFFIX,example.COM.,Proxy
DOMAIN-SUFFIX,example.com,Proxy
DOMAIN,abc.example.org,PROXY
DOMAIN,blocked.example,REJECT
DOMAIN-KEYWORD,wide,PROXY
RULE-SET,https://example.org/list,PROXY
IP-CIDR,91.108.4.0/22,PROXY,no-resolve
IP-CIDR,10.0.0.0/8,PROXY,no-resolve
IP-CIDR,0.0.0.0/0,PROXY,no-resolve
FINAL,PROXY
[Script]
DOMAIN-SUFFIX,wrong.example,PROXY`;
  assert.deepEqual(extractRules(input, 'shadowrocket-conf'), [
    'DOMAIN,abc.example.org', 'DOMAIN-SUFFIX,example.com', 'IP-CIDR,91.108.4.0/22',
  ]);
  assert.equal(normalizeRule('DOMAIN-SUFFIX', 'https://foo.com'), null);
});

test('protects domestic suffixes and deduplicates across ordered sources', () => {
  const base = ['DOMAIN-SUFFIX,apple.com', 'DOMAIN-SUFFIX,qq.com'];
  const result = mergeRules(base, ['DOMAIN-SUFFIX,example.net'], [
    { id: 'first', rules: ['DOMAIN,cdn.example.org', 'DOMAIN-SUFFIX,example.org', 'DOMAIN-SUFFIX,child.example.org', 'DOMAIN,account.apple.com'] },
    { id: 'second', rules: ['DOMAIN,mp.weixin.qq.com', 'DOMAIN,x.example.org', 'DOMAIN-SUFFIX,site.cn', 'DOMAIN,example.net', 'DOMAIN,remaining.example.io'] },
  ]);
  assert.deepEqual(result.proxy.map(({ rules }) => rules), [['DOMAIN-SUFFIX,example.org'], ['DOMAIN,remaining.example.io']]);
  assert.deepEqual(renderRules(result.own, 'PROXY'), ['DOMAIN-SUFFIX,example.net,PROXY,force-remote-dns']);
});

test('expires a source after three calendar months, including an end-of-month cutoff', () => {
  const today = new Date('2026-05-31T00:00:00Z');
  assert.equal(isStale('2026-02-27T23:59:59Z', today), true);
  assert.equal(isStale('2026-02-28T00:00:00Z', today), false);
});

test('tracks normalized content rather than timestamps or ordering', () => {
  const a = extractRules('# UPDATED: yesterday\n.b.example\na.example', 'shadowrocket-domain-set');
  const b = extractRules('# UPDATED: today\na.example\n.b.example\n.b.example', 'shadowrocket-domain-set');
  assert.equal(hash(a.join('\n')), hash(b.join('\n')));
});

test('maintains the local safety net when upstreams are excluded', async () => {
  const local = async (file) => extractRules(await readFile(new URL(`../rules/${file}`, import.meta.url), 'utf8'), 'local');
  const result = mergeRules(await local('direct.list'), await local('proxy.list'), []);
  for (const domain of ['douyinvod.com', 'amemv.com', 'qq.com', 'apple.com']) {
    assert(result.direct.includes(`DOMAIN-SUFFIX,${domain}`));
  }
  for (const domain of ['youtube.com', 'github.com', 'tiktok.com', 'telegram.org']) {
    assert(result.own.includes(`DOMAIN-SUFFIX,${domain}`));
  }
});
