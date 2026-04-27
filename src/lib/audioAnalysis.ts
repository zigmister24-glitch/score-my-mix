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
  const status: TonalBalanceBand['status'] = abs <= 10 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: TonalBalanceBand['severity'] = abs <= 10 ? 'good' : abs <= 20 ? 'watch' : 'fix'
  const action = status === 'good' ? `${label} is sitting well. Protect it while fixing bigger bands.` : status === 'low' ? actionLow : actionHigh
  return { key, label, range, deviationPercent, status, severity, action }
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

function makeLevelBalanceItem(key: 'vocals' | 'drums' | 'kick' | 'snare', label: string, ratio: number, target: number): BalanceStripItem {
  const rawDeviation = ((ratio - target) / Math.max(0.0001, target)) * 100
  const deviationPercent = roundLevelDeviation(rawDeviation)
  const abs = Math.abs(deviationPercent)
  const goodWindow = key === 'drums' ? 9 : key === 'kick' || key === 'snare' ? 10 : 8
  const watchWindow = key === 'drums' ? 18 : key === 'kick' || key === 'snare' ? 20 : 14
  const status: BalanceStripItem['status'] = abs <= goodWindow ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: BalanceStripItem['severity'] = abs <= goodWindow ? 'good' : abs <= watchWindow ? 'watch' : 'fix'
  const action = (() => {
    if (status === 'good') return `${label} level is in the pocket. Protect it while fixing bigger issues.`
    if (key === 'vocals') return status === 'low' ? 'Try +1 dB on the lead vocal first, then re-score before adding EQ.' : 'Try -1 dB on the lead vocal first, then check that the lyric still feels clear.'
    if (key === 'kick') return status === 'low' ? 'Try +1 dB kick, or add a small 60–90 Hz lift if the fader already feels right.' : 'Try -1 dB kick, or carve a little 60–90 Hz if it is eating the low end.'
    if (key === 'snare') return status === 'low' ? 'Try +1 dB snare or add a little attack around 2–5 kHz.' : 'Try -1 dB snare or soften 2–5 kHz if it is jumping out.'
    return status === 'low' ? 'Try +1 dB on the drum bus first, then re-score before adding compression.' : 'Try -1 dB on the drum bus first, then check whether the vocal and guitars glue better.'
  })()
  return { key, label, range: status === 'good' ? 'Level check' : status === 'low' ? 'Too quiet' : 'Too loud', deviationPercent, status, severity, action }
}

