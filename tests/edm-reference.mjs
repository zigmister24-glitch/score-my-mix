import fs from 'node:fs'
import ts from 'typescript'
import assert from 'node:assert/strict'
const source=fs.readFileSync('src/lib/audioAnalysis.ts','utf8')+'\nexport {densityTargets};'
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {EDM_REFERENCE,densityTargets}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const record=JSON.parse(fs.readFileSync('db/edm-reference-calibration.json','utf8'))
assert.deepEqual(EDM_REFERENCE.tonal,record.tonal)
assert.deepEqual(EDM_REFERENCE.density,record.density)
for(const values of Object.values(EDM_REFERENCE))assert.ok(Math.abs(Object.values(values).reduce((a,b)=>a+b,0)-1)<1e-9)
const base={reference:EDM_REFERENCE}
for(const key of ['weight','body','core','presence','air']){
 assert.ok(Math.abs(densityTargets(base)[key]-EDM_REFERENCE.density[key])<1e-9)
 const db={weight:0,body:0,core:0,presence:0,air:0,[key]:2}
 assert.ok(densityTargets({...base,tonalDb:db})[key]>densityTargets(base)[key])
}
console.log('Passed reference provenance, independent tonal/density targets, normalisation and editable offsets for all five bands.')
