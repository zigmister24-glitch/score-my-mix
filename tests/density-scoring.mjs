import fs from 'node:fs'
import ts from 'typescript'
import assert from 'node:assert/strict'
const source=fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {scoreDensity};'
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {scoreDensity}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const keys=['weight','body','core','presence','air']
const bands=values=>keys.map((key,i)=>({key,displayPercent:values[i]}))
assert.equal(scoreDensity(bands([0,0,0,0,0])),100)
assert.equal(scoreDensity(bands([0,0,0,0,1])),100)
assert.equal(scoreDensity(bands([8,8,8,8,8])),90)
assert.equal(scoreDensity(bands([0,8,0,0,0])),97)
assert.equal(scoreDensity(bands([0,0,0,0,8])),99)
assert.equal(scoreDensity(bands([0,0,0,0,20])),90)
assert.equal(scoreDensity(bands([0,0,0,0,32])),75)
assert.equal(scoreDensity(bands([8,8,-8,-8,8])),90)
let previous=100
for(let excess=0;excess<=32;excess+=.25){const score=scoreDensity(bands([0,0,0,0,excess]));assert.ok(score<=previous);assert.ok(previous-score<=1);previous=score}
console.log('Passed healthy bands, 1% Air warning, weighted average, band importance, severe safeguard, signed deviations and smooth monotonicity checks.')
