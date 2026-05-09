import { BalanceStripItem, ImpactStrip, Recommendation, SectionAnalysis, SectionMetrics, TonalBalanceBand } from './types'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function averageAbs(samples: Float32Array, start: number, end: number) {
  let sum = 0
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i += 1) sum += Math.abs(samples[i])
  return sum / count
}

function zeroCrossingRate(samples: Float32Array, start: number, end: number) {
  let zeroCrossings = 0
  for (let i = start + 1; i < end; i += 1) {
    const prev = samples[i - 1]
    const curr = samples[i]
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) zeroCrossings += 1
  }
  return zeroCrossings / Math.max(1, end - start)
}

function rms(samples: Float32Array, start: number, end: number) {
  let sum = 0
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i += 1) {
    const sample = samples[i] ?? 0
    sum += sample * sample
  }
  return Math.sqrt(sum / count)
}

function bandpassRms(samples: Float32Array, sampleRate: number, start: number, end: number, frequency: number, q = 1) {
  const w0 = (2 * Math.PI * frequency) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosW0 = Math.cos(w0)
  let b0 = alpha
  let b1 = 0
  let b2 = -alpha
  const a0 = 1 + alpha
  let a1 = -2 * cosW0
  let a2 = 1 - alpha

  b0 /= a0
  b1 /= a0
  b2 /= a0
  a1 /= a0
  a2 /= a0

  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  let sum = 0
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i += 1) {
    const x0 = samples[i] ?? 0
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    sum += y0 * y0
  }
  return Math.sqrt(sum / count)
}

function transientFlux(samples: Float32Array, sampleRate: number, start: number, end: number) {
  const frameSize = Math.max(256, Math.floor(sampleRate * 0.023))
  let previous = 0
  let positiveFlux = 0
  let frames = 0
  for (let frameStart = start; frameStart < end; frameStart += frameSize) {
    const frameEnd = Math.min(end, frameStart + frameSize)
    const value = rms(samples, frameStart, frameEnd)
    if (frames > 0) positiveFlux += Math.max(0, value - previous)
    previous = value
    frames += 1
  }
  return positiveFlux / Math.max(1, frames)
}

function scoreAroundTarget(value: number, target: number, sensitivity: number, min = 42, max = 94) {
  return clamp(Math.round(100 - Math.min(100, Math.abs(value - target) * sensitivity)), min, max)
}

function estimateStereoWidth(buffer: AudioBuffer, startIndex: number, endIndex: number) {
  if (buffer.numberOfChannels < 2) return 0.48
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  let mid = 0
  let side = 0
  for (let i = startIndex; i < endIndex; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    mid += Math.abs((l + r) * 0.5)
    side += Math.abs((l - r) * 0.5)
  }
  return side / Math.max(0.0001, mid + side)
}


function estimateBandStereoSeparation(buffer: AudioBuffer, sampleRate: number, startIndex: number, endIndex: number, frequency: number, q = 0.9) {
  if (buffer.numberOfChannels < 2) return 0
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  const w0 = (2 * Math.PI * frequency) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosW0 = Math.cos(w0)
  let b0 = alpha
  let b1 = 0
  let b2 = -alpha
  const a0 = 1 + alpha
  let a1 = -2 * cosW0
  let a2 = 1 - alpha

  b0 /= a0
  b1 /= a0
  b2 /= a0
  a1 /= a0
  a2 /= a0

  let lX1 = 0
  let lX2 = 0
  let lY1 = 0
  let lY2 = 0
  let rX1 = 0
  let rX2 = 0
  let rY1 = 0
  let rY2 = 0
  let mid = 0
  let side = 0

  for (let i = startIndex; i < endIndex; i += 1) {
    const l0 = left[i] ?? 0
    const r0 = right[i] ?? 0
    const lFiltered = b0 * l0 + b1 * lX1 + b2 * lX2 - a1 * lY1 - a2 * lY2
    const rFiltered = b0 * r0 + b1 * rX1 + b2 * rX2 - a1 * rY1 - a2 * rY2
    lX2 = lX1
    lX1 = l0
    lY2 = lY1
    lY1 = lFiltered
    rX2 = rX1
    rX1 = r0
    rY2 = rY1
    rY1 = rFiltered
    mid += Math.abs((lFiltered + rFiltered) * 0.5)
    side += Math.abs((lFiltered - rFiltered) * 0.5)
  }

  return side / Math.max(0.0001, mid + side)
}

function formatStatus(score: number) {
  if (score >= 90) return 'Exceptional section'
  if (score >= 80) return 'Rewarding section'
  if (score >= 70) return 'Strong section'
  if (score >= 60) return 'Solid section'
  return 'Opportunity to explore'
}

function getHighlightLevel(score: number): 0 | 1 | 2 | 3 | 4 {
  if (score >= 95) return 4
  if (score >= 90) return 3
  if (score >= 80) return 2
  if (score >= 75) return 1
  return 0
}

function scoreColor(score: number) {
  if (score >= 95) return '#b56cff'
  if (score >= 90) return '#d4a93a'
  if (score >= 85) return '#60a5fa'
  if (score >= 80) return '#57e1ae'
  if (score >= 75) return '#60a5fa'
  return '#39435f'
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer()
  const ctx = new AudioContext()
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0))
  } finally {
    void ctx.close()
  }
}

function smoothSeries(values: number[]) {
  return values.map((value, index) => {
    const prev = values[index - 1] ?? value
    const next = values[index + 1] ?? value
    return (prev + value * 2 + next) / 4
  })
}

function mergeTightBoundaries(boundaries: number[], minLengthSeconds: number, duration: number) {
  const merged = [0]
  for (let i = 1; i < boundaries.length - 1; i += 1) {
    const time = boundaries[i]
    if (time - merged[merged.length - 1] >= minLengthSeconds) merged.push(time)
  }
  if (duration - merged[merged.length - 1] < minLengthSeconds * 0.65 && merged.length > 1) {
    merged.pop()
  }
  merged.push(duration)
  return merged
}

function detectSectionBoundaries(buffer: AudioBuffer) {
  const samples = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const frameSeconds = 0.75
  const frameSize = Math.max(512, Math.floor(sampleRate * frameSeconds))
  const totalFrames = Math.max(1, Math.floor(samples.length / frameSize))
  const energies: number[] = []
  const zcrs: number[] = []

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const start = frame * frameSize
    const end = Math.min(samples.length, start + frameSize)
    energies.push(averageAbs(samples, start, end))
    zcrs.push(zeroCrossingRate(samples, start, end))
  }

  const smoothedEnergy = smoothSeries(energies)
  const smoothedZcr = smoothSeries(zcrs)
  const novelty: number[] = []

  for (let i = 1; i < totalFrames; i += 1) {
    const energyDelta = Math.abs(smoothedEnergy[i] - smoothedEnergy[i - 1]) / Math.max(0.00001, smoothedEnergy[i - 1])
    const zcrDelta = Math.abs(smoothedZcr[i] - smoothedZcr[i - 1]) * 5.5
    novelty.push(energyDelta * 0.74 + zcrDelta * 0.26)
  }

  const avgNovelty = novelty.reduce((sum, value) => sum + value, 0) / Math.max(1, novelty.length)
  const threshold = avgNovelty * 1.22
  const minGapSeconds = 10
  const minGapFrames = Math.max(1, Math.round(minGapSeconds / frameSeconds))
  const boundaries = [0]
  let lastBoundaryFrame = 0

  for (let i = 1; i < totalFrames - 1; i += 1) {
    const isPeak = novelty[i] > novelty[i - 1] && novelty[i] >= novelty[i + 1]
    const farEnough = i - lastBoundaryFrame >= minGapFrames
    if (isPeak && farEnough && novelty[i] > threshold) {
      boundaries.push(i * frameSeconds)
      lastBoundaryFrame = i
    }
  }

  const duration = buffer.duration
  boundaries.push(duration)
  const merged = mergeTightBoundaries(boundaries, 11, duration)

  if (merged.length < 4) {
    const sectionCount = Math.min(6, Math.max(4, Math.round(duration / 26)))
    const even: number[] = []
    for (let i = 0; i <= sectionCount; i += 1) even.push((duration / sectionCount) * i)
    return even
  }

  return merged
}


