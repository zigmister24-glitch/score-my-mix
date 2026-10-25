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
for(let i=0;i<4;i++) {assert.equal(legacy[i].deviationPercent,migrated[i].deviationPercent);assert.ok(Math.abs(legacy[i].deviationDb-migrated[i].deviationDb)<1e-9)}
const zero=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:0,body:0,core:0,air:0}})
const bass=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:3,body:0,core:0,air:0}})
assert.ok(bass[0].deviationDb<zero[0].deviationDb)
const same=analysis.buildTonalBalanceBands(samples,sr,0,sr,{tonalDb:{weight:3,body:3,core:3,air:3}})
for(let i=0;i<4;i++)assert.ok(Math.abs(same[i].deviationDb-zero[i].deviationDb)<1e-9)
let stored=null
globalThis.localStorage={getItem:()=>stored,setItem:(_,v)=>{stored=v}}
const renamed={...defaults[1],name:'My Rock',db:{weight:2,body:-1,core:0,air:.5}}
await profiles.persistCustomGenre(renamed,defaults,true)
assert.deepEqual((await profiles.loadCustomGenres(true))[1],renamed)
let row=null
const DB={prepare:()=>({bind:(...args)=>({run:async()=>{row={id:args[0],name:args[1],weight_db:args[2],body_db:args[3],core_db:args[4],air_db:args[5]}}}),all:async()=>({results:row?[row]:[]})})}
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
