export async function fetchText(url, { headers, limit = 8_000_000, timeout = 15000 } = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('response exceeds the size limit');
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

export const repoPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i;

export async function github(path) {
  if (!path.startsWith('/')) throw new Error('Invalid GitHub API path');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Shadowrocket-Rule-Sets' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  return JSON.parse(await fetchText(`https://api.github.com${path}`, { headers }));
}

export async function fileUpdatedAt({ repo, ref, path }) {
  if (!repoPattern.test(repo) || !ref || !path) throw new Error('Invalid GitHub rule file location');
  const query = new URLSearchParams({ sha: ref, path, per_page: '1' });
  const [entry] = await github(`/repos/${repo}/commits?${query}`);
  if (!entry?.commit?.committer?.date) throw new Error('No rule file history');
  return entry.commit.committer.date;
}
