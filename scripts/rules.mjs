import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { domainToASCII } from 'node:url';

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const n = (ip) => ip.split('.').reduce((address, octet) => address * 256 + Number(octet), 0);
const NON_PUBLIC = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
].map(([ip, prefix]) => [n(ip), n(ip) + 2 ** (32 - prefix)]);

export function normalizeRule(type, value) {
  if (typeof value !== 'string') return null;
  if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') {
    if (/[\/\\:@%?#\s,*]/.test(value)) return null;
    const domain = domainToASCII(value.replace(/\.$/, '').toLowerCase());
    return DOMAIN.test(domain) && !isIPv4(domain) ? `${type},${domain}` : null;
  }
  if (type === 'IP-CIDR' && /^\d{1,3}(?:\.\d{1,3}){3}\/(?:[1-9]|[12]\d|3[0-2])$/.test(value)) {
    const [ip, prefix] = value.split('/');
    if (!isIPv4(ip)) return null;
    const size = 2 ** (32 - Number(prefix));
    const from = n(ip);
    if (from % size || NON_PUBLIC.some(([a, b]) => a < from + size && from < b)) return null;
    return `IP-CIDR,${value}`;
  }
  return null;
}

export function extractRules(text, format) {
  const rules = new Set();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[^\]]+\]$/.test(line)) {
      section = line.toLowerCase();
      continue;
    }
    if (format === 'shadowrocket-conf' && section !== '[rule]') continue;
    const [type, value, policy, option, extra] = line.split(',').map((field) => field.trim());
    let result;
    if (format === 'shadowrocket-domain-set') {
      result = normalizeRule(line.startsWith('.') ? 'DOMAIN-SUFFIX' : 'DOMAIN', line.replace(/^\./, ''));
    } else if (format === 'local') {
      if (policy === undefined) result = normalizeRule(type, value);
      if (!result) throw new Error(`Invalid local routing rule: ${line}`);
    } else if (policy?.toUpperCase() === 'PROXY' && !extra && (!option || option === 'no-resolve')) {
      result = normalizeRule(type.toUpperCase(), value);
    }
    if (result) rules.add(result);
  }
  return [...rules].sort();
}

export function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function isStale(date, now) {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  const days = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, days));
  return Date.parse(date) < cutoff.getTime();
}

function covers(rules, rule) {
  if (rules.has(rule)) return true;
  const [type, domain] = rule.split(',');
  if (!type.startsWith('DOMAIN')) return false;
  const labels = domain.split('.');
  return labels.some((_, index) => rules.has(`DOMAIN-SUFFIX,${labels.slice(index).join('.')}`));
}

export function mergeRules(direct, localProxy, sources) {
  const local = new Set(direct);
  const own = localProxy.filter((rule) => !covers(local, rule));
  const seen = new Set([...local, ...own]);
  const proxy = sources.map(({ rules, ...source }) => {
    // Less specific suffixes can make subdomains in the same or a later source redundant.
    const suffixFirst = [...rules].sort((a, b) => {
      const score = (rule) => rule.startsWith('DOMAIN-SUFFIX,') ? rule.split('.').length : Infinity;
      return (score(a) - score(b)) || a.localeCompare(b, 'en');
    });
    const selected = [];
    for (const rule of suffixFirst) {
      const domain = rule.split(',')[1];
      if ((rule.startsWith('DOMAIN') && domain.endsWith('.cn')) || covers(seen, rule)) continue;
      selected.push(rule);
      seen.add(rule);
    }
    return { ...source, rules: selected.sort() };
  });
  return { direct, own, proxy };
}

export function renderRules(rules, policy) {
  return rules.map((rule) => rule.startsWith('IP-CIDR,')
    ? `${rule},${policy},no-resolve`
    : `${rule},${policy}${policy === 'PROXY' ? ',force-remote-dns' : ''}`);
}
