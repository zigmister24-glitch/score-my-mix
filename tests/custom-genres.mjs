import ts from 'typescript'
import fs from 'node:fs'
import assert from 'node:assert/strict'
async function moduleFrom(path, extra = '') {
  const source = fs.readFileSync(path, 'utf8') + extra
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const profiles = await moduleFrom('src/lib/customGenres.ts')
const analysis = await moduleFrom('src/lib/audioAnalysis.ts', '\nexport {buildTonalBalanceBands};')
const defaults = profiles.defaultCustomGenres()
assert.equal(defaults.length,5)
const sr=48000, samples=Float32Array.from({length:sr},(_,i)=>Math.sin(i*2*Math.PI*70/sr)*.2+Math.sin(i*2*Math.PI*1050/sr)*.1+Math.sin(i*2*Math.PI*8500/sr)*.05)
const legacy=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonal:{weight:14,body:4,core:2,air:1}})
const migrated=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:defaults[0].db})
for(let i=0;i<5;i++) {assert.equal(legacy[i].deviationPercent,migrated[i].deviationPercent);assert.ok(Math.abs(legacy[i].deviationDb-migrated[i].deviationDb)<1e-9)}
const zero=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:0,body:0,core:0,presence:0,air:0}})
const bass=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:3,body:0,core:0,presence:0,air:0}})
assert.ok(bass[0].deviationDb<zero[0].deviationDb)
const same=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:3,body:3,core:3,presence:3,air:3}})
for(let i=0;i<5;i++)assert.ok(Math.abs(same[i].deviationDb-zero[i].deviationDb)<1e-9)
let stored=null
globalThis.localStorage={getItem:()=>stored,setItem:(_,v)=>{stored=v}}
const renamed={...defaults[1],name:'My Rock',db:{weight:2,body:-1,core:0,presence:0,air:.5}}
await profiles.persistCustomGenre(renamed,defaults,true)
assert.deepEqual((await profiles.loadCustomGenres(true))[1],renamed)
let row=null
const DB={prepare:()=>({bind:(...args)=>({run:async()=>{row={id:args[0],name:args[1],weight_db:args[2],body_db:args[3],core_db:args[4],presence_db:args[5],air_db:args[6],vocal_db:args[7]}}}),all:async()=>({results:row?[row]:[]})})}
const api=await import('../functions/api/genre-profiles.js')
const post=body=>api.onRequestPost({request:new Request('https://example.test/api/genre-profiles',{method:'POST',body:JSON.stringify(body)}),env:{DB}})
assert.equal((await post(renamed)).status,200)
assert.deepEqual((await (await api.onRequestGet({env:{DB}})).json()).profiles[0],renamed)
assert.equal((await post({...renamed,id:'Modern Pop'})).status,400)
assert.equal((await post({...renamed,db:{...renamed.db,air:13}})).status,400)
assert.equal((await post({...renamed,name:''})).status,400)
console.log('Passed profile conversion, dB targets, normalisation, local persistence, stable rename IDs and API validation/roundtrip tests.')
globalThis.fetch=async()=>new Response('<!doctype html><html></html>',{headers:{'content-type':'text/html'}})
await assert.rejects(()=>profiles.loadCustomGenres(false),/API is missing/)
await assert.rejects(()=>profiles.persistCustomGenre(renamed,defaults,false),/API is missing/)
globalThis.fetch=async()=>Response.json({profiles:[]})
assert.deepEqual(await profiles.loadCustomGenres(false),defaults)
globalThis.fetch=async()=>Response.json({error:'Apply migration'},{status:503})
await assert.rejects(()=>profiles.loadCustomGenres(false),/Apply migration/)
globalThis.fetch=async()=>Response.json({ok:true})
await profiles.persistCustomGenre(renamed,defaults,false)
console.log('Passed missing-route HTML, failed database load, empty-table defaults and confirmed save tests.')