function roundDeviation(value: number) {
  return Math.round(clamp(value, -18, 18))
}

function roundLevelDeviation(value: number) {
  // Level strips need to respond to simple fader moves. The old hard 18% cap
  // made loud drum sections all read the same, so compress the raw deviation
  // gently instead of flattening it.
  const shaped = Math.sign(value) * Math.pow(Math.abs(value), 0.82)
  return Math.round(clamp(shaped, -32, 32))
}

function makeTonalBand(key: TonalBalanceBand['key'], label: string, range: string, share: number, target: number, actionLow: string, actionHigh: string): TonalBalanceBand {
  const rawDeviation = ((share - target) / Math.max(0.0001, target)) * 100
  const deviationPercent = roundDeviation(rawDeviation)
  const abs = Math.abs(deviationPercent)
  const healthyWindow = 10
  const excessPercent = Math.round(clamp(Math.max(0, abs - healthyWindow), 0, 32))
  const status: TonalBalanceBand['status'] = excessPercent <= 0 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: TonalBalanceBand['severity'] = excessPercent <= 0 ? 'good' : excessPercent <= 10 ? 'watch' : 'fix'
  const action = status === 'good' ? `${label} is sitting well. Protect it while fixing bigger bands.` : status === 'low' ? actionLow : actionHigh
  // v0.82: keep the dot/slider based on the real tonal deviation, but show
  // only the amount outside the healthy +/-10% window in the readout.
  return { key, label, range, deviationPercent, displayPercent: excessPercent, status, severity, action }
}

function buildTonalBalanceBands(samples: Float32Array, sampleRate: number, startIndex: number, endIndex: number): TonalBalanceBand[] {
  const low = bandpassRms(samples, sampleRate, startIndex, endIndex, 70, 0.75)
  const lowMid = bandpassRms(samples, sampleRate, startIndex, endIndex, 220, 0.85)
  const mid = bandpassRms(samples, sampleRate, startIndex, endIndex, 1050, 0.85)
  const high = bandpassRms(samples, sampleRate, startIndex, endIndex, 8500, 0.7)
  const total = Math.max(0.0001, low + lowMid + mid + high)

  return [
    makeTonalBand('weight', 'Weight', 'Lows', low / total, 0.28, 'Add kick/bass weight or lift low-end elements about +1–2 dB.', 'Bass too dominant. Try reducing bass or kick about -1–2 dB.'),
    makeTonalBand('body', 'Body', 'Low-mids', lowMid / total, 0.24, 'Add body with guitar, pad, or a gentle 180–300 Hz lift.', 'Low-mid buildup. Cut 150–300 Hz on guitars, pads, or reverb returns.'),
    makeTonalBand('core', 'Core', 'Mids', mid / total, 0.32, 'Mids are thin. Increase guitar/synth about +1–2 dB or add acoustic/pad support.', 'Midrange crowded. Pull supporting guitars/synths back about -1 dB or cut 500 Hz–1 kHz.'),
    makeTonalBand('air', 'Air', 'Highs', high / total, 0.16, 'Add clarity with shaker, cymbal air, or a gentle 8–12 kHz lift.', 'Top end is bright. Reduce hats/cymbals or harsh 6–10 kHz by about -1 dB.'),
  ]
}

const VOCAL_LEVEL_TARGET_ROCK = 0.38

function makeLevelBalanceItem(key: 'vocals' | 'drums' | 'kick' | 'snare' | 'cymbals', label: string, ratio: number, target: number): BalanceStripItem {
  const rawDeviation = ((ratio - target) / Math.max(0.0001, target)) * 100
  const deviationPercent = roundLevelDeviation(rawDeviation)
  const abs = Math.abs(deviationPercent)
  const goodWindow = key === 'drums' ? 9 : key === 'kick' || key === 'snare' || key === 'cymbals' ? 10 : 8
  const watchWindow = key === 'drums' ? 18 : key === 'kick' || key === 'snare' || key === 'cymbals' ? 20 : 14
  const status: BalanceStripItem['status'] = abs <= goodWindow ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: BalanceStripItem['severity'] = abs <= goodWindow ? 'good' : abs <= watchWindow ? 'watch' : 'fix'
  const action = (() => {
    if (status === 'good') return `${label} level is in the pocket. Protect it while fixing bigger issues.`
    if (key === 'vocals') {
      const move = abs >= 18 ? '2 dB' : '1 dB'
      return status === 'low'
        ? 'Try +' + move + ' on the lead vocal first, then re-score before adding EQ.'
        : 'Try -' + move + ' on the lead vocal first, then check that the lyric still feels clear.'
    }
    if (key === 'kick') return status === 'low' ? 'Try +1 dB kick, or add a small 60–90 Hz lift if the fader already feels right.' : 'Try -1 dB kick, or carve a little 60–90 Hz if it is eating the low end.'
    if (key === 'snare') return status === 'low' ? 'Try +1 dB snare or add a little attack around 2–5 kHz.' : 'Try -1 dB snare or soften 2–5 kHz if it is jumping out.'
    if (key === 'cymbals') return status === 'low' ? 'Try +1 dB cymbals, hats, or overheads if the groove lacks top-end motion.' : 'Try -1 dB cymbals/hats or soften 6–10 kHz if the top end is pulling attention.'
    return status === 'low' ? 'Try +1 dB on the drum bus first, then re-score before adding compression.' : 'Try -1 dB on the drum bus first, then check whether the vocal and guitars glue better.'
  })()
  return { key, label, range: status === 'good' ? 'Level check' : status === 'low' ? 'Too quiet' : 'Too loud', deviationPercent, status, severity, action }
}

function makeImpactStrip(score: number, contrast: number, transientStrength: number, movement: number): ImpactStrip {
  // Impact is a lift meter, not a punishment meter.
  // Left means the section may feel flat. Right means the section is lifting harder.
  // Only the far-right edge is treated as potentially fatiguing.
  const flatness = clamp(((78 - score) / 78) * 100, 0, 34)
  const lift = clamp(((score - 82) / 18) * 34, 0, 34)
  const rawDeviation = lift > 2 ? lift : -flatness
  const deviationPercent = Math.round(clamp(rawDeviation, -34, 34))
  const abs = Math.abs(deviationPercent)
  const status: ImpactStrip['status'] = abs <= 8 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: ImpactStrip['severity'] = status === 'low'
    ? abs <= 18 ? 'watch' : 'fix'
    : status === 'high'
      ? abs <= 30 ? 'good' : 'watch'
      : 'good'
  const action = status === 'good'
    ? 'Impact is sitting well. Keep the contrast and punch while fixing other scorecards.'
    : status === 'low'
      ? (transientStrength < movement ? 'Add transient shaping or a touch of parallel compression to the drums.' : 'Increase contrast into this section: trim the previous section slightly or add a downbeat hit.')
      : abs >= 31
        ? 'Huge lift. Keep it if the section deserves it, but check that compression and limiting are not making it tiring.'
        : 'Big lift. This section is arriving with energy. Protect the punch and make sure the previous section gives it room.'
  const earCheck = status === 'good'
    ? ['Does it hit cleanly?', 'Do drums punch through?', 'Does it hold its energy?']
    : status === 'low'
      ? ['Does it hit when it starts?', 'Do the drums feel soft?', 'Does the section feel flat?']
      : abs >= 31
        ? ['Does it still breathe?', 'Is the limiter flattening the groove?', 'Does it fatigue quickly?']
        : ['Does the lift feel exciting?', 'Does the chorus feel bigger?', 'Does the groove still breathe?']
  const range = status === 'low' ? 'Flat' : status === 'high' ? (abs >= 31 ? 'Huge lift' : 'Big lift') : 'Energetic'
  return { key: 'impact', label: 'Impact', range, deviationPercent, status, severity, action, earCheck }
}

