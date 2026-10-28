import ts from 'typescript'
import fs from 'node:fs'
import assert from 'node:assert/strict'
class Param {
  value=0; events=[]
  setValueAtTime(v,t){this.value=v;this.events.push(['set',v,t])}
  cancelScheduledValues(t){this.events.push(['cancel',t])}
  linearRampToValueAtTime(v,t){this.value=v;this.events.push(['ramp',v,t])}
}
class Node {
  gain=new Param();frequency=new Param();Q=new Param();connections=[];disconnected=false
  connect(node){this.connections.push(node);return node}
  disconnect(){this.disconnected=true}
}
class Context {
  currentTime=5;sampleRate=48000;destination=new Node();gains=[];filters=[];closed=false
  createMediaElementSource(media){this.media=media;return this.source=new Node()}
  createGain(){const node=new Node();this.gains.push(node);return node}
  createBiquadFilter(){const node=new Node();this.filters.push(node);return node}
  async resume(){}
  async close(){this.closed=true}
}
globalThis.AudioContext=Context
const js=ts.transpileModule(fs.readFileSync('src/lib/bandAudition.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {BandAudition,AUDITION_BANDS}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const graph=new BandAudition({})
const ctx=graph.context
assert.deepEqual(ctx.gains.map(n=>n.gain.value),[1,0])
assert.deepEqual(ctx.filters.map(n=>n.type),['highpass','lowpass'])
assert.equal(ctx.source.connections.length,2)
for(const [key,range] of Object.entries(AUDITION_BANDS)){
 graph.setBand(key)
 assert.deepEqual(ctx.filters.map(n=>n.frequency.value),range)
 assert.deepEqual(ctx.gains.map(n=>n.gain.value),[0,1])
 assert.equal(ctx.gains[1].gain.events.at(-1)[2],5.02)
 graph.setBand(null)
 assert.deepEqual(ctx.gains.map(n=>n.gain.value),[1,0])
}
ctx.sampleRate=16000;graph.setBand('air')
assert.ok(ctx.filters.every(n=>n.frequency.value<8000))
graph.dispose()
assert.equal(ctx.closed,true)
assert.ok([ctx.source,...ctx.gains,...ctx.filters].every(n=>n.disconnected))
console.log('Passed all five audition frequency ranges, dry/wet routing and restoration, fade ramps, low-rate cutoff bounds and audio cleanup checks.')
