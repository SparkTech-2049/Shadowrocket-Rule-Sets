import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash, mergeRules } from '../scripts/rules.mjs';
import { resolveSource, textFile } from '../scripts/sources.mjs';

const day = new Date('2026-11-20T00:00:00Z');
const source = (id) => ({
  id, project: `https://github.com/example/${id}`, license: 'MIT',
  format: 'shadowrocket-domain-set', mainUrl: `https://example.com/${id}`, minimumRules: 1,
});
const snapshot = (domain) => textFile([`DOMAIN-SUFFIX,${domain}`]);
const previous = (domain, lastRuleChange = '2026-10-20T00:00:00Z', active = true) => ({
  active, lastRuleChange, inputCount: 1, inputSha256: hash(snapshot(domain)),
});

test('publishes a healthy source alongside another source’s verified cached rules', async () => {
  const options = {
    download: async (url) => {
      if (url.endsWith('/failed')) throw new Error('temporary timeout');
      return '# UPDATED: 2026-11-19 08:30:00\n.new.example\n';
    },
    readSnapshot: async () => snapshot('kept.example'),
    saveSnapshot: () => {},
  };
  const [cached, live] = await Promise.all([
    resolveSource(source('failed'), previous('kept.example'), day, options),
    resolveSource(source('healthy'), previous('old.example'), day, options),
  ]);
  assert.equal(cached.status, 'cached');
  assert.equal(cached.verified, false);
  assert.equal(live.verified, true);
  assert.deepEqual(mergeRules([], [], [cached, live]).proxy.map(({ rules }) => rules), [
    ['DOMAIN-SUFFIX,kept.example'], ['DOMAIN-SUFFIX,new.example'],
  ]);
});

test('checks the snapshot digest before reusing it after validation failure', async () => {
  await assert.rejects(resolveSource(source('invalid'), previous('kept.example'), day, {
    download: async () => '<html>not rules</html>',
    readSnapshot: async () => snapshot('wrong.example'),
    saveSnapshot: () => assert.fail('invalid download replaced the snapshot'),
  }), /snapshot does not match/);
});

test('retires confirmed stale content and restores a source when it publishes new rules', async () => {
  const retired = await resolveSource(source('aged'), previous('old.example', '2026-07-13T00:00:00Z'), day, {
    download: async () => '# UPDATED: 2026-11-19 08:30:00\n.old.example\n',
    saveSnapshot: () => {},
  });
  assert.equal(retired.status, 'retired');
  assert.equal(retired.lastRuleChange, '2026-07-13T00:00:00.000Z');
  assert.deepEqual(retired.rules, []);
  const stillRetired = await resolveSource(source('aged'), retired, day, {
    download: async () => { throw new Error('temporary timeout'); },
    saveSnapshot: () => {},
  });
  assert.deepEqual(stillRetired.rules, []);
  const live = await resolveSource(source('aged'), retired, day, {
    download: async () => '# UPDATED: 2026-11-19 08:30:00\n.new.example\n',
    saveSnapshot: () => {},
  });
  assert.equal(live.status, 'live');
  assert.deepEqual(live.rules, ['DOMAIN-SUFFIX,new.example']);
});

test('leaves an unavailable new source out of the published rules', async () => {
  const result = await resolveSource(source('new'), undefined, day, {
    download: async () => { throw new Error('not found'); },
    saveSnapshot: () => assert.fail('a failed download must not write a snapshot'),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.active, false);
  assert.deepEqual(result.rules, []);
});