function makeCuriosityStrip(score: number): ImpactStrip {
  // Section 1 does not have a previous section to contrast against, so use a
  // listener-pull framing instead of normal impact. Right means the intro is
  // creating more curiosity, not that it is overcooked.
  const deviationPercent = Math.round(clamp(((score - 72) / 28) * 40, -34, 40))
  const status: ImpactStrip['status'] = score >= 86 ? 'high' : score >= 72 ? 'good' : 'low'
  const severity: ImpactStrip['severity'] = score >= 86 ? 'good' : score >= 72 ? 'watch' : 'fix'
  const range = score >= 92 ? 'Magnetic' : score >= 86 ? 'Intriguing' : score >= 72 ? 'Building' : 'Passive'
  const action = score >= 86
    ? 'The intro is pulling attention. Protect the signature idea and avoid adding clutter just to make it louder.'
    : score >= 72
      ? 'There is a hook forming. Try one stronger identity move: a memorable texture, tighter groove, or earlier ear-candy moment.'
      : 'The intro may need a clearer reason to stay. Add a signature sound, rhythmic identity, tension cue, or earlier vocal/lead moment.'
  const earCheck = score >= 86
    ? ['Would you keep listening?', 'Is the signature idea obvious?', 'Does it create anticipation?']
    : score >= 72
      ? ['Is there a clear identity?', 'Does something interesting happen early?', 'Would a stranger stay past 10 seconds?']
      : ['Does the intro feel generic?', 'Is it too static?', 'Is the first hook arriving too late?']
  return { key: 'curiosity', label: 'Curiosity', range, deviationPercent, status, severity, action, earCheck }
}

function scoreCuriosity(
  channel: Float32Array,
  buffer: AudioBuffer,
  sampleRate: number,
  startIndex: number,
  endIndex: number,
  fullRms: number,
  zcr: number,
  transientStrength: number,
  stereoWidth: number,
): number {
  const sectionLength = Math.max(1, endIndex - startIndex)
  const hookEnd = Math.min(endIndex, startIndex + Math.floor(sampleRate * 10))
  const hookLength = Math.max(1, hookEnd - startIndex)
  const half = startIndex + Math.floor(hookLength / 2)

  const earlyRms = rms(channel, startIndex, hookEnd)
  const firstHalfRms = rms(channel, startIndex, half)
  const secondHalfRms = rms(channel, half, hookEnd)
  const earlyTransient = transientFlux(channel, sampleRate, startIndex, hookEnd)
  const earlyTransientStrength = clamp((earlyTransient / Math.max(0.0001, earlyRms)) * 95, 0, 1)
  const earlyZcr = zeroCrossingRate(channel, startIndex, hookEnd)
  const earlyMovement = clamp(earlyZcr * 260 + earlyTransientStrength * 0.35, 0, 1)

  const energyIntent = clamp((earlyRms / Math.max(0.0001, fullRms)) * 0.68, 0, 1)
  const evolution = clamp(Math.abs(secondHalfRms - firstHalfRms) / Math.max(0.0001, Math.max(firstHalfRms, secondHalfRms)) * 1.15, 0, 1)
  const stereoIntrigue = clamp(stereoWidth * 0.95, 0, 1)

  const low = bandpassRms(channel, sampleRate, startIndex, hookEnd, 110, 0.9)
  const body = bandpassRms(channel, sampleRate, startIndex, hookEnd, 420, 0.85)
  const presence = bandpassRms(channel, sampleRate, startIndex, hookEnd, 2600, 0.85)
  const air = bandpassRms(channel, sampleRate, startIndex, hookEnd, 8500, 0.7)
  const spectrumTotal = Math.max(0.0001, low + body + presence + air)
  const spectralIdentity = clamp(
    Math.max(low, body, presence, air) / spectrumTotal * 1.15 +
    Math.abs((presence + air) - (low + body)) / spectrumTotal * 0.45,
    0,
    1,
  )

  const introConfidence = clamp(
    earlyMovement * 0.32 +
    earlyTransientStrength * 0.18 +
    evolution * 0.18 +
    stereoIntrigue * 0.12 +
    spectralIdentity * 0.14 +
    energyIntent * 0.06,
    0,
    1,
  )

  // Blend a few simple, tunable heuristics into one taste-based intro score.
  // v0.54 makes the curve less generous so most good intros land in the 75–90
  // range, and 95+ is reserved for an obvious, memorable opening idea.
  const raw =
    56 +
    introConfidence * 34 +
    evolution * 4 +
    Math.min(3, sectionLength / sampleRate * 0.12)

  return clamp(Math.round(raw), 45, 98)
}

function primaryTonalRecommendation(bands: TonalBalanceBand[], tonalBalance: number): Recommendation {
  const biggest = [...bands].sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent))[0]
  if (!biggest || biggest.severity === 'good') {
    return {
      title: 'Tonal balance is close. Protect the bigger picture',
      detail: 'No obvious tonal band is shouting for attention. Use a reference check before making small EQ moves.',
      priority: 'Worth exploring',
      estimatedLift: '+1 to +3 tonal balance',
      target: 'Tonal balance',
    }
  }

  return {
    title: biggest.action,
    detail: `${biggest.label} (${biggest.range}) is ${Math.abs(biggest.deviationPercent)}% ${biggest.status}. Start with this one move, then re-score before chasing smaller tonal tweaks.`,
    priority: biggest.severity === 'fix' || tonalBalance < 70 ? 'High impact' : 'Worth exploring',
    estimatedLift: biggest.severity === 'fix' || tonalBalance < 70 ? '+4 to +9 tonal balance' : '+2 to +5 tonal balance',
    target: 'Tonal balance',
  }
}


function clarityGoodLimit(key: string) {
  // v0.78: each clarity band gets its own healthy density window. Low-end
  // overlap between kick/bass/808 can be musical glue, while Air gets fatiguing
  // much faster. These limits control the displayed Good/Watch/Fix behaviour
  // and the Clarity score pressure.
  if (key === 'weight') return 20
  if (key === 'body') return 20
  if (key === 'core') return 15
  if (key === 'air') return 10
  return 10
}

function clarityScorePressure(band: BalanceStripItem) {
  // v0.81: the slider position stays based on total density, while the
  // readout/scoring uses only the amount above the healthy tolerance.
  const excess = Math.max(0, Math.abs(band.displayPercent ?? band.deviationPercent))
  return excess <= 0 ? 0 : 8 + excess * 1.15
}

