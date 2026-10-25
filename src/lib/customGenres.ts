export const BAND_KEYS = ['weight', 'body', 'core', 'air'] as const
export type BandKey = typeof BAND_KEYS[number]
export type CustomGenre = { id: string; name: string; db: Record<BandKey, number> }
export const CUSTOM_IDS = ['Scarlett Lullaby', 'User Defined 1', 'User Defined 2', 'User Defined 3', 'User Defined 4']
export function defaultCustomGenres(): CustomGenre[] {
  return CUSTOM_IDS.map(id => ({ id, name: id, db: Object.fromEntries(BAND_KEYS.map(key => [key,
    id === 'Scarlett Lullaby' ? 20 * Math.log10(1 + ({weight:14, body:4, core:2, air:1}[key]) / 100) : 0,
  ])) as Record<BandKey, number> }))
}
async function profileResponse(response: Response) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Genre profiles API is missing. Deploy functions/api/genre-profiles.js with the app.')
  }
  let data
  try { data = await response.json() } catch { throw new Error('Genre profiles API returned invalid JSON.') }
  if (!response.ok) throw new Error(data.error || 'Genre profiles unavailable. Check the database migration.')
  return data
}
export async function loadCustomGenres(local: boolean): Promise<CustomGenre[]> {
  const defaults = defaultCustomGenres()
  const data = local ? JSON.parse(localStorage.getItem('mix-custom-genres') || '[]') : (await profileResponse(await fetch('/api/genre-profiles'))).profiles
  if (!Array.isArray(data)) throw new Error('Genre profiles API returned an invalid profile list.')
  return defaults.map(base => {
    const saved = data.find(item => item.id === base.id)
    return saved && typeof saved.name === 'string' && BAND_KEYS.every(key => Number.isFinite(saved.db?.[key]) && Math.abs(saved.db[key]) <= 12) ? saved : base
  })
}
export async function persistCustomGenre(profile: CustomGenre, profiles: CustomGenre[], local: boolean) {
  if (local) { localStorage.setItem('mix-custom-genres', JSON.stringify(profiles.map(p => p.id === profile.id ? profile : p))); return }
  const response = await fetch('/api/genre-profiles', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(profile)})
  const data = await profileResponse(response)
  if (data.ok !== true) throw new Error('Genre profile save was not confirmed. Please try again.')
}