const densitySource=fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {densityTargets,buildClarityBands};'
const densityJs=ts.transpileModule(densitySource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {densityTargets,buildClarityBands}=await import(`data:text/javascript;base64,${Buffer.from(densityJs).toString('base64')}`)
const baseProfile={density:{weight:14,body:22,core:4,air:-2}}
const edited=air=>({...baseProfile,tonalDb:{weight:0,body:0,core:0,air}})
assert.deepEqual(densityTargets(baseProfile),densityTargets(edited(0)))
assert.ok(densityTargets(edited(3)).air>densityTargets(edited(0)).air)
assert.ok(densityTargets(edited(-3)).air<densityTargets(edited(0)).air)
const original=buildClarityBands(samples,sr,0,sr,0,.2,undefined,edited(0))
const brighter=buildClarityBands(samples,sr,0,sr,0,.2,undefined,edited(3))
assert.ok(brighter.find(b=>b.key==='air').deviationPercent<=original.find(b=>b.key==='air').deviationPercent)
assert.ok(Math.abs(Object.values(densityTargets(edited(3))).reduce((a,b)=>a+b,0)-1)<1e-10)
console.log('Passed linked Air density reference, zero-offset compatibility, both adjustment directions and density readout checks.')
const neutral={tonalDb:{weight:0,body:0,core:0,presence:0,air:0}}
const presenceProfile={tonalDb:{...neutral.tonalDb,presence:3}}
const boosted=Float32Array.from(samples,(value,i)=>value+.15*Math.sin(2*Math.PI*3200*i/sr))
const before=analysis.buildTonalBalanceBands(samples,sr,0,sr,neutral)
const after=analysis.buildTonalBalanceBands(boosted,sr,0,sr,neutral)
assert.deepEqual(after.map(b=>b.key),['weight','body','core','presence','air'])
assert.ok(after.find(b=>b.key==='presence').deviationDb>before.find(b=>b.key==='presence').deviationDb)
assert.ok(analysis.buildTonalBalanceBands(boosted,sr,0,sr,presenceProfile).find(b=>b.key==='presence').deviationDb<after.find(b=>b.key==='presence').deviationDb)
assert.ok(densityTargets(presenceProfile).presence>densityTargets(neutral).presence)
assert.equal(buildClarityBands(boosted,sr,0,sr,0,.2,undefined,neutral).length,5)
const oldStored={...renamed,db:{...renamed.db}};delete oldStored.db.presence
stored=JSON.stringify([oldStored])
assert.equal((await profiles.loadCustomGenres(true))[1].db.presence,0)
console.log('Passed Presence frequency response, editable tonal/density target, five-band order and legacy profile upgrade checks.')

const vocalSource=fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {vocalTargets};'
const vocalJs=ts.transpileModule(vocalSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {vocalTargets}=await import(`data:text/javascript;base64,${Buffer.from(vocalJs).toString('base64')}`)
assert.deepEqual(vocalTargets({vocals:2}),vocalTargets({vocals:2,vocalDb:0}))
assert.ok(vocalTargets({vocals:2,vocalDb:1}).judgementTarget>vocalTargets({vocals:2}).judgementTarget)
assert.ok(vocalTargets({vocals:2,vocalDb:-1}).judgementTarget<vocalTargets({vocals:2}).judgementTarget)
assert.ok(Math.abs(vocalTargets({vocalDb:2}).target/vocalTargets({}).target-10**(2/20))<1e-10)
const louder={...renamed,vocalDb:1.5}
await profiles.persistCustomGenre(louder,defaults,true)
assert.equal((await profiles.loadCustomGenres(true))[1].vocalDb,1.5)
assert.equal((await post(louder)).status,200)
assert.equal((await (await api.onRequestGet({env:{DB}})).json()).profiles[0].vocalDb,1.5)
assert.equal((await post({...louder,vocalDb:7})).status,400)
assert.equal((await post({...louder,vocalDb:'2'})).status,400)
console.log('Passed vocal target direction, exact zero-offset compatibility, dB conversion, persistence and validation checks.')
