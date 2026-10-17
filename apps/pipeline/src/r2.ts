import { S3Client } from 'bun'

/**
 * A Cloudflare R2 bucket with public (r2.dev) reads, for models that only
 * take a public URL: `bria/video-erase-object` can't read Replicate Files
 * URLs, which need auth. Upload, run, then delete: nothing should stay
 * public longer than its prediction needs it.
 *
 * Uploads go through R2's S3 API (Bun's built-in client), so there's no
 * extra dependency. Needs, in apps/pipeline/.env: `R2_ACCOUNT_ID`,
 * `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (an R2 API token with object
 * read and write on the bucket), `R2_BUCKET`, and `R2_PUBLIC_URL` (the
 * bucket's `https://pub-<hash>.r2.dev` address).
 *
 * Not yet run against a real bucket (the spike uploaded by hand).
 */
const ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'] as const

let client: S3Client | undefined

function getClient(): S3Client {
  if (client) return client
  const missing = ENV.filter((name) => !process.env[name])
  if (missing.length > 0) throw new Error(`${missing.join(', ')} not set in apps/pipeline/.env (see src/r2.ts)`)
  client = new S3Client({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  })
  return client
}

/** Fails early, before anything is spent, if the R2 settings are missing. */
export function checkPublicUploads(): void {
  getClient()
}

/** Uploads `localPath` as `key` and returns its public URL. */
export async function uploadPublic(localPath: string, key: string, contentType: string): Promise<string> {
  await getClient().write(key, Bun.file(localPath), { type: contentType })
  return `${process.env.R2_PUBLIC_URL!.replace(/\/$/, '')}/${key}`
}

export async function deletePublic(key: string): Promise<void> {
  await getClient().delete(key)
}
