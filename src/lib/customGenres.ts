export const BAND_KEYS = ['weight', 'body', 'core', 'air'] as const
export type BandKey = typeof BAND_KEYS[number]
export type CustomGenre = { id: string; name: string; db: Record<BandKey, number> }
export const CUSTOM_IDS = ['Scarlett Lullaby', 'User Defined 1', 'User Defined 2', 'User Defined 3', 'User Defined 4']
export function defaultCustomGenres(): CustomGenre[] {
  return CUSTOM_IDS.map(id => ({ id, name: id, db: Object.fromEntries(BAND_KEYS.map(key => [key,
    id === 'Scarlett Lullaby' ? 20 * Math.log10(1 + ({weight:14, body:4, core:2, air:1}[key]) / 100) : 0,
  ])) as Record<BandKey, number> }))
}
export async function loadCustomGenres(local: boolean): Promise<CustomGenre[]> {
  const defaults = defaultCustomGenres()
  const data = local ? JSON.parse(localStorage.getItem('mix-custom-genres') || '[]') : await fetch('/api/genre-profiles').then(async r => { if (!r.ok) throw new Error('Could not load genre profiles. Check the database migration.'); return (await r.json()).profiles })
  return defaults.map(base => {
    const saved = Array.isArray(data) ? data.find(item => item.id === base.id) : null
    return saved && typeof saved.name === 'string' && BAND_KEYS.every(key => Number.isFinite(saved.db?.[key]) && Math.abs(saved.db[key]) <= 12) ? saved : base
  })
}
export async function persistCustomGenre(profile: CustomGenre, profiles: CustomGenre[], local: boolean) {
  if (local) { localStorage.setItem('mix-custom-genres', JSON.stringify(profiles.map(p => p.id === profile.id ? profile : p))); return }
  const response = await fetch('/api/genre-profiles', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(profile)})
  if (!response.ok) throw new Error('Could not save genre profile. Check the database migration and try again.')
}
