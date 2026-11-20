import { fetchText, fileUpdatedAt, github, repoPattern } from './fetch.mjs';
import { covers, extractRules, freshnessCutoff, hash, isStale, mergeRules } from './rules.mjs';
import { textFile } from './sources.mjs';

const MAX_REPOSITORIES = 12;
const REUSE_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'GPL-2.0', 'GPL-2.0-only',
  'GPL-3.0', 'GPL-3.0-only', 'MPL-2.0', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'Unlicense',
]);
const raw = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref.split('/').map(encodeURIComponent).join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`;

export function linkedRepositories(text, self) {
  const links = text.matchAll(/https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+)/gi);
  return [...new Set([...links].map((match) => match[1].replace(/(?:\.git|\.)$/, '').toLowerCase()))]
    .filter((repo) => repoPattern.test(repo) && repo !== self.toLowerCase());
}

function sourceReferences(readme, repo) {
  const lines = readme.split(/\r?\n/);
  let inSection = false;
  return [...new Set(lines.flatMap((line) => {
    const mentionsOrigin = /数据来源|规则来源|上游|来源|参考|鸣谢|致谢|source|upstream|attribution|credits|references/i.test(line);
    if (/^#{1,6}\s/.test(line)) inSection = mentionsOrigin;
    return inSection || mentionsOrigin ? linkedRepositories(line, repo) : [];
  }))].sort();
}

function rulePathScore(path) {
  const pieces = path.toLowerCase().split('/');
  const name = pieces.at(-1);
  if (pieces.some((part) => /^(?:backups?|history|runs|snapshots?|tests?|fixtures?|modules?|scripts?|images?)$/.test(part))) return 0;
  if (!/\.(?:list|txt|conf|module)$/.test(name) || /adblock|advert|reject|white|direct|domestic|backcn|_resolve|_ipv6|sample|example/.test(name)) return 0;
  const shadowrocket = pieces.some((part) => part === 'shadowrocket' || part === 'sr') || /shadowrocket|^sr_/.test(name);
  const proxyName = /banlist|blacklist|gfw|proxy|global|overseas/.test(name);
  const rootConfig = pieces.length === 1 && /\.conf$/.test(name);
  if (shadowrocket && proxyName) return 5 + Number(name.endsWith('_domain.list'));
  if (proxyName && (pieces.length === 1 || pieces.includes('clash') || pieces.includes('ruleset'))) return 4;
  if (shadowrocket && /\.conf$/.test(name)) return 3;
  return rootConfig ? 1 : 0;
}

export function rankedRulePaths(tree) {
  return tree.filter(({ type, size, path }) => type === 'blob' && size > 0 && size <= 4_000_000 && rulePathScore(path) > 0)
    .map(({ path }) => path)
    .sort((a, b) => rulePathScore(b) - rulePathScore(a) || a.localeCompare(b, 'en'));
}

function documentedFiles(readme, repo) {
  const links = readme.matchAll(/https:\/\/raw\.githubusercontent\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+)\/(?:refs\/heads\/)?([a-z0-9_.-]+)\/([a-z0-9_./-]+)/gi);
  return [...links].filter(([, target, , path]) => target.toLowerCase() === repo.toLowerCase() && rulePathScore(path) > 0)
    .map(([, , ref, path]) => ({ ref, path }));
}

export function readCandidateRules(text, path) {
  const format = /\.(?:conf|module)$/i.test(path) ? 'shadowrocket-conf'
    : /^(?:DOMAIN(?:-SUFFIX)?|IP-CIDR),/m.test(text) ? 'shadowrocket-rule-list' : 'shadowrocket-domain-set';
  return { format, rules: extractRules(text, format) };
}

async function readRepositoryTree(repository, ref) {
  const endpoint = `/repos/${repository}/git/trees/`;
  try {
    const { tree, truncated } = await github(`${endpoint}${encodeURIComponent(ref)}?recursive=1`);
    if (!truncated) return tree;
  } catch (error) {
    if (error.message !== 'response exceeds the size limit') throw error;
  }
  const root = (await github(`${endpoint}${encodeURIComponent(ref)}`)).tree;
  const entries = [...root];
  const descend = ({ type, path }) => type === 'tree'
    && /^(?:data|dist|generated|artifacts|shadowrocket|sr|rules?|rulesets?|clash|proxy|global)$/i.test(path.split('/').at(-1));
  const queue = root.filter(descend);
  for (let index = 0; index < Math.min(queue.length, 14); index++) {
    const parent = queue[index];
    const branch = (await github(`${endpoint}${parent.sha}`)).tree.map((entry) => ({
      ...entry, path: `${parent.path}/${entry.path}`,
    }));
    entries.push(...branch);
    queue.push(...branch.filter(descend));
  }
  return entries;
}

export function assessCoverage(rules, direct, proxy) {
  const directKeys = new Set(direct);
  const proxyKeys = new Set(proxy);
  const ancestors = new Set();
  for (const rule of direct) {
    const [type, domain] = rule.split(',');
    if (!type.startsWith('DOMAIN')) continue;
    const labels = domain.split('.');
    for (let index = 0; index < labels.length - 1; index++) ancestors.add(labels.slice(index).join('.'));
  }
  const usable = rules.filter((rule) => {
    const [type, value] = rule.split(',');
    return !covers(directKeys, rule) && !(type.startsWith('DOMAIN') && value.endsWith('.cn'))
      && !(type === 'DOMAIN-SUFFIX' && ancestors.has(value));
  });
  const newRows = usable.filter((rule) => !covers(proxyKeys, rule));
  const additions = mergeRules([], [], [{ rules: newRows }]).proxy[0].rules;
  return {
    inputCount: rules.length,
    conflictsWithDirect: rules.length - usable.length,
    alreadyCoveredOrRedundant: usable.length - additions.length,
    additionalRules: additions.length,
    examples: additions.slice(0, 5),
  };
}

async function findRepositories(approved, previous, now) {
  const cutoff = freshnessCutoff(now).toISOString().slice(0, 10);
  const queries = ['topic:shadowrocket topic:rules', 'shadowrocket rules in:name,description'];
  const results = await Promise.all(queries.map((query) => {
    const q = new URLSearchParams({
      q: `${query} archived:false fork:false pushed:>=${cutoff}`, sort: 'stars', per_page: '25',
    });
    return github(`/search/repositories?${q}`);
  }));
  const approvedNames = new Set(approved.flatMap((source) => linkedRepositories(source.project, '')));
  const self = (process.env.GITHUB_REPOSITORY ?? 'SparkTech-2049/Shadowrocket-Rule-Sets').toLowerCase();
  const docs = await Promise.allSettled(approved.filter(({ discoveryReadme }) => discoveryReadme)
    .map(({ discoveryReadme }) => fetchText(discoveryReadme, { limit: 400_000, timeout: 8000 })));
  const linked = docs.flatMap((doc) => doc.status === 'fulfilled' ? sourceReferences(doc.value, '') : []);
  const carried = previous.repositories.filter(({ state, path }) => state === 'candidate' || (state === 'unavailable' && path))
    .slice(0, 4).map(({ repository }) => repository);
  const metas = new Map(results.flatMap((item) => (item.items ?? []).map((repo) => [repo.full_name.toLowerCase(), repo])));
  const names = [...new Set([...carried.map((name) => name.toLowerCase()), ...linked.slice(0, 6), ...metas.keys()])];
  const repos = [];
  for (const name of names) {
    if (repos.length === MAX_REPOSITORIES) break;
    if (self === name || approvedNames.has(name) || !repoPattern.test(name)) continue;
    let meta = metas.get(name);
    try { meta ??= await github(`/repos/${name}`); } catch { continue; }
    if (meta.archived || meta.fork || !meta.default_branch || !meta.pushed_at || isStale(meta.pushed_at, now)) continue;
    repos.push(meta);
  }
  return repos;
}

async function reviewRepository(repo, previous, direct, proxy, now) {
  const repository = repo.full_name;
  const license = repo.license?.spdx_id ?? null;
  const row = { repository, project: repo.html_url, license };
  const priorFile = previous?.path ? { ...previous, ...row } : row;
  if (!REUSE_LICENSES.has(license)) return { ...row, state: 'review', reason: 'repository-license-needs-review' };
  try {
    const ref = repo.default_branch;
    const tree = await readRepositoryTree(repository, ref);
    const isReadme = ({ path }) => /^readme\.md$/i.test(path);
    const readmePath = tree.find(isReadme)?.path;
    const readme = readmePath ? await fetchText(raw(repository, ref, readmePath), { limit: 400_000, timeout: 8000 }).catch(() => '') : '';
    const files = [...rankedRulePaths(tree).map((path) => ({ ref, path })), ...documentedFiles(readme, repository)];
    const sameFile = (file) => file.ref === previous?.ref && file.path === previous?.path;
    const preferred = files.find(sameFile);
    const unique = new Map();
    for (const file of [...(preferred ? [preferred] : []), ...files]) unique.set(`${file.ref}:${file.path}`, file);
    let review;
    for (const { ref: fileRef, path } of [...unique.values()].slice(0, 4)) {
      try {
        const url = raw(repository, fileRef, path);
        const text = await fetchText(url, { limit: 4_000_000, timeout: 8000 });
        const { format, rules } = readCandidateRules(text, path);
        if (!rules.length) continue;
        const inputSha256 = hash(textFile(rules));
        const fileDate = await fileUpdatedAt({ repo: repository, ref: fileRef, path });
        const sameRules = sameFile({ ref: fileRef, path }) && previous?.inputSha256 === inputSha256;
        const lastRuleChange = sameRules ? previous.lastRuleChange : fileDate;
        const evidence = { ...row, ref: fileRef, path, url, format, inputSha256, lastRuleChange };
        if (isStale(lastRuleChange, now)) {
          review ??= { ...evidence, state: 'stale', reason: 'rule-content-older-than-three-months' };
          continue;
        }
        const referencePaths = path.includes('/') ? [`${path.slice(0, path.lastIndexOf('/'))}/README.md`] : [];
        const extraReadme = tree.some(({ path }) => referencePaths.includes(path))
          ? await fetchText(raw(repository, ref, referencePaths[0]), { limit: 400_000, timeout: 8000 }).catch(() => '') : '';
        const sources = [...new Set([
          ...sourceReferences(readme, repository), ...sourceReferences(extraReadme, repository),
          ...sourceReferences(text.split(/\r?\n/).slice(0, 45).join('\n'), repository),
        ])].sort().slice(0, 12);
        const coverage = assessCoverage(rules, direct, proxy);
        const detail = { ...evidence, sources, coverage };
        if (!sources.length || !coverage.additionalRules) {
          review ??= { ...detail, state: 'review', reason: !sources.length ? 'upstream-provenance-needs-review' : 'no-new-safe-proxy-rules' };
          continue;
        }
        return { ...detail, state: 'candidate' };
      } catch {
        continue;
      }
    }
    return review ?? { ...priorFile, state: 'unavailable', reason: 'no-readable-proxy-rule-file' };
  } catch (error) {
    return { ...priorFile, state: 'unavailable', reason: error.message };
  }
}

export async function discoverSources(approved, previous, direct, proxy, now) {
  const repos = await findRepositories(approved, previous, now);
  const rows = [];
  for (let index = 0; index < repos.length; index += 4) {
    rows.push(...await Promise.all(repos.slice(index, index + 4).map((repo) => reviewRepository(
      repo, previous.repositories.find(({ repository }) => repository === repo.full_name), direct, proxy, now,
    ))));
  }
  return rows.sort((a, b) => a.repository.localeCompare(b.repository, 'en'));
}
