const IDS = ['Scarlett Lullaby', 'User Defined 1', 'User Defined 2', 'User Defined 3', 'User Defined 4'];
const KEYS = ['weight', 'body', 'core', 'air'];
const json = (body, status = 200) => Response.json(body, {status, headers: {'Cache-Control':'no-store'}});
export async function onRequestGet({env}) {
  try {
    const {results} = await env.DB.prepare('SELECT id, name, weight_db, body_db, core_db, air_db FROM genre_profiles').all();
    return json({profiles: results.map(row => ({id:row.id, name:row.name, db:Object.fromEntries(KEYS.map(key => [key,row[`${key}_db`]]))}))});
  } catch (error) { console.error(error); return json({error:'Genre profiles unavailable. Apply the database migration.'},503); }
}
export async function onRequestPost({request,env}) {
  try {
    const profile = await request.json();
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (!IDS.includes(profile.id) || !name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !KEYS.every(key => typeof profile.db?.[key] === 'number' && Number.isFinite(profile.db[key]) && Math.abs(profile.db[key]) <= 12)) return json({error:'Invalid profile'},400);
    await env.DB.prepare(`INSERT INTO genre_profiles (id,name,weight_db,body_db,core_db,air_db,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,weight_db=excluded.weight_db,body_db=excluded.body_db,core_db=excluded.core_db,air_db=excluded.air_db,updated_at=excluded.updated_at`).bind(profile.id,name,...KEYS.map(key => profile.db[key]),new Date().toISOString()).run();
    return json({ok:true});
  } catch(error) {console.error(error);return json({error:'Could not save genre profile'},500);}
}
