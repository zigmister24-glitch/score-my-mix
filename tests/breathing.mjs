import fs from 'node:fs'
import ts from 'typescript'
import assert from 'node:assert/strict'
const js=ts.transpileModule(fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {measureBreathing,scoreWidthFromBands};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const m=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const sr=24000,n=sr*8
function audio(moving,level=1){const l=new Float32Array(n),r=new Float32Array(n);for(let i=0;i<n;i++){const mid=.3*Math.sin(i*2*Math.PI*440/sr),side=(moving?.12+.09*Math.sin(i*2*Math.PI*.7/sr):.12)*Math.sin(i*2*Math.PI*1400/sr);l[i]=(mid+side)*level;r[i]=(mid-side)*level}return {sampleRate:sr,length:n,duration:8,numberOfChannels:2,getChannelData:i=>i===0?l:r}}
const steady=m.measureBreathing(audio(false),0,n),moving=m.measureBreathing(audio(true),0,n),quiet=m.measureBreathing(audio(true,.02),0,n)
assert.equal(Math.round(steady.breathingScore),90)
assert.equal(moving.breathingScore,100)
assert.ok(Math.abs(quiet.breathingScore-moving.breathingScore)<1e-6)
assert.equal(m.scoreWidthFromBands([steady]),90)
assert.equal(m.scoreWidthFromBands([moving]),100)
const silence={...audio(false),getChannelData:()=>new Float32Array(n)}
assert.equal(m.measureBreathing(silence,0,n).breathingScore,100)
assert.equal(m.measureBreathing(audio(true),0,sr).breathingScore,100)
const sections=m.buildSections(audio(true),[0,4,8])
assert.deepEqual(sections[0].widthBands.map(b=>b.key),['breathing'])
assert.deepEqual(sections[1].widthBands.map(b=>b.key),['breathing','movement'])
assert.ok(sections.every(s=>Number.isFinite(s.score)))
console.log('Passed steady/moving stereo, quiet-level invariance, insufficient audio, two-row output and first-section scoring checks.')