function makeClarityBand(key: string, label: string, range: string, blurPercent: number, action: string): BalanceStripItem {
  // v0.77: Commercial reference tracks often show a consistent right-leaning
  // density profile in Weight/Body/Core even when they still sound clear and
  // readable. Treat that baseline as normal musical density, not instant clash.
  // v0.81: keep the dot/slider based on the real density amount, but show
  // only the amount ABOVE the band’s healthy tolerance in the text label.
  const densityOffset = key === 'body' ? 10 : key === 'core' ? 8 : key === 'weight' ? 8 : 0
  const densityScale = key === 'air' ? 1 : key === 'body' ? 0.92 : 0.9
  const adjustedBlur = Math.max(0, blurPercent - densityOffset) * densityScale
  const goodLimit = clarityGoodLimit(key)
  const actualRounded = Math.round(clamp(adjustedBlur, 0, 32))
  const excessRounded = Math.round(clamp(Math.max(0, adjustedBlur - goodLimit), 0, 32))
  const status: BalanceStripItem['status'] = excessRounded <= 0 ? 'good' : 'high'
  const severity: BalanceStripItem['severity'] = excessRounded <= 0 ? 'good' : excessRounded <= 8 ? 'watch' : 'fix'
  const finalAction = status === 'good' ? `${label} (${range}) is within its healthy density window. Protect it while fixing bigger clashes.` : action
  return { key, label, range, deviationPercent: actualRounded, displayPercent: excessRounded, status, severity, action: finalAction }
}


function makeWidthBand(key: string, label: string, range: string, deviationPercentRaw: number, actionLow: string, actionHigh: string): BalanceStripItem {
  const deviationPercent = Math.round(clamp(deviationPercentRaw, -32, 32))
  const abs = Math.abs(deviationPercent)
  const status: BalanceStripItem['status'] = abs <= 10 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: BalanceStripItem['severity'] = abs <= 10 ? 'good' : abs <= 20 ? 'watch' : 'fix'
  const action = status === 'good'
    ? `${label} is sitting well. Protect it while fixing bigger scorecards.`
    : status === 'low'
      ? actionLow
      : actionHigh
  return { key, label, range, deviationPercent, status, severity, action }
}

function buildWidthBands(stereoWidth: number, previousStereoWidth: number | null, widthMotion: number): BalanceStripItem[] {
  // stereoWidth is side / (mid + side). Wide sides are not automatically bad.
  // Width combines: centre anchor, side energy, total space, and stereo movement.
  // The centre readout is deliberately softer than the side readout: a modern,
  // cinematic section can have very wide sides without automatically having a
  // broken centre.
  const targetSideShare = 0.23
  const sideDeviation = ((stereoWidth - targetSideShare) / targetSideShare) * 100
  const wideExcess = Math.max(0, sideDeviation - 8)
  const narrowExcess = Math.max(0, -sideDeviation - 8)
  const middleDeviation = clamp((narrowExcess * 0.45) - (wideExcess * 0.28), -24, 18)
  const expansionPercent = previousStereoWidth == null
    ? widthMotion * 100
    : ((stereoWidth - previousStereoWidth) / Math.max(0.04, previousStereoWidth)) * 100
  // Make movement more expressive so chorus/bridge expansion can separate from
  // a stable verse, without demanding constant stereo motion.
  const motionDeviation = clamp(expansionPercent * 1.05 + widthMotion * 52, -32, 32)

  const middle = makeWidthBand('middle', 'Middle', 'Centre anchor', middleDeviation, 'The centre may be getting hollow. Keep vocal, kick, bass, and snare firmly centred.', 'The mix is leaning centre-heavy. Move guitars, pads, delays, or textures further out before widening the master bus.')

  const makeWideFriendlyBand = (key: string, label: string, range: string): BalanceStripItem => {
    const deviationPercent = Math.round(clamp(sideDeviation, -32, 32))
    const abs = Math.abs(deviationPercent)
    const status: BalanceStripItem['status'] = abs <= 10 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
    const severity: BalanceStripItem['severity'] = status === 'low'
      ? abs <= 20 ? 'watch' : 'fix'
      : status === 'high'
        ? abs <= 36 ? 'good' : abs <= 52 ? 'watch' : 'fix'
        : 'good'
    const action = status === 'good'
      ? `${label} is sitting well. Protect it while fixing bigger scorecards.`
      : status === 'low'
        ? key === 'side'
          ? 'Side energy is controlled. If this section should open up, add width with double-tracked guitars, stereo pads, delays, or FX returns.'
          : 'Overall width is focused. That can suit verses, but choruses may want wider support layers or ambience.'
        : key === 'side'
          ? 'Side energy is wide. That can be excellent when the vocal, kick, bass, and snare still feel anchored in the middle.'
          : 'Overall spread is spacious. Keep the stereo magic, but strengthen the centre if the section feels hollow.'

    return { key, label, range, deviationPercent, status, severity, action }
  }

  const motionPercent = Math.round(clamp(motionDeviation, -32, 32))
  const motionStatus: BalanceStripItem['status'] = motionPercent < -10 ? 'low' : motionPercent > 10 ? 'high' : 'good'
  const motionSeverity: BalanceStripItem['severity'] = motionPercent < -20 ? 'watch' : 'good'
  const movement: BalanceStripItem = {
    key: 'movement',
    label: 'Movement',
    range: 'Section expansion',
    deviationPercent: motionPercent,
    status: motionStatus,
    severity: motionSeverity,
    action: motionStatus === 'high'
      ? 'The stereo image is expanding here. Great for choruses, lifts, bridges, and final sections when the centre still holds.'
      : motionStatus === 'low'
        ? 'The stereo field is not changing much here. Fine for focused verses, but add an opening move if the section should feel bigger.'
        : 'The stereo field has useful movement without feeling disconnected.',
  }

  return [
    middle,
    makeWideFriendlyBand('side', 'Side', 'Stereo edges'),
    makeWideFriendlyBand('amount', 'Space', 'Overall spread'),
    movement,
  ]
}

function scoreWidthFromBands(widthBands: BalanceStripItem[]) {
  const middle = widthBands.find((band) => band.key === 'middle')
  const side = widthBands.find((band) => band.key === 'side')
  const movement = widthBands.find((band) => band.key === 'movement')
  const middleDeviation = middle?.deviationPercent ?? 0
  const sideDeviation = side?.deviationPercent ?? 0
  const movementDeviation = movement?.deviationPercent ?? 0
  const centrePenalty = Math.max(0, Math.abs(middleDeviation) - 16) * 0.24
  const narrowPenalty = sideDeviation < -12 ? (Math.abs(sideDeviation) - 12) * 0.55 : 0
  const tastefulWideBonus = sideDeviation > 8 && Math.abs(middleDeviation) <= 24
    ? Math.min(5, (sideDeviation - 8) * 0.13)
    : 0
  const movementBonus = movementDeviation > 4 && Math.abs(middleDeviation) <= 26
    ? Math.min(10, (movementDeviation - 4) * 0.34)
    : 0
  const staticPenalty = movementDeviation < -20 ? Math.min(4, (Math.abs(movementDeviation) - 20) * 0.18) : 0
  const tooWidePenalty = sideDeviation > 52 && Math.abs(middleDeviation) > 22 ? (sideDeviation - 52) * 0.18 : 0
  return clamp(Math.round(90 - centrePenalty - narrowPenalty - staticPenalty - tooWidePenalty + tastefulWideBonus + movementBonus), 62, 100)
}

