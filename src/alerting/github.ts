/**
 * A rolling GitHub-issue alert channel: the first alert files an issue under a
 * label, later alerts comment on the open one, so a persistent problem is one
 * thread a human can follow instead of a hundred issues nobody reads.
 *
 * The token is a fine-grained PAT scoped to Issues:write on the one repository,
 * read from the caller at each use so a Worker secret can rotate. Whether the
 * channel is configured is a separate question from whether a write succeeded,
 * so a caller can report "the alert token is missing" as its own state.
 */

export interface GithubIssueAlertOptions {
  owner: string
  repo: string
  /** The label that marks the rolling issue. */
  label: string
  /** The PAT, or undefined when the deployment has none. */
  token: () => string | undefined
  /** The User-Agent GitHub requires on every call. */
  userAgent: string
  /** The variable a missing token is reported under. */
  tokenName?: string
}

export interface GithubIssueAlertChannel {
  /** Whether a token is configured, checked before an alert is composed. */
  configured(): boolean
  /**
   * Comment on the open labeled issue, or file one when none is open. Returns
   * the issue URL so the caller can record that the channel fired; throws when
   * the token is missing or GitHub refuses the write.
   */
  file(title: string, body: string): Promise<string>
}

interface GithubIssue {
  readonly number: number
  readonly html_url: string
}

export function createGithubIssueAlertChannel(options: GithubIssueAlertOptions): GithubIssueAlertChannel {
  const { owner, repo, label } = options
  const tokenName = options.tokenName ?? 'GITHUB_ALERT_TOKEN'

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = options.token()
    if (!token) throw new Error(`${tokenName} is required to file a GitHub alert`)
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': options.userAgent,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body.slice(0, 500)}`)
    }
    return (await res.json()) as T
  }

  return {
    configured: () => Boolean(options.token()),
    async file(title, body) {
      const [existing] = await request<GithubIssue[]>(
        `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`,
      )
      if (existing) {
        await request(`/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        })
        return existing.html_url
      }
      const created = await request<GithubIssue>(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels: [label] }),
      })
      return created.html_url
    },
  }
}
