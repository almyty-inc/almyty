/**
 * The test's own look at Open-Meteo, taken at the same moment as the
 * product's, so an answer can be checked against the real numbers. No key.
 */
export const OPEN_METEO = 'https://api.open-meteo.com'
export const OPEN_METEO_SPEC = 'https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi/forecast.yml'

/** Berlin Mitte: the place every weather test asks about. */
export const BERLIN = { latitude: '52.52', longitude: '13.41' }

export interface Daily {
  time: string[]
  temperature_2m_max: number[]
  precipitation_sum?: number[]
}

export async function forecast(params: Record<string, string>): Promise<any> {
  const url = `${OPEN_METEO}/v1/forecast?${new URLSearchParams(params)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status} for ${url}`)
  return res.json()
}

/** Daily max temperature and precipitation for Berlin, `days` days from today (Europe/Berlin). */
export async function berlinDaily(days = 3): Promise<Daily> {
  const body = await forecast({
    ...BERLIN,
    daily: 'temperature_2m_max,precipitation_sum',
    timezone: 'Europe/Berlin',
    forecast_days: String(days),
  })
  return body.daily
}
