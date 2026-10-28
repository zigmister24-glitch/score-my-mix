import ts from 'typescript'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const js=ts.transpileModule(fs.readFileSync('src/lib/liveWidth.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {energyWeightedWidth:width}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const rate=48000, length=rate
const tone=Float32Array.from({length},(_,i)=>Math.sin(i*2*Math.PI*440/rate))
const side=Float32Array.from({length},(_,i)=>Math.sin(i*2*Math.PI*1700/rate))
const buffer=channels=>({sampleRate:rate,length,numberOfChannels:channels.length,getChannelData:i=>channels[i]})
const mix=gain=>buffer([tone.map((v,i)=>v*.5+side[i]*gain),tone.map((v,i)=>v*.5-side[i]*gain)])
assert.equal(width(null,.5),0)
assert.equal(width(buffer([tone]),.5),0)
assert.equal(width(buffer([tone,tone]),.5),0)
assert.equal(width(buffer([tone,tone.map(v=>-v)]),.5),1)
assert.equal(width(buffer([new Float32Array(length),new Float32Array(length)]),.5),0)
assert.ok(width(mix(.01),.5)<.03)
assert.ok(width(mix(.3),.5)>width(mix(.01),.5))
const normal=mix(.2), swapped=buffer([normal.getChannelData(1),normal.getChannelData(0)])
assert.equal(width(normal,.5),width(swapped,.5))
const quieter=buffer([normal.getChannelData(0).map(v=>v*.1),normal.getChannelData(1).map(v=>v*.1)])
assert.ok(Math.abs(width(normal,.5)-width(quieter,.5))<1e-7)
assert.ok(Number.isFinite(width(normal,1)))
console.log('Passed quiet-layer weighting, mono/centre, wide/anti-phase, silence, channel swap and level independence checks.')