function buildClarityBands(
  samples: Float32Array,
  sampleRate: number,
  startIndex: number,
  endIndex: number,
  transientEnergy: number,
  fullRms: number,
  sectionContext?: { impact?: number; width?: number; tonalBalance?: number; coreStereoSeparation?: number },
): BalanceStripItem[] {
  const weight = bandpassRms(samples, sampleRate, startIndex, endIndex, 70, 0.75)
  const body = bandpassRms(samples, sampleRate, startIndex, endIndex, 220, 0.85)

  // Keep Core as one simple visible band, but analyse it in smaller internal
  // zones. A single synth harmonic cluster should not be treated the same as
  // broad 350 Hz–2 kHz congestion across the whole midrange.
  const lowCore = bandpassRms(samples, sampleRate, startIndex, endIndex, 520, 0.9)
  const midCore = bandpassRms(samples, sampleRate, startIndex, endIndex, 950, 0.9)
  const upperCore = bandpassRms(samples, sampleRate, startIndex, endIndex, 1650, 0.85)
  // Use a composite Core value for the visible broad-band balance.
  // v0.74: after adding Core sub-zones, summing all three Core filters into
  // the shared total made Core dominate the denominator and flattened Weight,
  // Body, and Air. Average the sub-zones for the visible balance so every
  // clarity band keeps its own movement, while still using all three sub-zones
  // internally to decide whether Core density is narrow or broad.
  const core = (lowCore + midCore + upperCore) / 3

  const air = bandpassRms(samples, sampleRate, startIndex, endIndex, 8500, 0.7)
  const total = Math.max(0.0001, weight + body + core + air)
  const coreSubTotal = Math.max(0.0001, weight + body + lowCore + midCore + upperCore + air)
  const weightShare = weight / total
  const bodyShare = body / total
  const coreShare = core / total
  const lowCoreShare = lowCore / coreSubTotal
  const midCoreShare = midCore / coreSubTotal
  const upperCoreShare = upperCore / coreSubTotal
  const airShare = air / total
  const transientLift = clamp((transientEnergy / Math.max(0.0001, fullRms)) * 45, 0, 1)

  // v0.67: Clarity needs to distinguish dense single-source texture from true
  // masking. A bright synth/pad can legitimately own a lot of core/air without
  // multiple instruments fighting. When the low bands are controlled and the
  // section is relatively smooth/coherent, soften the upper-band clash readout.
  const coherentTexture = transientLift < 0.28 && weightShare <= 0.34 && bodyShare <= 0.29
  const cinematicDensity = Boolean(
    coherentTexture
    && (sectionContext?.impact ?? 0) >= 90
    && (sectionContext?.width ?? 0) >= 84
    && (sectionContext?.tonalBalance ?? 0) >= 80,
  )

  // v0.68: If the section is energetic, spatially stable, tonally okay, and the
  // low bands are controlled, treat extra upper-mid energy as intentional density
  // rather than automatic masking. This keeps a single big synth/pad from dragging
  // Clarity down as hard while still leaving true low-mid mud strict.
  const upperDensityTolerance = cinematicDensity ? 0.38 : coherentTexture ? 0.58 : 1
  // v0.73: keep Core smart/forgiving, but let Body and especially Air
  // keep their own personality. Air should still react to cymbal fizz,
  // bright synths, sibilance, and harsh reverbs instead of being protected
  // by the same tolerance used for coherent Core density.
  const bodySensitivity = coherentTexture ? 0.78 : 0.88
  const airTolerance = cinematicDensity ? 0.74 : coherentTexture ? 0.88 : 1
  const coreStereoSeparation = sectionContext?.coreStereoSeparation ?? 0
  // v0.71: Same frequencies are most problematic when they also live in the
  // same stereo location. If the Core energy is clearly separated between left
  // and right, treat some of that density as spatially decoded instead of a
  // direct masking clash. Keep mono/centre-piled Core strict.
  const spatialCoreTolerance = coreStereoSeparation >= 0.34
    ? clamp(1 - ((coreStereoSeparation - 0.34) * 1.15), 0.58, 1)
    : 1
  const coreDensityTolerance = (cinematicDensity ? 0.42 : upperDensityTolerance) * spatialCoreTolerance
  const smearPenalty = coherentTexture ? 0 : (1 - transientLift) * 5

  const clash = (share: number, target: number, extra = 0, sensitivity = 0.62) => {
    const overTarget = Math.max(0, ((share - target) / Math.max(0.0001, target)) * 100)
    return overTarget * sensitivity + extra
  }

  // v0.70: Core is internally split into low/mid/upper zones. If only one
  // sub-zone is hot, show it as a smaller concentrated density warning. If two
  // or three zones are hot, treat it as real broad midrange congestion.
  const coreSubClashes = [
    clash(lowCoreShare, 0.13, smearPenalty * 0.2, 0.50),
    clash(midCoreShare, 0.13, smearPenalty * 0.2, 0.50),
    clash(upperCoreShare, 0.12, smearPenalty * 0.2, 0.50),
  ]
  const hotCoreZones = coreSubClashes.filter((value) => value > 8).length
  const sortedCoreClashes = [...coreSubClashes].sort((a, b) => b - a)
  const concentratedCoreClash = sortedCoreClashes[0] * 0.62
  const twoZoneCoreClash = ((sortedCoreClashes[0] + sortedCoreClashes[1]) / 2) * 0.86
  const broadCoreClash = clash(coreShare, 0.37, smearPenalty * 0.45, 0.54)
  const coreClash = (hotCoreZones <= 1
    ? concentratedCoreClash
    : hotCoreZones === 2
      ? Math.max(twoZoneCoreClash, broadCoreClash * 0.72)
      : Math.max(sortedCoreClashes[0], broadCoreClash)) * coreDensityTolerance

  return [
    makeClarityBand('weight', 'Weight', '20–120 Hz', clash(weightShare, 0.28, smearPenalty * 0.45, 0.68), 'Separate kick and bass first: try sidechain or cut one small pocket around 60–100 Hz.'),
    makeClarityBand('body', 'Body', '120–350 Hz', clash(bodyShare, 0.21, smearPenalty * 0.85, bodySensitivity), 'Low-mid blur. Cut 150–300 Hz about -1 to -2 dB on guitars, pads, or reverb returns.'),
    makeClarityBand('core', 'Core', '350 Hz–2 kHz', coreClash, 'Core density. If vocals/guitars are masked, pull busy synths back about -1 dB or cut a small pocket around 500 Hz–1 kHz.'),
    makeClarityBand('air', 'Air', '5–12 kHz', clash(airShare, 0.16, 0, 1.05) * airTolerance, 'Bright density. If it feels fizzy or masks cymbal/vocal air, ease 6–10 kHz by about -1 dB.'),
  ]
}

function primaryClarityRecommendation(bands: BalanceStripItem[], clarity: number): Recommendation {
  const biggest = [...bands].sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent))[0]
  if (!biggest || biggest.severity === 'good') {
    return {
      title: 'Clarity is close. Protect the clean bands',
      detail: 'No obvious clash band is shouting for attention. Check the vocal against the guitars before making small EQ moves.',
      priority: 'Worth exploring',
      estimatedLift: '+1 to +3 clarity',
      target: 'Instruments',
    }
  }

  return {
    title: biggest.action,
    detail: `${biggest.label} (${biggest.range}) shows ${Math.abs(biggest.deviationPercent)}% clash. Fix this band first, then re-score before chasing smaller clarity tweaks.`,
    priority: biggest.severity === 'fix' || clarity < 70 ? 'High impact' : 'Worth exploring',
    estimatedLift: biggest.severity === 'fix' || clarity < 70 ? '+4 to +9 clarity' : '+2 to +5 clarity',
    target: 'Instruments',
  }
}