function makeImpactStrip(score: number, contrast: number, transientStrength: number, movement: number): ImpactStrip {
  const flatness = clamp(((78 - score) / 78) * 100, 0, 34)
  const overcooked = clamp(((score - 91) / 9) * 100, 0, 24)
  const rawDeviation = overcooked > 4 ? overcooked : -flatness
  const deviationPercent = Math.round(clamp(rawDeviation, -34, 24))
  const abs = Math.abs(deviationPercent)
  const status: ImpactStrip['status'] = abs <= 8 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: ImpactStrip['severity'] = abs <= 8 ? 'good' : abs <= 18 ? 'watch' : 'fix'
  const action = status === 'good'
    ? 'Impact is sitting well. Keep the contrast and punch while fixing other scorecards.'
    : status === 'low'
      ? (transientStrength < movement ? 'Add transient shaping or a touch of parallel compression to the drums.' : 'Increase contrast into this section: trim the previous section slightly or add a downbeat hit.')
      : 'Impact may be overcooked. Ease limiter/bus compression or soften the loudest drum attacks.'
  const earCheck = status === 'good'
    ? ['Does it hit cleanly?', 'Do drums punch through?', 'Does it hold its energy?']
    : status === 'low'
      ? ['Does it hit when it starts?', 'Do the drums feel soft?', 'Does the section feel flat?']
      : ['Is the hit too aggressive?', 'Is compression flattening the groove?', 'Does it fatigue quickly?']
  return { key: 'impact', label: 'Impact', range: status === 'good' ? 'Good' : status === 'low' ? 'Flat' : 'Overcooked', deviationPercent, status, severity, action, earCheck }
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


function makeClarityBand(key: string, label: string, range: string, blurPercent: number, action: string): BalanceStripItem {
  const rounded = Math.round(clamp(blurPercent, 0, 28))
  const status: BalanceStripItem['status'] = rounded <= 8 ? 'good' : 'high'
  const severity: BalanceStripItem['severity'] = rounded <= 8 ? 'good' : rounded <= 16 ? 'watch' : 'fix'
  const finalAction = status === 'good' ? `${label} (${range}) is clean enough here. Protect it while fixing bigger clashes.` : action
  return { key, label, range, deviationPercent: rounded, status, severity, action: finalAction }
}

function buildClarityBands(samples: Float32Array, sampleRate: number, startIndex: number, endIndex: number, transientEnergy: number, fullRms: number): BalanceStripItem[] {
  const weight = bandpassRms(samples, sampleRate, startIndex, endIndex, 70, 0.75)
  const body = bandpassRms(samples, sampleRate, startIndex, endIndex, 220, 0.85)
  const core = bandpassRms(samples, sampleRate, startIndex, endIndex, 1050, 0.85)
  const air = bandpassRms(samples, sampleRate, startIndex, endIndex, 8500, 0.7)
  const total = Math.max(0.0001, weight + body + core + air)
  const transientLift = clamp((transientEnergy / Math.max(0.0001, fullRms)) * 45, 0, 1)
  const smearPenalty = (1 - transientLift) * 5

  const clash = (share: number, target: number, extra = 0) => {
    const overTarget = Math.max(0, ((share - target) / Math.max(0.0001, target)) * 100)
    return overTarget * 0.7 + extra
  }

  return [
    makeClarityBand('weight', 'Weight', '20–120 Hz', clash(weight / total, 0.30, smearPenalty * 0.4), 'Separate kick and bass first: try sidechain or cut one small pocket around 60–100 Hz.'),
    makeClarityBand('body', 'Body', '120–350 Hz', clash(body / total, 0.25, smearPenalty), 'Low-mid blur. Cut 150–300 Hz about -1 to -2 dB on guitars, pads, or reverb returns.'),
    makeClarityBand('core', 'Core', '350 Hz–2 kHz', clash(core / total, 0.34, smearPenalty * 0.55), 'Core clash. Pull busy guitars/synths back about -1 dB or cut a small pocket around 500 Hz–1 kHz.'),
    makeClarityBand('air', 'Air', '5–12 kHz', clash(air / total, 0.20, 0), 'Top-end blur. Ease hats, fizz, or bright synths around 6–10 kHz by about -1 dB.'),
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

function buildMetricInsights(metrics: SectionMetrics, recommendations: Recommendation[]) {
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
    impact: {
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
      meaning: 'How open and spacious the stereo image feels in this section.',
      influencedBy: 'Center-vs-side contrast, delay and reverb spread, doubled parts, and how mono the section feels.',
      currentRead:
        metrics.width >= 72
          ? 'This section feels nicely open without losing its center.'
          : 'There is room to open the stereo field a touch if that suits the song.',
    },
    mood: {
      title: 'Mood',
      meaning: 'How cohesive and intentional the atmosphere feels in this section.',
      influencedBy: 'Density, ambience, tonal consistency, and whether the section supports the emotional direction of the song.',
      currentRead:
        metrics.mood >= 80
          ? 'The character of this section is one of its strengths. It already feels intentional.'
          : 'The section is headed in a clear direction, but a little more contrast or focus could make the mood land harder.',
    },
  }
}

function getTimeLabel(start: number, end: number) {
  return `${formatTime(start)}–${formatTime(end)}`
}

export function buildSections(buffer: AudioBuffer): SectionAnalysis[] {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const boundaries = detectSectionBoundaries(buffer)
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
    const width = clamp(Math.round(52 + stereoWidth * 72), 38, 92)
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
    const impact = clamp(Math.round(56 + contrastScore * 16 + transientStrength * 14 + movement * 8 + Math.min(4, sectionDuration * 0.12)), 42, 94)
    const impactStrip = makeImpactStrip(impact, contrastScore, transientStrength, movement)
    const clarityBands = buildClarityBands(channel, sampleRate, startIndex, endIndex, transientEnergy, fullRms)
    const clarityWorst = Math.max(...clarityBands.map((band) => Math.abs(band.deviationPercent)))
    const clarityWatchCount = clarityBands.filter((band) => band.deviationPercent > 8).length
    const clarityBaseScore = clarityWorst <= 8
      ? 95
      : clarityWorst <= 16
        ? 90
        : clarityWorst <= 24
          ? 84
          : 80
    const clarity = clamp(Math.round(clarityBaseScore - Math.max(0, clarityWatchCount - 1) * 2), 62, 96)

    // Full-mix drum proxy: compare drum-like attack/low-end against vocal and midrange content.
    // This avoids the old self-normalised value that could stay frozen after drum bus changes.
    const kickProxy = lowPunch / Math.max(0.0001, lowPunch + lowMidMask + vocalBand + midBody)
    const snareProxy = snapEnergy / Math.max(0.0001, snapEnergy + midBody + vocalBand + lowMidMask)
    const transientProxy = transientEnergy / Math.max(0.0001, fullRms)
    const drumLevelRatio = (kickProxy * 0.45) + (snareProxy * 0.35) + (transientProxy * 2.2)
    const drumLevelTarget = 0.42
    const vocalRatio = vocalBand / Math.max(0.0001, fullRms)
    const drumsVsEverything = scoreAroundTarget(drumLevelRatio, drumLevelTarget, 150, 40, 94)
    const vocalLevel = scoreAroundTarget(vocalRatio, 0.42, 150, 40, 94)
    const levelBalance = {
      drums: makeLevelBalanceItem('drums', 'Drums', drumLevelRatio, drumLevelTarget),
      kick: makeLevelBalanceItem('kick', 'Kick', kickProxy, 0.26),
      snare: makeLevelBalanceItem('snare', 'Snare', snareProxy, 0.22),
      vocals: makeLevelBalanceItem('vocals', 'Vocals', vocalRatio, 0.42),
    }
    const mood = clamp(Math.round(tonalBalance * 0.24 + width * 0.14 + impact * 0.16 + drumsVsEverything * 0.1 + vocalLevel * 0.1 + 18), 48, 95)
    const metrics = { clarity, impact, tonalBalance, width, mood, drumsVsEverything, vocalLevel }
    const score = Math.round((clarity + impact + tonalBalance + width + mood + drumsVsEverything + vocalLevel) / 7)

    const strengths = [
      {
        title: 'Mood & density are working in your favour',
        detail:
          mood >= 80
            ? 'This section feels cohesive and intentional, which is a real strength.'
            : 'The atmosphere already feels like part of the song rather than a random accident.',
      },
      {
        title: impact >= 74 ? 'Impact feels confident' : 'Dynamics feel controlled',
        detail:
          impact >= 74
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
        ? vocalRatio < 0.42
          ? {
              title: 'Try +1 dB on the vocal first',
              detail: 'Start simple: lift the lead vocal by about +1 dB and re-score. If it still feels tucked away, automate only the buried words before reaching for EQ.',
              priority: vocalLevel < 72 ? 'High impact' : 'Worth exploring',
              estimatedLift: vocalLevel < 72 ? '+4 to +9 vocal balance' : '+2 to +5 vocal balance',
              target: 'Vocal level',
            }
          : {
              title: 'Try -1 dB on the vocal first',
              detail: 'The vocal may be a touch too forward. Pull it down by about -1 dB, then check whether the track feels more glued together without losing the lyric.',
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
      impact < 75
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
            title: width < 70 ? 'Move guitars or pads further out first' : 'Open the sides a little more',
            detail: width < 70
              ? 'Easy first move: pan double-tracked guitars, pads, or texture layers wider. Keep kick, bass, snare, and lead vocal centred, then re-score.'
              : 'Try a small extra push on side elements: wider guitars, a stereo delay on a texture, or slightly wider reverb return. Avoid widening the whole mix bus first.',
            priority: width < 72 ? 'High impact' : 'Worth exploring',
            estimatedLift: width < 72 ? '+4 to +9 width' : '+2 to +5 width',
            target: 'Stereo field',
          }
        : {
            title: 'Width is working. Protect the centre',
            detail: 'The stereo field is already doing its job. Check mono compatibility rather than pushing it wider.',
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
      metricInsights: buildMetricInsights(metrics, recommendations),
      tonalBalanceBands,
      clarityBands,
      levelBalance,
      impactStrip,
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
