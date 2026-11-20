import { extractRules, hash, isStale } from './rules.mjs';
import { fetchText, fileUpdatedAt } from './fetch.mjs';

export const textFile = (lines) => `${lines.join('\n')}\n`;

async function upstreamDate(text, source) {
  const build = text.match(/^# build time: UTC (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/m);
  if (build) return `${build[1]}T${build[2]}Z`;
  const updated = text.match(/^# UPDATED: (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/m);
  if (updated) return `${updated[1]}T${updated[2]}+08:00`;
  if (source.history) return fileUpdatedAt(source.history);
  throw new Error('upstream did not include its publication date');
}

export function snapshotPath(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('Invalid source id');
  return `snapshots/${id}.list`;
}

export async function resolveSource(source, previous, now, { download = fetchText, readSnapshot, saveSnapshot }) {
  const identity = { id: source.id, project: source.project, license: source.license };
  const path = snapshotPath(source.id);
  if (!Number.isInteger(source.minimumRules) || source.minimumRules < 1 ||
    !['shadowrocket-conf', 'shadowrocket-rule-list', 'shadowrocket-domain-set'].includes(source.format)) {
    throw new Error(`${source.id}: invalid source validation settings`);
  }
  const failures = [];
  for (const url of [source.mainUrl, source.mirrorUrl].filter(Boolean)) {
    try {
      const text = await download(url);
      const snapshot = extractRules(text, source.format);
      if (snapshot.length < source.minimumRules) throw new Error(`only ${snapshot.length} valid rules`);
      const inputSha256 = hash(textFile(snapshot));
      const lastDate = previous?.lastRuleChange;
      const sameRules = previous?.inputSha256 === inputSha256 && lastDate;
      const date = sameRules ? Date.parse(lastDate) : Date.parse(await upstreamDate(text, source));
      if (!Number.isFinite(date) || date > now.getTime() + 300_000) throw new Error('invalid upstream publication date');
      if (!sameRules && lastDate && date < Date.parse(lastDate)) throw new Error('older upstream revision');
      const lastRuleChange = new Date(Math.min(date, now.getTime())).toISOString();
      const active = !isStale(lastRuleChange, now);
      const attribution = `# ${source.project} — ${source.license}; normalized rules from ${source.mainUrl}`;
      saveSnapshot(path, textFile([attribution, ...snapshot]));
      return {
        ...identity, active, status: active ? 'live' : 'retired', verified: true,
        lastRuleChange, inputCount: snapshot.length, inputSha256, rules: active ? snapshot : [],
      };
    } catch (error) {
      failures.push(error.message);
    }
  }
  console.warn(`${source.id}: ${failures.join('; ')}`);
  if (previous?.inputSha256) {
    const { active, lastRuleChange, inputCount, inputSha256 } = previous;
    if (!active) {
      return { ...identity, active, status: 'retired', verified: false, lastRuleChange, inputCount, inputSha256, rules: [] };
    }
    const snapshot = extractRules(await readSnapshot(path), 'local');
    if (snapshot.length !== inputCount || hash(textFile(snapshot)) !== inputSha256) {
      throw new Error(`${source.id}: snapshot does not match the previous verified release`);
    }
    return { ...identity, active, status: 'cached', verified: false, lastRuleChange, inputCount, inputSha256, rules: snapshot };
  }
  return { ...identity, active: false, status: 'unavailable', verified: false, lastRuleChange: null, inputCount: 0, inputSha256: null, rules: [] };
}