function buildMetricInsights(metrics: SectionMetrics, recommendations: Recommendation[], isIntro = false) {
  const dominantRecommendation = recommendations[0]
  return {
    clarity: {
      title: 'Clarity',
      meaning: 'How easily the important parts can be heard and separated in this moment of the mix.',
      influencedBy: 'Masking, low-mid density, vocal presence, and how much elements overlap.',
      currentRead:
        metrics.clarity >= 74
          ? 'This section reads clearly and the main ideas come through without much effort.'
          : `This section is a little cloudier. Biggest contributor here: ${dominantRecommendation.title.toLowerCase()}.`,
    },
    impact: isIntro
      ? {
          title: 'Curiosity',
          meaning: 'How strongly the intro makes a listener want to keep listening.',
          influencedBy: 'Early movement, signature texture, rhythmic identity, stereo intrigue, tension, and how quickly the intro declares a personality.',
          currentRead:
            metrics.impact >= 86
              ? 'The opening has a clear pull. It gives the listener a reason to stay.'
              : metrics.impact >= 72
                ? 'The opening is building curiosity, but one stronger signature idea could make it more memorable.'
                : 'The intro may need a clearer hook, texture, groove, or tension cue in the first few seconds.',
        }
      : {
          title: 'Impact',
          meaning: 'How strongly this section hits in energy, punch, and movement.',
          influencedBy: 'Transient shape, low-end control, density, and how much the section contrasts with the one before it.',
          currentRead:
            metrics.impact >= 72
              ? 'There is enough push here for the section to feel confident.'
              : 'This moment could hit harder if the drums, low end, or transient focus were a touch more assertive.',
        },
    tonalBalance: {
      title: 'Tonal balance',
      meaning: 'How even the frequency spread feels from lows through highs in this section.',
      influencedBy: 'Low-end weight, low-mid build-up, presence energy, top-end sheen, and genre expectations.',
      currentRead:
        metrics.tonalBalance >= 74
          ? 'The tonal spread feels steady and genre-aware without obvious tilt.'
          : 'One tonal area is pulling more attention than the rest. This is useful as a quick guide, but genre still matters.',
    },
    drumsVsEverything: {
      title: 'Drums',
      meaning: 'How confidently the groove is sitting against the rest of the mix in this section.',
      influencedBy: 'Kick weight, transient punch, cymbal snap, drum bus level, and how much the guitars, synths, bass, and vocals are crowding the groove.',
      currentRead:
        metrics.drumsVsEverything >= 82
          ? 'The groove has a strong foundation here. Drums feel like they are helping steer the section.'
          : metrics.drumsVsEverything >= 70
            ? 'The groove is close, but there may be a quick win in drum bus level, parallel compression, or clearing space around the kick/snare.'
            : 'The drums may be getting swallowed by everything else. Start here before chasing smaller polish moves.',
    },
    vocalLevel: {
      title: 'Vocals',
      meaning: 'Whether the vocal level feels anchored against the rest of the mix.',
      influencedBy: 'Vocal fader level, automation, compression, 1–4 kHz presence, masking from guitars/synths, and how dense the section is.',
      currentRead:
        metrics.vocalLevel >= 82
          ? 'The vocal range is sitting confidently here. This is a good anchor for the rest of the mix.'
          : metrics.vocalLevel >= 70
            ? 'The vocal range is close, but a small level or presence move could make this section feel more finished.'
            : 'The vocal may not be owning its space yet. A small fader move or clearing 2–4 kHz in the instruments could be the quick win.',
    },
    width: {
      title: 'Width',
      meaning: 'How the stereo field supports the section: centre strength, side space, and whether the mix expands or contracts with emotional intent.',
      influencedBy: 'Centre-vs-side contrast, panning automation, doubled parts, pads, delay/reverb spread, mono compatibility, and width movement from the previous section.',
      currentRead:
        metrics.width >= 88
          ? 'The stereo image feels intentional: open enough to create size while still protecting the centre.'
          : metrics.width >= 78
            ? 'The stereo space is working, but the section may benefit from either stronger centre anchoring or more obvious width movement.'
            : 'The stereo image may be too static, too narrow, or losing centre confidence. Use width as contrast rather than making everything wide all the time.',
    },
  }
}

function getTimeLabel(start: number, end: number) {
  return `${formatTime(start)}–${formatTime(end)}`
}

function normaliseCustomBoundaries(boundaries: number[], duration: number) {
  const cleaned = [...boundaries, 0, duration]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => clamp(value, 0, duration))
    .sort((a, b) => a - b)

  const result: number[] = []
  for (const value of cleaned) {
    if (!result.length || Math.abs(value - result[result.length - 1]) > 0.05) result.push(value)
  }

  if (result[0] !== 0) result.unshift(0)
  if (Math.abs(result[result.length - 1] - duration) > 0.05) result.push(duration)
  result[0] = 0
  result[result.length - 1] = duration
  return result.length >= 2 ? result : [0, duration]
}

