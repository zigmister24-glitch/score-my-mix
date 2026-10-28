import ts from 'typescript'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const source=fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {rms,bandpassRms,averageAbs,zeroCrossingRate,transientFlux,buildTonalBalanceBands,scoreWidthFromBands};'
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const m=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const sr=24000, length=sr*12
const left=Float32Array.from({length},(_,i)=>.2*Math.sin(2*Math.PI*220*i/sr)*(1+.3*Math.sin(2*Math.PI*3*i/sr)))
const right=Float32Array.from({length},(_,i)=>.12*Math.sin(2*Math.PI*2400*i/sr)*(1+.4*Math.sin(2*Math.PI*7*i/sr)))
const buffer=channels=>({sampleRate:sr,length,duration:length/sr,numberOfChannels:channels.length,getChannelData:i=>channels[i]})
for(const boundaries of [undefined,[0,4,8,12]]) {
 const a=m.buildSections(buffer([left,right]),boundaries)
 const b=m.buildSections(buffer([right,left]),boundaries)
 assert.equal(a.length,b.length)
 for(let i=0;i<a.length;i++){assert.deepEqual(a[i].metrics,b[i].metrics);assert.equal(a[i].score,b[i].score);assert.equal(a[i].start,b[i].start)}
}
// Isolated constant-power hat: moving left to centre preserves band energy.
const silence=new Float32Array(length)
const centred=right.map(v=>v/Math.sqrt(2))
for(const hz of [70,220,1050,8500]) {
 const l=m.bandpassRms([right,silence],sr,0,length,hz,.85)
 const c=m.bandpassRms([centred,centred],sr,0,length,hz,.85)
 assert.ok(Math.abs(l-c)<1e-7)
}
assert.ok(Math.abs(m.rms([right,silence],0,length)-m.rms([centred,centred],0,length))<1e-7)
// Anti-phase audio must retain its energy rather than cancel like a mono sum.
assert.ok(Math.abs(m.rms([right,right.map(v=>-v)],0,length)-m.rms(right,0,length))<1e-9)
assert.deepEqual(m.buildTonalBalanceBands([right,right],sr,0,length),m.buildTonalBalanceBands(right,sr,0,length))
assert.equal(m.rms([silence,silence],0,length),0)
assert.equal(m.zeroCrossingRate([silence,silence],0,length),0)
console.log('Passed channel-swap score/section invariance, constant-power panning, anti-phase energy, dual-mono and silence checks.')
// Ignoring Impact changes only the averaging and associated advice, not measurements.
const scored=m.buildSections(buffer([left,right]),[0,4,8,12])
const ignored=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],[false,true,false])
assert.equal(ignored[1].impactIgnored,true)
assert.equal(scored[1].metrics.impact,ignored[1].metrics.impact)
const values=ignored[1].metrics
const expected=[values.clarity,values.tonalBalance,values.width,values.mastering,...(values.vocalLevel==null?[]:[values.vocalLevel])]
assert.equal(ignored[1].scoreExact,expected.reduce((sum,n)=>sum+Math.round(n),0)/expected.length)
assert.deepEqual(scored[0].metrics,ignored[0].metrics)
assert.equal(scored[0].score,ignored[0].score)
assert.equal(scored[2].score,ignored[2].score)
const apiSource=fs.readFileSync('functions/api/section-map.js','utf8')+'\nexport {normaliseSections};'
const {normaliseSections}=await import(`data:text/javascript;base64,${Buffer.from(apiSource).toString('base64')}`)
const saved=normaliseSections([{start:0,end:4},{start:4,end:8,impactIgnored:true},{start:8,end:12,impactIgnored:'true'}],12)
assert.deepEqual(saved.map(s=>s.impactIgnored),[false,true,false])
const loaded=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],saved.map(s=>s.impactIgnored))
assert.equal(loaded[1].scoreExact,ignored[1].scoreExact)
console.log('Passed ignored Impact averaging, default behaviour, unaffected measurements and saved-map normalisation/reload tests.')

const movementOff=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],[false,true,false],[false,true,false])
assert.equal(movementOff[1].movementIgnored,true)
assert.equal(movementOff[1].impactIgnored,true)
assert.equal(movementOff[1].metrics.width,m.scoreWidthFromBands(movementOff[1].widthBands.map(b=>b.key==='movement'?{...b,deviationPercent:20}:b)))
assert.equal(movementOff[0].score,scored[0].score)
assert.equal(movementOff[2].score,scored[2].score)
const movementSaved=normaliseSections([{start:0,end:4},{start:4,end:8,impactIgnored:true,movementIgnored:true},{start:8,end:12,movementIgnored:'true'}],12)
assert.deepEqual(movementSaved.map(s=>s.movementIgnored),[false,true,false])
const movementLoaded=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],movementSaved.map(s=>s.impactIgnored),movementSaved.map(s=>s.movementIgnored))
assert.equal(movementLoaded[1].scoreExact,movementOff[1].scoreExact)
console.log('Passed ignored Movement quality-only scoring, independence from Impact, unchanged other sections and saved-map reload checks.')
const masteringOff=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],[false,true,false],[false,true,false],[false,true,false])
const v=masteringOff[1].metrics
const remaining=[v.clarity,v.tonalBalance,v.width,...(v.vocalLevel==null?[]:[v.vocalLevel])]
assert.equal(masteringOff[1].masteringIgnored,true)
assert.equal(masteringOff[1].scoreExact,remaining.reduce((sum,n)=>sum+Math.round(n),0)/remaining.length)
assert.deepEqual(masteringOff[1].mastering,scored[1].mastering)
assert.equal(masteringOff[0].score,scored[0].score)
const allSaved=normaliseSections([{start:0,end:4},{start:4,end:8,impactIgnored:true,movementIgnored:true,masteringIgnored:true},{start:8,end:12,masteringIgnored:'true'}],12)
assert.deepEqual(allSaved.map(s=>s.masteringIgnored),[false,true,false])
const allLoaded=m.buildSections(buffer([left,right]),[0,4,8,12],undefined,[],allSaved.map(s=>s.impactIgnored),allSaved.map(s=>s.movementIgnored),allSaved.map(s=>s.masteringIgnored))
assert.equal(allLoaded[1].scoreExact,masteringOff[1].scoreExact)
console.log('Passed ignored Mastering averaging, preserved meter readings, independent flags and save/reload checks.')

// Movement is an additive bonus, not a requirement for a healthy base score.
for (const [change, expected] of [[0,95],[4,96],[10,98],[20,100],[-20,100],[25,100]]) {
  const bands=[{key:'middle',deviationPercent:0},{key:'side',deviationPercent:0},{key:'movement',deviationPercent:change}]
  assert.equal(m.scoreWidthFromBands(bands),expected)
  assert.equal(m.scoreWidthFromBands(bands,true),100)
}
assert.equal(m.scoreWidthFromBands([{key:'middle',deviationPercent:0},{key:'side',deviationPercent:0}]),95)
console.log('Passed additive Movement bonus anchors, both directions, 100% cap, ignored/zero movement and first-section baseline checks.')
