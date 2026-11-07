/**
 * The Data Quality app runs outside KPI, on a sibling subdomain:
 * kf.example.org → quality.example.org. It has to share KPI's parent domain,
 * because it signs users in with KPI's session cookie.
 */

/** localStorage key with a base URL to use instead, e.g. `http://quality.kobo.local:4414` (local development). */
export const QUALITY_APP_URL_OVERRIDE_KEY = 'kpi.qualityAppUrl'

/**
 * URL of the Data Quality app opened on the given form, or `null` when it
 * can't be derived (a host with fewer than three labels, e.g. `localhost`).
 */
export function getQualityAppUrl(
  assetUid: string,
  loc: Pick<Location, 'protocol' | 'hostname' | 'port'> = window.location,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): string | null {
  const query = `/?form=${encodeURIComponent(assetUid)}`
  const override = storage.getItem(QUALITY_APP_URL_OVERRIDE_KEY)
  if (override) {
    return override.replace(/\/+$/, '') + query
  }
  const labels = loc.hostname.split('.')
  if (labels.length < 3) {
    return null
  }
  const port = loc.port ? `:${loc.port}` : ''
  return `${loc.protocol}//quality.${labels.slice(1).join('.')}${port}${query}`
}
