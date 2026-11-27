// GitHub のリポジトリへファイルを書き込む（Contents API）。合い鍵（トークン）は呼び出し側から渡す。
// fetch を差し替えられるので、テストでは偽の GitHub を相手にできる。
export const OWNER = 'Ryota-afk';
export const REPO = 'kaufhfhsyhwjaijdheysy';
export const BRANCH = 'main';

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function explain(status: number, what: string): string {
  if (status === 401) return `${what}：合い鍵が正しくないか、期限が切れています（401）。`;
  if (status === 403 || status === 404) return `${what}：合い鍵に、このリポジトリの「Contents」の書き込みの権限がありません（${status}）。`;
  if (status === 409 || status === 422) return `${what}：ほかの書き込みとぶつかりました。もう一度保存してください（${status}）。`;
  return `${what}：GitHub から ${status} が返りました。`;
}

/** path のファイルを content で作るか上書きする。成功したら新しいコミットの sha を返す。 */
export async function putFile(token: string, path: string, content: string, message: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  // 上書きのときは今のファイルの sha が要る
  let sha: string | undefined;
  const g = await fetchImpl(`${url}?ref=${BRANCH}`, { headers });
  if (g.status === 200) sha = (await g.json()).sha;
  else if (g.status !== 404) throw new GitHubError(g.status, explain(g.status, '今のファイルの確認'));
  const body = JSON.stringify({ message, content: b64utf8(content), branch: BRANCH, ...(sha ? { sha } : {}) });
  const p = await fetchImpl(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  if (!p.ok) throw new GitHubError(p.status, explain(p.status, '書き込み'));
  return (await p.json()).commit?.sha ?? '';
}