export function buildSections(buffer: AudioBuffer, customBoundaries?: number[]): SectionAnalysis[] {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const boundaries = customBoundaries?.length
    ? normaliseCustomBoundaries(customBoundaries, buffer.duration)
    : detectSectionBoundaries(buffer)
  const globalEnergy = averageAbs(channel, 0, channel.length)
  const sections: SectionAnalysis[] = []

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i]
    const end = boundaries[i + 1]
    const startIndex = Math.floor(start * sampleRate)
    const endIndex = Math.floor(end * sampleRate)
    const energy = averageAbs(channel, startIndex, endIndex)
    const zcr = zeroCrossingRate(channel, startIndex, endIndex)
    const stereoWidth = estimateStereoWidth(buffer, startIndex, endIndex)
    const previousStereoWidth = i > 0
      ? estimateStereoWidth(buffer, Math.floor(boundaries[i - 1] * sampleRate), Math.floor(boundaries[i] * sampleRate))
      : null
    const midpointIndex = startIndex + Math.floor((endIndex - startIndex) / 2)
    const widthFirstHalf = estimateStereoWidth(buffer, startIndex, midpointIndex)
    const widthSecondHalf = estimateStereoWidth(buffer, midpointIndex, endIndex)
    const widthMotion = Math.abs(widthSecondHalf - widthFirstHalf) / Math.max(0.04, Math.max(widthFirstHalf, widthSecondHalf))
    const sectionDuration = end - start
    const tonalBalanceBands = buildTonalBalanceBands(channel, sampleRate, startIndex, endIndex)
    const tonalDeviations = tonalBalanceBands.map((band) => Math.abs(band.deviationPercent))
    const tonalWorstDeviation = Math.max(...tonalDeviations)
    const tonalWatchCount = tonalDeviations.filter((deviation) => deviation > 10).length
    const tonalFixCount = tonalDeviations.filter((deviation) => deviation > 20).length

    const previousStart = i > 0 ? Math.floor(boundaries[i - 1] * sampleRate) : startIndex
    const previousEnd = i > 0 ? Math.floor(boundaries[i] * sampleRate) : startIndex
    const previousEnergy = i > 0 ? averageAbs(channel, previousStart, previousEnd) : globalEnergy
    const sectionLift = clamp((energy - previousEnergy) / Math.max(0.0001, previousEnergy), -0.5, 0.8)
    const tonalBaseScore = tonalWorstDeviation <= 10
      ? 95
      : tonalWorstDeviation <= 20
        ? 90
        : tonalWorstDeviation <= 30
          ? 84
          : 84 - ((tonalWorstDeviation - 30) * 1.1)
    const tonalBalance = clamp(Math.round(tonalBaseScore - Math.max(0, tonalWatchCount - 1) * 2 - tonalFixCount * 2), 62, 96)
    const widthBands = buildWidthBands(stereoWidth, previousStereoWidth, widthMotion)
    const width = scoreWidthFromBands(widthBands)
    const lowPunch = bandpassRms(channel, sampleRate, startIndex, endIndex, 75, 0.9)
    const lowMidMask = bandpassRms(channel, sampleRate, startIndex, endIndex, 260, 0.85)
    const midBody = bandpassRms(channel, sampleRate, startIndex, endIndex, 1050, 0.85)
    const snapEnergy = bandpassRms(channel, sampleRate, startIndex, endIndex, 6500, 0.7)
    const vocalBand = bandpassRms(channel, sampleRate, startIndex, endIndex, 2400, 0.85)
    const fullRms = rms(channel, startIndex, endIndex)
    const transientEnergy = transientFlux(channel, sampleRate, startIndex, endIndex)
    const transientStrength = clamp((transientEnergy / Math.max(0.0001, fullRms)) * 220, 0, 1)
    const movement = clamp((zcr * 550) + transientStrength * 0.45, 0, 1)
    const contrastScore = clamp(0.5 + sectionLift, 0, 1)
    const normalImpact = clamp(Math.round(56 + contrastScore * 16 + transientStrength * 14 + movement * 8 + Math.min(4, sectionDuration * 0.12)), 42, 94)
    const curiosity = scoreCuriosity(channel, buffer, sampleRate, startIndex, endIndex, fullRms, zcr, transientStrength, stereoWidth)
    const impact = i === 0 ? curiosity : normalImpact
    const impactStrip = i === 0 ? makeCuriosityStrip(curiosity) : makeImpactStrip(impact, contrastScore, transientStrength, movement)
    const coreStereoSeparation = buffer.numberOfChannels >= 2
      ? (
        estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 520, 0.9)
        + estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 950, 0.9)
        + estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 1650, 0.85)
      ) / 3
      : 0
    const clarityBands = buildClarityBands(channel, sampleRate, startIndex, endIndex, transientEnergy, fullRms, { impact, width, tonalBalance, coreStereoSeparation })
    const clarityPressureValues = clarityBands.map((band) => clarityScorePressure(band))
    const clarityWorst = Math.max(...clarityPressureValues)
    const clarityWatchCount = clarityBands.filter((band) => band.severity !== 'good').length
    const clarityFixCount = clarityBands.filter((band) => band.severity === 'fix').length
    const clarityProblemBands = clarityBands.filter((band) => band.severity !== 'good')
    const onlyCoreWarning = clarityProblemBands.length === 1 && clarityProblemBands[0]?.key === 'core'
    const lowBandsClean = clarityBands
      .filter((band) => band.key === 'weight' || band.key === 'body')
      .every((band) => band.severity === 'good')
    const airClean = clarityBands.find((band) => band.key === 'air')?.severity === 'good'
    const intentionalCoreDensity = Boolean(
      onlyCoreWarning
      && lowBandsClean
      && airClean
      && impact >= 88
      && tonalBalance >= 80,
    )

    // v0.69: keep the visible Core clash readout, but stop one isolated,
    // intentional midrange-density warning from cratering the whole Clarity card.
    // Multi-band clashes and low-band mud are still punished hard.
    const effectiveClarityWorst = intentionalCoreDensity
      ? Math.max(10, clarityWorst * 0.52)
      : clarityWorst
    const effectiveWatchCount = intentionalCoreDensity ? 1 : clarityWatchCount
    const effectiveFixCount = intentionalCoreDensity ? 0 : clarityFixCount
    // v0.76: keep the clash readouts expressive, but make the Clarity
    // percentage more perceptual and less punitive. Commercial/reference mixes
    // can show several density warnings while still sounding clear because the
    // ear can decode groove, width, tone, and transient intent. Use a softer
    // score curve here: severe multi-band problems still pull the score down,
    // but normal musical density no longer craters the card.
    const clarityBaseScore = effectiveClarityWorst <= 8
      ? 100
      : effectiveClarityWorst <= 16
        ? 95
        : effectiveClarityWorst <= 24
          ? 91
          : effectiveClarityWorst <= 32
            ? 88
            : 88 - ((effectiveClarityWorst - 32) * 0.6)
    const densityStackPenalty = Math.max(0, effectiveWatchCount - 1) * 0.75 + effectiveFixCount * 1.25
    const clarity = clamp(
      Math.round(clarityBaseScore - densityStackPenalty),
      62,
      100,
    )

    // Full-mix drum proxy: compare drum-like attack/low-end against vocal and midrange content.
    // This avoids the old self-normalised value that could stay frozen after drum bus changes.
    const kickProxy = lowPunch / Math.max(0.0001, lowPunch + lowMidMask + vocalBand + midBody)
    const snareProxy = snapEnergy / Math.max(0.0001, snapEnergy + midBody + vocalBand + lowMidMask)
    const transientProxy = transientEnergy / Math.max(0.0001, fullRms)
    const drumLevelRatio = (kickProxy * 0.45) + (snareProxy * 0.35) + (transientProxy * 2.2)
    const drumLevelTarget = 0.42
    const vocalRatio = vocalBand / Math.max(0.0001, fullRms)
    const drumsVsEverything = scoreAroundTarget(drumLevelRatio, drumLevelTarget, 150, 40, 94)
    const vocalLevel = scoreAroundTarget(vocalRatio, VOCAL_LEVEL_TARGET_ROCK, 150, 40, 100)
    const levelBalance = {
      drums: makeLevelBalanceItem('drums', 'Drums', drumLevelRatio, drumLevelTarget),
      kick: makeLevelBalanceItem('kick', 'Kick', kickProxy, 0.26),
      snare: makeLevelBalanceItem('snare', 'Snare', snareProxy, 0.22),
      cymbals: makeLevelBalanceItem('cymbals', 'Cymbals', snapEnergy / Math.max(0.0001, snapEnergy + vocalBand + midBody + lowPunch), 0.24),
      vocals: makeLevelBalanceItem('vocals', 'Vocals', vocalRatio, VOCAL_LEVEL_TARGET_ROCK),
    }
    const metrics = { clarity, impact, tonalBalance, width, drumsVsEverything, vocalLevel }
    // Match the overall section score to the cards currently shown in the UI.
    // Drums was removed as a visible scorecard, so including it here made the
    // displayed section % feel inconsistent with the five card values users see.
    const visibleCardScores = [clarity, impact, tonalBalance, vocalLevel, width]
    const score = Math.round(visibleCardScores.reduce((sum, value) => sum + Math.round(value), 0) / visibleCardScores.length)

    const strengths = [
      {
        title: 'Density is working in your favour',
        detail: 'The atmosphere already feels like part of the song rather than a random accident.',
      },
      {
        title: i === 0
          ? (impact >= 86 ? 'Curiosity is pulling attention' : 'The intro is setting the table')
          : (impact >= 74 ? 'Impact feels confident' : 'Dynamics feel controlled'),
        detail:
          i === 0
            ? (impact >= 86
                ? 'The opening section has enough identity and movement to make the listener lean in.'
                : 'The opening has a base to build from, but one stronger signature idea could make it more magnetic.')
            : impact >= 74
              ? 'This section carries enough forward motion to feel rewarding.'
              : 'Nothing feels wildly unruly here, which gives you a steady base to build from.',
      },
      {
        title: clarity >= 72 ? 'Clarity is landing well' : 'There is a recognisable tonal identity',
        detail:
          clarity >= 72
            ? 'Important elements are reading well without needing to fight for attention.'
            : 'Even before more polish, the section already has a clear personality.',
      },
    ]

    const recommendations: Recommendation[] = [
      primaryClarityRecommendation(clarityBands, clarity),
      drumsVsEverything < 80
        ? drumLevelRatio < drumLevelTarget
          ? {
              title: 'Try +1 dB on the drum bus first',
              detail: 'Easy win: lift the drum bus by about +1 dB and re-score. If it still trails, try +0.5 dB more or add gentle parallel compression.',
              priority: drumsVsEverything < 72 ? 'High impact' : 'Worth exploring',
              estimatedLift: drumsVsEverything < 72 ? '+4 to +8 drum balance' : '+2 to +5 drum balance',
              target: 'Drum balance',
            }
          : {
              title: 'Try -1 dB on the drum bus first',
              detail: 'The drums may be sitting too far forward. Pull the drum bus back by about -1 dB, then check whether the vocal and main instruments glue better.',
              priority: drumsVsEverything < 72 ? 'High impact' : 'Worth exploring',
              estimatedLift: drumsVsEverything < 72 ? '+3 to +7 balance' : '+2 to +4 balance',
              target: 'Drum balance',
            }
        : {
            title: 'Drums are close. Check the chorus lift',
            detail: 'If this is a chorus or final section, a tiny kick/snare push or transient lift may make it feel more release-ready without changing the mix personality.',
            priority: 'Worth exploring',
            estimatedLift: '+1 to +3 impact',
            target: 'Drums',
          },
      vocalLevel < 80
        ? vocalRatio < VOCAL_LEVEL_TARGET_ROCK
          ? {
              title: vocalLevel < 72 ? 'Try +2 dB on the vocal first' : 'Try +1 dB on the vocal first',
              detail: vocalLevel < 72 ? 'Start simple: lift the lead vocal by about +2 dB and re-score. If it still feels tucked away, automate only the buried words before reaching for EQ.' : 'Start simple: lift the lead vocal by about +1 dB and re-score. If it still feels tucked away, automate only the buried words before reaching for EQ.',
              priority: vocalLevel < 72 ? 'High impact' : 'Worth exploring',
              estimatedLift: vocalLevel < 72 ? '+4 to +9 vocal balance' : '+2 to +5 vocal balance',
              target: 'Vocal level',
            }
          : {
              title: vocalLevel < 72 ? 'Try -2 dB on the vocal first' : 'Try -1 dB on the vocal first',
              detail: vocalLevel < 72 ? 'The vocal is likely too forward for a rock reference. Pull it down by about -2 dB, then check whether the track feels more glued together without losing the lyric.' : 'The vocal may be a touch too forward. Pull it down by about -1 dB, then check whether the track feels more glued together without losing the lyric.',
              priority: vocalLevel < 72 ? 'High impact' : 'Worth exploring',
              estimatedLift: vocalLevel < 72 ? '+3 to +7 vocal balance' : '+2 to +5 vocal balance',
              target: 'Vocal level',
            }
        : {
            title: 'Vocal is close. Use automation for the win',
            detail: 'Listen for words that duck behind guitars or synths, then automate those phrases up instead of lifting the whole vocal track.',
            priority: 'Worth exploring',
            estimatedLift: '+1 to +3 vocal balance',
            target: 'Vocal',
          },
      primaryTonalRecommendation(tonalBalanceBands, tonalBalance),
      i === 0
        ? (impact < 82
            ? {
                title: 'Make the intro more curious',
                detail: impact < 70
                  ? 'Try adding a stronger opening identity: a signature sound, rhythmic motif, tension cue, or earlier vocal/lead moment.'
                  : 'The intro is working, but one memorable texture, movement change, or ear-candy moment could pull the listener in faster.',
                priority: impact < 70 ? 'High impact' : 'Worth exploring',
                estimatedLift: impact < 70 ? '+5 to +10 curiosity' : '+2 to +6 curiosity',
                target: 'Mix bus',
              }
            : {
                title: 'Curiosity is working. Protect the hook',
                detail: 'The opening is already pulling attention. Improve other cards without cluttering the signature idea.',
                priority: 'Optional polish',
                estimatedLift: '+1 to +3 curiosity',
                target: 'Mix bus',
              })
        : impact < 75
          ? {
              title: 'Make the hit feel more obvious',
              detail: impact < 68
                ? 'Try a touch more kick/snare transient, a small sub impact on transitions, or tighter low end before adding more level.'
                : 'A small transient lift or transition impact may be enough to push this section toward 80% without rebuilding it.',
              priority: impact < 68 ? 'High impact' : 'Worth exploring',
              estimatedLift: impact < 68 ? '+4 to +8 impact' : '+2 to +5 impact',
              target: 'Drums',
            }
          : {
              title: 'Impact is close. Check the transition into it',
              detail: 'A reverse cymbal, short riser, or small downbeat hit can make this section feel more powerful without changing the main mix.',
              priority: 'Worth exploring',
              estimatedLift: '+1 to +3 impact',
              target: 'Drums',
            },
      width < 80
        ? {
            title: width < 70 ? 'Create clearer width contrast first' : 'Add a subtle width movement',
            detail: width < 70
              ? 'Easy first move: make the section tell a wider story: narrow the previous section slightly, open pads/guitars/delays here, and keep kick, bass, snare, and lead vocal centred.'
              : 'Try a small automation move: widen supporting guitars, pads, delays, or reverb returns as the section arrives. Avoid widening the whole mix bus first.',
            priority: width < 72 ? 'High impact' : 'Worth exploring',
            estimatedLift: width < 72 ? '+4 to +9 width' : '+2 to +5 width',
            target: 'Stereo field',
          }
        : {
            title: 'Width is working. Protect the centre',
            detail: 'The stereo field is already doing its job. Check mono compatibility and whether the previous section gives this one enough contrast.',
            priority: 'Worth exploring',
            estimatedLift: '+1 to +2 width safety',
            target: 'Stereo field',
          },
      {
        title: 'Lead focus could edge forward a touch',
        detail: 'If this section feels emotionally flat, a tiny lift to the main lead element may create more focus without changing the arrangement.',
        priority: 'Optional polish',
        estimatedLift: '+1 to +3 focus',
        target: 'Vocal',
      },
    ]

    sections.push({
      id: `section-${i + 1}`,
      label: getTimeLabel(start, end),
      start,
      end,
      score,
      status: formatStatus(score),
      color: scoreColor(score),
      highlightLevel: getHighlightLevel(score),
      strengths,
      recommendations,
      metrics,
      metricInsights: buildMetricInsights(metrics, recommendations, i === 0),
      tonalBalanceBands,
      clarityBands,
      levelBalance,
      impactStrip,
      widthBands,
    })
  }

  return sections
}

export function formatTime(timeSeconds: number) {
  const totalSeconds = Math.max(0, Math.floor(timeSeconds))
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}
