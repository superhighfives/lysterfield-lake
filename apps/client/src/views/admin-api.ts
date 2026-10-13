// Shared by the dev-only /admin views: the /__admin API that vite-plugin-admin.ts adds to the dev server.

export type RunState = { id: string; status: 'running' | 'succeeded' | 'failed'; log: string }

export const pad = (n: number) => String(n).padStart(4, '0')
export const jobFile = (job: string, rel: string) => `/__admin/files/${job}/${rel}`
/** The pipeline's own error message from a failed run's log. */
export const reason = (log: string) => log.match(/^error: (.*)$/im)?.[1] ?? log.match(/Error: (.*)$/m)?.[1] ?? 'That failed; nothing was changed.'

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json as T
}

/** Starts a pipeline action for a job and waits for it to end. */
export async function runAction(job: string, body: Record<string, unknown>): Promise<RunState> {
  const { runId } = await api<{ runId: string }>(`/__admin/api/jobs/${job}/actions`, body)
  for (;;) {
    const run = await api<RunState>(`/__admin/api/runs/${runId}`)
    if (run.status !== 'running') return run
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
