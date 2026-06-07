import { BalanceStripItem, ImpactStrip, Recommendation, SectionAnalysis, SectionMetrics, TonalBalanceBand, MasteringMetrics, MasteringMode } from './types'

export type AnalysisGenreProfile = {
  tonal?: {
    weight?: number
    body?: number
    core?: number
    air?: number
  }
  tonalWeights?: {
    weight?: number
    body?: number
    core?: number
    air?: number
  }
  density?: {
    weight?: number
    body?: number
    core?: number
    air?: number
  }
  densityWeights?: {
    weight?: number
    body?: number
    core?: number
    air?: number
  }
  vocals?: number
  width?: {
    middle?: number
    side?: number
    amount?: number
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function shiftedTarget(base: number, offset = 0) {
  return base * (1 + offset / 100)
}

function normalizeTargets<T extends Record<string, number>>(targets: T): T {
  const total = Object.values(targets).reduce((sum, value) => sum + value, 0) || 1
  return Object.fromEntries(
    Object.entries(targets).map(([key, value]) => [key, value / total]),
  ) as T
}

function getTonalWeights(genreProfile?: AnalysisGenreProfile) {
  const raw = {
    weight: genreProfile?.tonalWeights?.weight ?? 0.25,
    body: genreProfile?.tonalWeights?.body ?? 0.25,
    core: genreProfile?.tonalWeights?.core ?? 0.25,
    air: genreProfile?.tonalWeights?.air ?? 0.25,
  }

  return normalizeTargets(raw)
}

function weightedTonalDeviation(
  values: Array<{ key: 'weight' | 'body' | 'core' | 'air'; value: number }>,
  weights: Record<'weight' | 'body' | 'core' | 'air', number>,
) {
  return values.reduce((sum, item) => sum + item.value * weights[item.key], 0)
}

function getDensityWeights(genreProfile?: AnalysisGenreProfile) {
  const raw = {
    weight: genreProfile?.densityWeights?.weight ?? 0.24,
    body: genreProfile?.densityWeights?.body ?? 0.34,
    core: genreProfile?.densityWeights?.core ?? 0.28,
    air: genreProfile?.densityWeights?.air ?? 0.14,
  }

  return normalizeTargets(raw)
}

function densityTargets(genreProfile?: AnalysisGenreProfile) {
  // Reference-calibrated occupancy targets. These are intentionally not centred
  // around a scooped low-mid profile: commercial references often carry Body
  // density well to the right while still sounding finished.
  return normalizeTargets({
    weight: shiftedTarget(0.28, genreProfile?.density?.weight ?? 0),
    body: shiftedTarget(0.27, genreProfile?.density?.body ?? 0),
    core: shiftedTarget(0.31, genreProfile?.density?.core ?? 0),
    air: shiftedTarget(0.14, genreProfile?.density?.air ?? 0),
  })
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


function dbFromAmplitude(value: number) {
  return 20 * Math.log10(Math.max(0.000001, value))
}

function dbFromPower(value: number) {
  return 10 * Math.log10(Math.max(0.000000000001, value))
}

function sectionMeanSquare(buffer: AudioBuffer, start: number, end: number) {
  let sum = 0
  let count = 0
  const channelCount = Math.max(1, buffer.numberOfChannels)
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const samples = buffer.getChannelData(channelIndex)
    for (let i = start; i < end; i += 1) {
      const sample = samples[i] ?? 0
      sum += sample * sample
      count += 1
    }
  }
  return sum / Math.max(1, count)
}

function estimateSectionTruePeak(buffer: AudioBuffer, start: number, end: number) {
  let peak = 0
  const channelCount = Math.max(1, buffer.numberOfChannels)
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const samples = buffer.getChannelData(channelIndex)
    const safeEnd = Math.min(end, samples.length - 1)
    for (let i = Math.max(0, start); i <= safeEnd; i += 1) {
      const current = samples[i] ?? 0
      const next = samples[Math.min(samples.length - 1, i + 1)] ?? current
      peak = Math.max(peak, Math.abs(current))
      // Lightweight 4x linear oversample approximation. It is not a laboratory
      // BS.1770 true-peak meter, but it catches the section-level hot spots well
      // enough for Mix Assistant guidance without adding heavy DSP dependencies.
      for (let step = 1; step < 4; step += 1) {
        const t = step / 4
        const interpolated = current + ((next - current) * t)
        peak = Math.max(peak, Math.abs(interpolated))
      }
    }
  }
  return dbFromAmplitude(peak)
}

function estimateTrackTruePeak(buffer: AudioBuffer) {
  return estimateSectionTruePeak(buffer, 0, buffer.length)
}

function masteringCalibrationGain(buffer: AudioBuffer) {
  // Stable v0.181 mastering path: use a whole-track decode-scale correction only
  // when the browser has clearly decoded the file far below normal full-scale.
  // This avoids the Mars/sock-drawer readings from the experimental LUFS path,
  // while preserving PSR because the same gain is applied to loudness and peak.
  const trackPeakDb = estimateTrackTruePeak(buffer)
  const trackLufsEstimate = -0.691 + dbFromPower(sectionMeanSquare(buffer, 0, buffer.length))

  const looksDecodeScaled = trackPeakDb < -6 || trackLufsEstimate < -18
  if (!looksDecodeScaled) return 0

  const loudnessGain = -9.5 - trackLufsEstimate
  const peakGain = -0.8 - trackPeakDb
  return clamp(Math.max(loudnessGain, peakGain, 0), 0, 24)
}

type KWeightedCache = {
  sampleRate: number
  channels: Float32Array[]
}

const kWeightedCache = new WeakMap<AudioBuffer, KWeightedCache>()

function applyBiquad(samples: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number) {
  const out = new Float32Array(samples.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i] ?? 0
    const y0 = (b0 * x0) + (b1 * x1) + (b2 * x2) - (a1 * y1) - (a2 * y2)
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

function getKWeightedChannels(buffer: AudioBuffer) {
  const cached = kWeightedCache.get(buffer)
  if (cached) return cached.channels

  // BS.1770-style K-weighting approximation. These are the standard 48 kHz
  // coefficients used by many lightweight LUFS implementations. They are close
  // enough for section guidance and vastly better than raw RMS pretending to be
  // LUFS. Most Mix Assistant exports are 48 kHz; non-48 kHz material still lands
  // in the right ballpark for comparison rather than falling into the sock drawer.
  const preB = [1.53512485958697, -2.69169618940638, 1.19839281085285]
  const preA = [-1.69065929318241, 0.73248077421585]
  const hpB = [1, -2, 1]
  const hpA = [-1.99004745483398, 0.99007225036621]

  const channels: Float32Array[] = []
  const channelCount = Math.max(1, buffer.numberOfChannels)
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const input = buffer.getChannelData(channelIndex)
    const pre = applyBiquad(input, preB[0], preB[1], preB[2], preA[0], preA[1])
    const weighted = applyBiquad(pre, hpB[0], hpB[1], hpB[2], hpA[0], hpA[1])
    channels.push(weighted)
  }

  kWeightedCache.set(buffer, { sampleRate: buffer.sampleRate, channels })
  return channels
}

function blockPower(channels: Float32Array[], start: number, end: number) {
  let sum = 0
  let count = 0
  for (const samples of channels) {
    const safeEnd = Math.min(end, samples.length)
    for (let i = Math.max(0, start); i < safeEnd; i += 1) {
      const sample = samples[i] ?? 0
      sum += sample * sample
      count += 1
    }
  }
  return sum / Math.max(1, count)
}

function estimateSectionLufs(buffer: AudioBuffer, start: number, end: number) {
  const channels = getKWeightedChannels(buffer)
  const sectionStart = clamp(start, 0, buffer.length - 1)
  const sectionEnd = clamp(end, sectionStart + 1, buffer.length)
  const sectionLength = sectionEnd - sectionStart
  const blockSize = Math.max(1024, Math.round(buffer.sampleRate * 0.4))
  const hopSize = Math.max(256, Math.round(blockSize * 0.25))
  const powers: number[] = []

  if (sectionLength <= blockSize) {
    powers.push(blockPower(channels, sectionStart, sectionEnd))
  } else {
    for (let windowStart = sectionStart; windowStart + Math.round(blockSize * 0.5) < sectionEnd; windowStart += hopSize) {
      const windowEnd = Math.min(sectionEnd, windowStart + blockSize)
      powers.push(blockPower(channels, windowStart, windowEnd))
      if (windowEnd >= sectionEnd) break
    }
  }

  const absoluteGated = powers.filter((power) => -0.691 + dbFromPower(power) > -70)
  if (!absoluteGated.length) return -96

  const preliminaryPower = absoluteGated.reduce((sum, power) => sum + power, 0) / absoluteGated.length
  const relativeGate = (-0.691 + dbFromPower(preliminaryPower)) - 10
  const relativeGated = absoluteGated.filter((power) => -0.691 + dbFromPower(power) > relativeGate)
  const finalPowers = relativeGated.length ? relativeGated : absoluteGated
  const finalPower = finalPowers.reduce((sum, power) => sum + power, 0) / finalPowers.length
  return -0.691 + dbFromPower(finalPower)
}

function estimateRawSectionLoudness(buffer: AudioBuffer, start: number, end: number) {
  return -0.691 + dbFromPower(sectionMeanSquare(buffer, start, end))
}

function estimateActiveRawSectionLoudness(buffer: AudioBuffer, start: number, end: number) {
  const sectionStart = clamp(start, 0, buffer.length - 1)
  const sectionEnd = clamp(end, sectionStart + 1, buffer.length)
  const blockSize = Math.max(1024, Math.round(buffer.sampleRate * 0.4))
  const hopSize = Math.max(256, Math.round(blockSize * 0.25))
  const powers: number[] = []

  if (sectionEnd - sectionStart <= blockSize) {
    powers.push(sectionMeanSquare(buffer, sectionStart, sectionEnd))
  } else {
    for (let windowStart = sectionStart; windowStart + Math.round(blockSize * 0.5) < sectionEnd; windowStart += hopSize) {
      const windowEnd = Math.min(sectionEnd, windowStart + blockSize)
      powers.push(sectionMeanSquare(buffer, windowStart, windowEnd))
      if (windowEnd >= sectionEnd) break
    }
  }

  if (!powers.length) return estimateRawSectionLoudness(buffer, start, end)
  const sorted = powers.filter((power) => power > 0).sort((a, b) => a - b)
  if (!sorted.length) return -96
  // A section read should behave closer to a short-term loudness meter than a
  // whole-section average. Keep the loudest musical body of the section, but do
  // not run the heavy LUFS scan that previously locked the browser.
  const keepFrom = Math.floor(sorted.length * 0.55)
  const active = sorted.slice(keepFrom)
  const activePower = active.reduce((sum, power) => sum + power, 0) / Math.max(1, active.length)
  return -0.691 + dbFromPower(activePower)
}

function estimateMasteringMetrics(buffer: AudioBuffer, start: number, end: number, calibrationGain = 0): MasteringMetrics {
  const meanSquare = sectionMeanSquare(buffer, start, end)
  // v0.181: rollback to the stable fast section read. This is a practical
  // LUFS-style display value, not full EBU R128, but it behaves consistently in
  // the browser and avoids the -120 LUFS / -110 dBTP failure mode.
  let integratedLufs = -0.691 + dbFromPower(meanSquare) + calibrationGain
  let truePeakDb = estimateSectionTruePeak(buffer, start, end) + calibrationGain

  const preRescuePsr = truePeakDb - integratedLufs
  const looksLikeSockDrawerSection = integratedLufs < -18 && truePeakDb < -6 && preRescuePsr >= 5 && preRescuePsr <= 16
  if (looksLikeSockDrawerSection) {
    const rescueGain = clamp(-0.8 - truePeakDb, 0, 18)
    integratedLufs += rescueGain
    truePeakDb += rescueGain
  }

  const psr = truePeakDb - integratedLufs
  return { integratedLufs, truePeakDb, psr }
}



function masteringModeLabel(mode: MasteringMode) {
  if (mode === 'full') return 'Full section'
  if (mode === 'build') return 'Build / verse'
  if (mode === 'breakdown') return 'Breakdown'
  if (mode === 'outro') return 'Outro / quiet'
  return 'Auto section role'
}

function loudnessTargetForSection(globalTarget: number, mode: MasteringMode, index: number, total: number, impact: number) {
  const resolvedMode: MasteringMode = mode === 'auto'
    ? (index === total - 1 ? 'outro' : index === 0 ? 'build' : impact >= 88 ? 'full' : 'build')
    : mode

  const offset = resolvedMode === 'full'
    ? 0
    : resolvedMode === 'build'
      ? -3
      : resolvedMode === 'breakdown'
        ? -6
        : -8

  return {
    mode: resolvedMode,
    target: globalTarget + offset,
    label: masteringModeLabel(resolvedMode),
  }
}

function scoreMasteringDb(value: number, target: number, goodWindow: number, outerWindow: number, cap = 96) {
  const delta = Math.abs(value - target)
  if (delta <= goodWindow) return Math.round(clamp(90 + ((goodWindow - delta) / Math.max(0.0001, goodWindow)) * 8, 0, 100))
  return Math.round(clamp(cap - ((delta - goodWindow) / Math.max(0.0001, outerWindow - goodWindow)) * 46, 35, cap))
}

function scoreLoudness(integratedLufs: number, target: number) {
  if (integratedLufs >= target) return 100
  const gap = target - integratedLufs
  // Section loudness needs to be forgiving: intros, breakdowns and fades can be
  // deliberately quieter while the whole track is still release-ready.
  return Math.round(clamp(100 - (gap * 2.2), 65, 100))
}

function scoreTruePeak(truePeakDb: number) {
  // True Peak is primarily a ceiling/safety check. Being lower than the ceiling
  // is safe; loudness already tells us whether the section has enough level.
  if (truePeakDb > 0) return 35
  if (truePeakDb > -0.1) return 52
  if (truePeakDb > -0.3) return 72
  if (truePeakDb > -0.8) return 90
  return 100
}

function scorePsr(psr: number) {
  if (psr >= 8 && psr <= 12) return Math.round(92 + (1 - Math.abs(psr - 10) / 2) * 6)
  if (psr < 8) return Math.round(clamp(92 - ((8 - psr) * 11), 35, 92))
  return Math.round(clamp(92 - ((psr - 12) * 4.5), 55, 92))
}

function makeMasteringBand(key: 'loudness' | 'truePeak' | 'punch', label: string, value: number, target: number, score: number, readout: string, context = ''): BalanceStripItem {
  const rawDeviation = key === 'truePeak'
    ? (value > target ? ((value - target) / 0.7) * 18 : 0)
    : key === 'punch'
      ? ((value - target) / 2.5) * 18
      : (value >= target ? 10 : -Math.min(28, (target - value) * 1.4))
  const deviationPercent = Math.round(clamp(rawDeviation, -28, 28))
  const abs = Math.abs(deviationPercent)
  const status: BalanceStripItem['status'] = score >= 88 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: BalanceStripItem['severity'] = score >= 88 ? 'good' : score >= 74 ? 'watch' : 'fix'
  const action = key === 'loudness'
    ? `Integrated section loudness. Target here: ${target.toFixed(1)} LUFS${context ? ` (${context})` : ''}. Reaching the target scores as ready; quieter sections are judged against the intended section role.`
    : key === 'truePeak'
      ? 'Estimated true peak safety. Lower is safe; only peaks near or above the ceiling are flagged.'
      : 'PSR/punch. Shows whether the section still has dynamic life after compression and limiting.'
  return { key, label, range: readout, deviationPercent, displayPercent: Math.max(0, 100 - score), status, severity, action }
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
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
  const deviation = Math.abs(value - target)

  // v0.113:
  // Softer elite-region curve. Tiny deviations near the target should still
  // score extremely highly rather than falling away too aggressively.
  let score = 100

  if (deviation <= 1) {
    score = 96 + ((1 - deviation) * 4)
  } else if (deviation <= 2) {
    score = 94 + ((2 - deviation) * 2)
  } else if (deviation <= 5) {
    score = 88 + ((5 - deviation) * 2)
  } else {
    score = 100 - Math.min(100, deviation * sensitivity)
  }

  return clamp(Math.round(score), min, max)
}


function scoreVocalLevelFromRatio(ratio: number, target: number) {
  const deviationPercent = Math.abs(((ratio - target) / Math.max(0.0001, target)) * 100)

  // v0.133:
  // Vocal scoring must match the vocal strip. The generic scoreAroundTarget
  // function works on raw ratio distance, which made obvious "too quiet" or
  // "too loud" vocal sections still display as 100%.
  if (deviationPercent <= 3) return 100
  if (deviationPercent <= 8) return Math.round(100 - ((deviationPercent - 3) * 1.4))
  if (deviationPercent <= 14) return Math.round(93 - ((deviationPercent - 8) * 2.0))

  return clamp(Math.round(81 - ((deviationPercent - 14) * 2.2)), 45, 100)
}

function blendVocalRatioAgainstMidBed(fullMixRatio: number, vocalBand: number, lowPunch: number, lowMidMask: number, midBody: number, snapEnergy: number) {
  // v0.146:
  // The previous sparse-arrangement fix still behaved too much like a full-mix
  // ratio check. In a bass + vocal section the bass can dominate total RMS,
  // while the vocal is actually very exposed against the available arrangement.
  // Make sparse-bed detection more aggressive and judge those sections mostly
  // against the non-vocal bed, not against missing guitars/pads.
  // v0.145:
  // Sparse arrangements need to be judged by vocal dominance, not by how much
  // total midrange exists. A bass + vocal section can sound very forward even
  // when the full-spectrum ratio is pulled down by bass energy. Blend harder
  // toward the arrangement ratio when the non-vocal mid bed is thin, and reduce
  // the low-bed penalty so bass does not masquerade as vocal masking.
  // v0.144:
  // A vocal score based only on vocal-band / whole-mix energy fails in sparse
  // sections. Bass + voice can look "vocal too quiet" because the bass dominates
  // full RMS, even when the voice is actually forward against the musical bed.
  // Use the full-mix ratio for dense sections, but blend toward a mid-bed ratio
  // when guitars/synth mids are sparse. This makes the card answer the musical
  // question: how does the vocal sit against the non-vocal arrangement?
  const midBed = (lowMidMask * 0.42) + (midBody * 0.72) + (snapEnergy * 0.24)
  const lowBed = lowPunch * 0.055
  const vocalVsArrangement = vocalBand / Math.max(0.0001, vocalBand + midBed + lowBed)
  const midBedShare = midBed / Math.max(0.0001, midBed + lowPunch + vocalBand)
  const sparseMidBlend = clamp((0.66 - midBedShare) / 0.42, 0, 0.96)
  const effectiveRatio = (fullMixRatio * (1 - sparseMidBlend)) + (vocalVsArrangement * sparseMidBlend)
  return {
    effectiveRatio,
    vocalVsArrangement,
    sparseMidBlend,
    midBedShare,
  }
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

function buildTonalBalanceBands(samples: Float32Array, sampleRate: number, startIndex: number, endIndex: number, genreProfile?: AnalysisGenreProfile): TonalBalanceBand[] {
  const low = bandpassRms(samples, sampleRate, startIndex, endIndex, 70, 0.75)
  const lowMid = bandpassRms(samples, sampleRate, startIndex, endIndex, 220, 0.85)
  const mid = bandpassRms(samples, sampleRate, startIndex, endIndex, 1050, 0.85)
  const high = bandpassRms(samples, sampleRate, startIndex, endIndex, 8500, 0.7)
  const total = Math.max(0.0001, low + lowMid + mid + high)
  const targets = normalizeTargets({
    weight: shiftedTarget(0.28, genreProfile?.tonal?.weight),
    body: shiftedTarget(0.24, genreProfile?.tonal?.body),
    core: shiftedTarget(0.32, genreProfile?.tonal?.core),
    air: shiftedTarget(0.16, genreProfile?.tonal?.air),
  })

  return [
    makeTonalBand('weight', 'Weight', 'Lows · 20–120 Hz', low / total, targets.weight, 'Add kick/bass weight or lift low-end elements about +1–2 dB.', 'Bass too dominant. Try reducing bass or kick about -1–2 dB.'),
    makeTonalBand('body', 'Body', 'Low-mids · 120–350 Hz', lowMid / total, targets.body, 'Add body with guitar, pad, or a gentle 180–300 Hz lift.', 'Low-mid buildup. Cut 150–300 Hz on guitars, pads, or reverb returns.'),
    makeTonalBand('core', 'Core', 'Mids · 350 Hz–2 kHz', mid / total, targets.core, 'Mids are thin. Increase guitar/synth about +1–2 dB or add acoustic/pad support.', 'Midrange crowded. Pull supporting guitars/synths back about -1 dB or cut 500 Hz–1 kHz.'),
    makeTonalBand('air', 'Air', 'Highs · 5–12 kHz', high / total, targets.air, 'Add clarity with shaker, cymbal air, or a gentle 8–12 kHz lift.', 'Top end is bright. Reduce hats/cymbals or harsh 6–10 kHz by about -1 dB.'),
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

function makeClarityBand(key: string, label: string, range: string, share: number, target: number, actionLow: string, actionHigh: string): BalanceStripItem {
  const rawDeviation = ((share - target) / Math.max(0.0001, target)) * 100
  const deviationPercent = roundLevelDeviation(rawDeviation)
  const abs = Math.abs(deviationPercent)
  const healthyWindow = clarityGoodLimit(key)
  const excessRounded = Math.round(clamp(Math.max(0, abs - healthyWindow), 0, 32))
  const status: BalanceStripItem['status'] = excessRounded <= 0 ? 'good' : deviationPercent < 0 ? 'low' : 'high'
  const severity: BalanceStripItem['severity'] = excessRounded <= 0 ? 'good' : excessRounded <= 8 ? 'watch' : 'fix'
  const action = status === 'good'
    ? `${label} (${range}) is within its reference-calibrated density zone. Protect it while fixing bigger clashes.`
    : status === 'low'
      ? actionLow
      : actionHigh
  return { key, label, range, deviationPercent, displayPercent: excessRounded, status, severity, action }
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

function buildWidthBands(stereoWidth: number, previousStereoWidth: number | null, widthMotion: number, genreProfile?: AnalysisGenreProfile): BalanceStripItem[] {
  // stereoWidth is side / (mid + side). Wide sides are not automatically bad.
  // Width combines: centre anchor, side energy, total space, and stereo movement.
  // The centre readout is deliberately softer than the side readout: a modern,
  // cinematic section can have very wide sides without automatically having a
  // broken centre.
  const widthOffset = ((genreProfile?.width?.side ?? 0) + (genreProfile?.width?.amount ?? 0)) / 2
  const targetSideShare = shiftedTarget(0.23, widthOffset)
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
  const movementAmount = Math.abs(movementDeviation)

  // v0.116:
  // Controlled narrowing can be excellent. A narrower verse should not be
  // punished heavily if the centre is stable and the stereo image is breathing.
  // Weak/static narrowness still gets penalised.
  const centrePenalty = Math.max(0, Math.abs(middleDeviation) - 18) * 0.20

  const centreStable = Math.abs(middleDeviation) <= 20
  const movementBreathing = movementDeviation >= -10 && movementDeviation <= 18
  const movementLively = movementDeviation > 4 && movementDeviation <= 28
  const intentionalNarrowing = sideDeviation < -14 && centreStable && (movementBreathing || movementLively)

  const rawNarrowPenalty = sideDeviation < -14 ? (Math.abs(sideDeviation) - 14) * 0.42 : 0
  const narrowPenalty = intentionalNarrowing ? rawNarrowPenalty * 0.35 : rawNarrowPenalty

  const tooWidePenalty = sideDeviation > 56 && Math.abs(middleDeviation) > 24 ? (sideDeviation - 56) * 0.14 : 0

  const tastefulWideBonus = sideDeviation > 6 && Math.abs(middleDeviation) <= 26
    ? Math.min(6, (sideDeviation - 6) * 0.12)
    : 0

  const intentionalFocusBonus = intentionalNarrowing
    ? Math.min(4, Math.abs(sideDeviation + 14) * 0.12 + (centreStable ? 1.5 : 0))
    : 0

  const baseWidthQuality = clamp(
    90 - centrePenalty - narrowPenalty - tooWidePenalty + tastefulWideBonus + intentionalFocusBonus,
    62,
    98,
  )

  // v0.117:
  // Width movement now has more emotional influence. Static-wide mixes should
  // no longer score similarly to mixes with meaningful stereo storytelling.
  const expansionBonus = movementAmount > 3 && Math.abs(middleDeviation) <= 28
    ? Math.min(10, (movementAmount - 3) * 0.34)
    : 0

  const breathingBonus = movementAmount > 5 && movementAmount <= 14
    ? 2.5
    : 0

  const intentionalContrastBonus = intentionalNarrowing
    ? 3.5
    : 0

  // v0.129:
  // Movement is now judged by magnitude, not direction.
  // A dramatic narrowing can be as emotionally useful as a dramatic widening.
  const movementFlatnessPenalty =
    movementAmount <= 4
      ? 18
      : movementAmount <= 8
        ? 9
        : 0

  const movementStoryBonus =
    movementAmount > 8
      ? Math.min(14, (movementAmount - 8) * 0.42)
      : 0

  const widthMovementQuality = clamp(
    70 + expansionBonus + breathingBonus + intentionalContrastBonus + movementStoryBonus - movementFlatnessPenalty,
    50,
    100,
  )

  const eliteMovementBonus =
    movementAmount > 18 &&
    Math.abs(middleDeviation) <= 24
      ? Math.min(8, (movementAmount - 18) * 0.58)
      : 0

  return clamp(
    Math.round(
      (baseWidthQuality * 0.45) +
      ((widthMovementQuality + eliteMovementBonus) * 0.55)
    ),
    50,
    100,
  )
}

function buildClarityBands(
  samples: Float32Array,
  sampleRate: number,
  startIndex: number,
  endIndex: number,
  transientEnergy: number,
  fullRms: number,
  sectionContext?: { impact?: number; width?: number; tonalBalance?: number; coreStereoSeparation?: number },
  genreProfile?: AnalysisGenreProfile,
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

  const targets = densityTargets(genreProfile)
  const densityShare = {
    weight: weightShare,
    body: bodyShare,
    core: coreShare + (coreClash / 100) * 0.035,
    air: airShare,
  }

  return [
    makeClarityBand('weight', 'Weight', '20–120 Hz', densityShare.weight, targets.weight, 'Weight is lean for this reference profile. Add bass/kick support before cutting low-mids.', 'Separate kick and bass first: try sidechain or cut one small pocket around 60–100 Hz.'),
    makeClarityBand('body', 'Body', '120–350 Hz', densityShare.body, targets.body, 'Body is lean against commercial references. Add warmth with guitars, pads, bass harmonics, or a gentle 180–300 Hz lift.', 'Low-mid accumulation is above this reference zone. Check guitars, pads, bass harmonics, and reverb returns before cutting the mix bus.'),
    makeClarityBand('core', 'Core', '350 Hz–2 kHz', densityShare.core, targets.core, 'Core feels underfilled. Add musical midrange support before pushing air or sub.', 'Core density. If vocals/guitars are masked, pull busy synths back about -1 dB or cut a small pocket around 500 Hz–1 kHz.'),
    makeClarityBand('air', 'Air', '5–12 kHz', densityShare.air, targets.air, 'Air is dark for this profile. Add cymbal/vocal sheen or a gentle 8–12 kHz lift.', 'Bright density. If it feels fizzy or masks cymbal/vocal air, ease 6–10 kHz by about -1 dB.'),
  ]
}

function primaryClarityRecommendation(bands: BalanceStripItem[], clarity: number): Recommendation {
  const biggest = [...bands].sort((a, b) => Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent))[0]
  if (!biggest || biggest.severity === 'good') {
    return {
      title: 'Density is close. Protect the clean bands',
      detail: 'No obvious clash band is shouting for attention. Check the vocal against the guitars before making small EQ moves.',
      priority: 'Worth exploring',
      estimatedLift: '+1 to +3 density',
      target: 'Instruments',
    }
  }

  return {
    title: biggest.action,
    detail: `${biggest.label} (${biggest.range}) is ${Math.abs(biggest.displayPercent ?? biggest.deviationPercent)}% outside the reference-calibrated density zone. Check whether it is musical first, then re-score before chasing smaller density tweaks.`,
    priority: biggest.severity === 'fix' || clarity < 70 ? 'High impact' : 'Worth exploring',
    estimatedLift: biggest.severity === 'fix' || clarity < 70 ? '+4 to +9 density' : '+2 to +5 density',
    target: 'Instruments',
  }
}

function buildMetricInsights(metrics: SectionMetrics, recommendations: Recommendation[], isIntro = false, mastering?: MasteringMetrics) {
  const dominantRecommendation = recommendations[0]
  return {
    clarity: {
      title: 'Density - How crowded or accumulated does each region feel?',
      meaning: 'How much energy is accumulating in each frequency region, and whether that density feels controlled or congested.',
      influencedBy: 'Layering, saturation, low-mid warmth, reverb tails, bass harmonics, vocal presence, and how much elements overlap.',
      currentRead:
        metrics.clarity >= 74
          ? 'The density feels controlled enough that the main ideas still read clearly.'
          : `This section may be carrying too much density in one area. Biggest contributor here: ${dominantRecommendation.title.toLowerCase()}.`,
    },
    impact: isIntro
      ? {
          title: 'Curiosity - How much variation, contrast, and listener interest exists in this section?',
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
          title: 'Impact - How much punch, energy, and movement does this section create?',
          meaning: 'How strongly this section hits in energy, punch, and movement.',
          influencedBy: 'Transient shape, low-end control, density, and how much the section contrasts with the one before it.',
          currentRead:
            metrics.impact >= 72
              ? 'There is enough push here for the section to feel confident.'
              : 'This moment could hit harder if the drums, low end, or transient focus were a touch more assertive.',
        },
    tonalBalance: {
      title: 'Tonal Balance - How much energy exists in each region?',
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
      title: 'Vocals - How clearly and consistently do the vocals sit in the mix?',
      meaning: 'Whether the vocal level feels anchored against the rest of the mix.',
      influencedBy: 'Vocal fader level, automation, compression, 1–4 kHz presence, masking from guitars/synths, and how dense the section is.',
      currentRead:
        metrics.vocalLevel == null
          ? 'No obvious vocal anchor was detected in this section, so the vocal score is marked N/A and excluded from the section percentage.'
          : metrics.vocalLevel >= 82
            ? 'The vocal range is sitting confidently here. This is a good anchor for the rest of the mix.'
            : metrics.vocalLevel >= 70
              ? 'The vocal range is close, but a small level or presence move could make this section feel more finished.'
              : 'The vocal may not be owning its space yet. A small fader move or clearing 2–4 kHz in the instruments could be the quick win.',
    },
    width: {
      title: 'Width - How wide and immersive does the stereo image feel?',
      meaning: 'How the stereo field supports the section: centre strength, side space, and whether the mix expands or contracts with emotional intent.',
      influencedBy: 'Centre-vs-side contrast, panning automation, doubled parts, pads, delay/reverb spread, mono compatibility, and width movement from the previous section.',
      currentRead:
        metrics.width >= 88
          ? 'The stereo image feels intentional: open enough to create size while still protecting the centre.'
          : metrics.width >= 78
            ? 'The stereo space is working, but the section may benefit from either stronger centre anchoring or more obvious width movement.'
            : 'The stereo image may be too static, too narrow, or losing centre confidence. Use width as contrast rather than making everything wide all the time.',
    },
    mastering: {
      title: 'Mastering - Is this section release-ready without being crushed?',
      meaning: 'A combined delivery read based on section loudness, estimated true peak safety, and PSR/punch. It is a technical readiness card, not a replacement for the creative mix cards.',
      influencedBy: 'Limiter drive, clipper ceiling, bus compression, low-end sustain, transient punch, saturation, and how hard the section is being pushed.',
      currentRead: mastering
        ? `${mastering.integratedLufs.toFixed(1)} LUFS, ${mastering.truePeakDb.toFixed(2)} dBTP, PSR ${mastering.psr.toFixed(1)} dB. ${metrics.mastering >= 88 ? 'This section looks release-ready technically.' : metrics.mastering >= 75 ? 'This section is close, but one delivery value is worth checking.' : 'This section may be too quiet, too hot, or dynamically flattened.'}`
        : 'Mastering readout unavailable for this section.',
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

export function buildSections(buffer: AudioBuffer, customBoundaries?: number[], genreProfile?: AnalysisGenreProfile, vocalOverrides: VocalOverrideMode[] = [], masteringModes: MasteringMode[] = [], masteringTarget = -9.5): SectionAnalysis[] {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const boundaries = customBoundaries?.length
    ? normaliseCustomBoundaries(customBoundaries, buffer.duration)
    : detectSectionBoundaries(buffer)
  const globalEnergy = averageAbs(channel, 0, channel.length)
  const masteringGain = masteringCalibrationGain(buffer)
  const vocalScan = boundaries.slice(0, -1).map((start, index) => {
    const sectionStart = Math.floor(start * sampleRate)
    const sectionEnd = Math.floor(boundaries[index + 1] * sampleRate)
    const full = rms(channel, sectionStart, sectionEnd)
    const band = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 2400, 0.85)
    const presence = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 3200, 0.9)
    const warmth = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 750, 0.9)
    const air = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 8500, 0.75)
    return {
      band,
      full,
      ratio: band / Math.max(0.0001, full),
      energyVsSong: full / Math.max(0.0001, globalEnergy),
      presenceShare: presence / Math.max(0.0001, presence + warmth + air),
    }
  })
  const strongestVocalBand = Math.max(0.0001, ...vocalScan.map((item) => item.band))
  const strongestVocalRatio = Math.max(0.0001, ...vocalScan.map((item) => item.ratio))
  const medianVocalBand = Math.max(0.0001, median(vocalScan.map((item) => item.band)))
  const medianVocalRatio = Math.max(0.0001, median(vocalScan.map((item) => item.ratio)))

  // v0.137: Two-pass vocal-anchor detection.
  // A single-section threshold was either too generous (instrumentals scored) or
  // too strict (only the loudest chorus scored). First classify every section,
  // then allow softer vocal sections through when they sit next to stronger
  // vocal evidence. This catches verses/pre-choruses without turning intros,
  // outros, and instrumental breaks into fake vocal cards.
  const scanVocalEvidence = (sectionStart: number, sectionEnd: number, relaxed = false) => {
    const full = rms(channel, sectionStart, sectionEnd)
    const band = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 2400, 0.85)
    const presence = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 3200, 0.9)
    const warmth = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 750, 0.9)
    const lowFormant = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 520, 0.9)
    const midFormant = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 1150, 0.9)
    const air = bandpassRms(channel, sampleRate, sectionStart, sectionEnd, 8500, 0.75)
    const ratio = band / Math.max(0.0001, full)
    const energyVsSong = full / Math.max(0.0001, globalEnergy)
    const presenceShare = presence / Math.max(0.0001, presence + warmth + air)
    const airShare = air / Math.max(0.0001, presence + warmth + lowFormant + midFormant + band + air)
    const bandVsPeak = band / strongestVocalBand
    const ratioVsPeak = ratio / strongestVocalRatio
    const bandVsMedian = band / medianVocalBand
    const ratioVsMedian = ratio / medianVocalRatio

    // v0.154/v0.155: English-singing-ish vocal evidence.
    // The older detector mostly asked whether a section had energy around
    // 2-4 kHz. That let bright guitars/synths through and missed vocals that
    // entered late in a section. This scanner still uses the frequency bands,
    // but only as one ingredient. It also looks for centred formant-like energy,
    // phrase/syllable movement, and rejects wide/steady instrumental textures.
    const durationSamples = Math.max(1, sectionEnd - sectionStart)
    const frameCount = Math.max(4, Math.min(12, Math.round((durationSamples / sampleRate) * 4)))
    const frameSize = Math.max(1, Math.floor(durationSamples / frameCount))
    const frameValues: number[] = []
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const frameStart = sectionStart + (frameIndex * frameSize)
      const frameEnd = frameIndex === frameCount - 1 ? sectionEnd : Math.min(sectionEnd, frameStart + frameSize)
      const frameFull = rms(channel, frameStart, frameEnd)
      const frameWarmth = bandpassRms(channel, sampleRate, frameStart, frameEnd, 750, 0.9)
      const frameCore = bandpassRms(channel, sampleRate, frameStart, frameEnd, 1150, 0.9)
      const framePresence = bandpassRms(channel, sampleRate, frameStart, frameEnd, 2400, 0.85)
      frameValues.push((frameWarmth * 0.35) + (frameCore * 0.35) + (framePresence * 0.55) + (frameFull * 0.05))
    }
    const frameMean = frameValues.reduce((sum, value) => sum + value, 0) / Math.max(1, frameValues.length)
    const frameVariance = frameValues.reduce((sum, value) => sum + ((value - frameMean) * (value - frameMean)), 0) / Math.max(1, frameValues.length)
    const frameStd = Math.sqrt(frameVariance)
    const sortedFrames = [...frameValues].sort((a, b) => a - b)
    const lowFrame = sortedFrames[Math.floor(sortedFrames.length * 0.25)] ?? frameMean
    const highFrame = sortedFrames[Math.floor(sortedFrames.length * 0.80)] ?? frameMean
    const movementRatio = (frameStd + Math.max(0, highFrame - lowFrame) * 0.45) / Math.max(0.0001, frameMean)
    const phraseMovement = clamp((movementRatio - 0.055) / 0.24, 0, 1)

    const formantTotal = Math.max(0.0001, lowFormant + warmth + midFormant + band + presence)
    const formantSpread = Math.min(
      1,
      (Math.min(warmth, midFormant, band) * 3.4) / Math.max(0.0001, (warmth + midFormant + band)),
    )
    const vowelShape = clamp((formantSpread * 0.58) + (presenceShare * 0.32) + ((1 - airShare) * 0.18), 0, 1)
    const coreShare = (warmth + midFormant + band + presence) / Math.max(0.0001, formantTotal + air)
    const centreSeparation = buffer.numberOfChannels >= 2
      ? (
          estimateBandStereoSeparation(buffer, sampleRate, sectionStart, sectionEnd, 750, 0.9)
          + estimateBandStereoSeparation(buffer, sampleRate, sectionStart, sectionEnd, 1150, 0.9)
          + estimateBandStereoSeparation(buffer, sampleRate, sectionStart, sectionEnd, 2400, 0.85)
        ) / 3
      : 0
    const centreFocus = clamp(1 - (centreSeparation / 0.46), 0, 1)
    const instrumentalTexturePenalty = clamp(((centreSeparation - 0.22) / 0.22) + ((airShare - 0.28) / 0.32), 0, 1)

    const spectralScore =
      (bandVsPeak * 24)
      + (ratioVsPeak * 13)
      + (bandVsMedian * 7)
      + (ratioVsMedian * 5)
      + (presenceShare * 10)
      + (energyVsSong * 4)

    const behaviourScore =
      spectralScore
      + (phraseMovement * 20)
      + (vowelShape * 18)
      + (centreFocus * 16)
      + (coreShare * 8)
      - (instrumentalTexturePenalty * 18)

    const score = behaviourScore

    const hasEnglishVocalBehaviour = Boolean(
      centreFocus >= (relaxed ? 0.34 : 0.38)
      && vowelShape >= (relaxed ? 0.42 : 0.46)
      && coreShare >= 0.58
      && airShare <= (relaxed ? 0.56 : 0.50)
      && (
        phraseMovement >= (relaxed ? 0.14 : 0.18)
        || (vowelShape >= 0.60 && presenceShare >= 0.23)
      )
    )

    const strong =
      hasEnglishVocalBehaviour
      && ratio >= 0.064
      && bandVsPeak >= 0.10
      && bandVsMedian >= 0.50
      && energyVsSong >= 0.055
      && score >= 36

    const soft =
      hasEnglishVocalBehaviour
      && ratio >= (relaxed ? 0.047 : 0.055)
      && bandVsPeak >= (relaxed ? 0.065 : 0.085)
      && ratioVsMedian >= (relaxed ? 0.44 : 0.55)
      && bandVsMedian >= (relaxed ? 0.36 : 0.46)
      && energyVsSong >= (relaxed ? 0.036 : 0.050)
      && score >= (relaxed ? 27 : 31)

    return { strong, soft, score, band, ratio, energyVsSong, presenceShare, phraseMovement, vowelShape, centreFocus, airShare, coreShare }
  }

  const vocalEvidenceScan = vocalScan.map((_, index) => {
    const sectionStart = Math.floor(boundaries[index] * sampleRate)
    const sectionEnd = Math.floor(boundaries[index + 1] * sampleRate)
    return scanVocalEvidence(sectionStart, sectionEnd)
  })
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
    const tonalBalanceBands = buildTonalBalanceBands(channel, sampleRate, startIndex, endIndex, genreProfile)
    const tonalWeights = getTonalWeights(genreProfile)
    const tonalDeviations = tonalBalanceBands.map((band) => ({
      key: band.key,
      value: Math.abs(band.deviationPercent),
    }))
    const tonalWorstDeviation = Math.max(...tonalDeviations.map((band) => band.value))
    const tonalWeightedDeviation = weightedTonalDeviation(tonalDeviations, tonalWeights)
    const tonalWatchCount = tonalDeviations.filter((band) => band.value > 10).length
    const tonalFixCount = tonalDeviations.filter((band) => band.value > 20).length

    const previousStart = i > 0 ? Math.floor(boundaries[i - 1] * sampleRate) : startIndex
    const previousEnd = i > 0 ? Math.floor(boundaries[i] * sampleRate) : startIndex
    const previousEnergy = i > 0 ? averageAbs(channel, previousStart, previousEnd) : globalEnergy
    const sectionLift = clamp((energy - previousEnergy) / Math.max(0.0001, previousEnergy), -0.5, 0.8)
    // v0.114: genre-aware tonal band weighting.
    // The main tonal score now follows weighted emotional importance per genre.
    // Worst-band deviation remains as a small safety penalty so a broken band
    // cannot hide completely.
    const tonalBaseScore = tonalWeightedDeviation <= 10
      ? 96
      : tonalWeightedDeviation <= 20
        ? 92
        : tonalWeightedDeviation <= 30
          ? 86
          : 86 - ((tonalWeightedDeviation - 30) * 0.8)
    const tonalWorstPenalty = Math.max(0, tonalWorstDeviation - 18) * 0.22
    const tonalStackPenalty = Math.max(0, tonalWatchCount - 1) * 0.5 + tonalFixCount * 0.8
    const tonalBalance = clamp(Math.round(tonalBaseScore - tonalWorstPenalty - tonalStackPenalty), 62, 100)
    const widthBands = buildWidthBands(stereoWidth, previousStereoWidth, widthMotion, genreProfile)
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
    // Impact now measures section contrast, not only upward lift.
    // A big drop can be just as impactful as a big lift.
    const contrastMagnitude = Math.abs(sectionLift)
    const contrastScore = clamp(0.5 + contrastMagnitude, 0, 1)
    const rawImpact = clamp(Math.round(56 + contrastScore * 16 + transientStrength * 14 + movement * 8 + Math.min(4, sectionDuration * 0.12)), 42, 94)
    const rawImpactStrip = makeImpactStrip(rawImpact, contrastScore, transientStrength, movement)

    // Visible Impact score:
    // 0% contrast/change  -> 80%
    // 23%+ contrast/change -> 100%
    const impactContrastPercent = clamp(Math.min(23, contrastMagnitude * 100), 0, 23)

    const normalImpact = clamp(
      Math.round(80 + (impactContrastPercent / 23) * 20),
      80,
      100,
    )

    const curiosity = scoreCuriosity(channel, buffer, sampleRate, startIndex, endIndex, fullRms, zcr, transientStrength, stereoWidth)
    const impact = i === 0 ? curiosity : normalImpact
    const impactStrip = i === 0 ? makeCuriosityStrip(curiosity) : rawImpactStrip
    const coreStereoSeparation = buffer.numberOfChannels >= 2
      ? (
        estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 520, 0.9)
        + estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 950, 0.9)
        + estimateBandStereoSeparation(buffer, sampleRate, startIndex, endIndex, 1650, 0.85)
      ) / 3
      : 0
    const clarityBands = buildClarityBands(channel, sampleRate, startIndex, endIndex, transientEnergy, fullRms, { impact, width, tonalBalance, coreStereoSeparation }, genreProfile)
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
    const vocalTarget = clamp(VOCAL_LEVEL_TARGET_ROCK + ((genreProfile?.vocals ?? 0) * 0.01), 0.28, 0.48)

    // v0.109: Strong Vocal Anchor Rescue.
    // Use the current section as the primary judge.
    // If vocals look too loud, compare them against the last STRONG vocal anchor,
    // not simply the previous section. This avoids instrumental or sparse bridges
    // poisoning the next chorus or emotional vocal section.
    let bestVocalAnchorRatio: number | null = null
    let bestVocalAnchorBand: number | null = null
    let bestVocalAnchorFullRms: number | null = null
    let bestAnchorScore = 0

    for (let anchorIndex = i - 1; anchorIndex >= 0; anchorIndex -= 1) {
      const anchorStart = Math.floor(boundaries[anchorIndex] * sampleRate)
      const anchorEnd = Math.floor(boundaries[anchorIndex + 1] * sampleRate)

      const anchorFullRms = rms(channel, anchorStart, anchorEnd)
      const anchorVocalBand = bandpassRms(channel, sampleRate, anchorStart, anchorEnd, 2400, 0.85)
      const anchorVocalRatio = anchorVocalBand / Math.max(0.0001, anchorFullRms)
      const anchorDurationWeight = Math.min(anchorEnd - anchorStart, sampleRate * 24) / (sampleRate * 24)
      const anchorEnergyVsSong = anchorFullRms / Math.max(0.0001, globalEnergy)

      // v0.112: pick the best previous full-vocal anchor, not just the nearest.
      // This lets the model skip instrumental/sparse bridges and find the last
      // real chorus/verse-style anchor.
      const isCandidate =
        anchorFullRms > 0.0045
        && anchorVocalRatio >= 0.10
        && anchorEnergyVsSong >= 0.72

      const anchorScore =
        (anchorEnergyVsSong * 45)
        + (anchorDurationWeight * 18)
        + (anchorVocalRatio * 35)

      if (isCandidate && anchorScore > bestAnchorScore) {
        bestAnchorScore = anchorScore
        bestVocalAnchorRatio = anchorVocalRatio
        bestVocalAnchorBand = anchorVocalBand
        bestVocalAnchorFullRms = anchorFullRms
      }
    }

    const currentVocalDeviation = ((vocalRatio - vocalTarget) / Math.max(0.0001, vocalTarget)) * 100
    const currentVocalLooksTooLoud = currentVocalDeviation > 8

    const mixDroppedFromAnchor = bestVocalAnchorFullRms == null
      ? 0
      : clamp((bestVocalAnchorFullRms - fullRms) / Math.max(0.0001, bestVocalAnchorFullRms), 0, 1)

    const vocalAbsoluteDelta = bestVocalAnchorBand == null
      ? null
      : ((vocalBand - bestVocalAnchorBand) / Math.max(0.0001, bestVocalAnchorBand)) * 100

    const anchorRatioDelta = bestVocalAnchorRatio == null
      ? null
      : ((vocalRatio - bestVocalAnchorRatio) / Math.max(0.0001, bestVocalAnchorRatio)) * 100

    const vocalCloseInAbsoluteLevel =
      vocalAbsoluteDelta != null
      && Math.abs(vocalAbsoluteDelta) <= 35

    const vocalNotWildlyDifferentFromAnchor =
      anchorRatioDelta != null
      && Math.abs(anchorRatioDelta) <= 45

    const shouldRescue =
      currentVocalLooksTooLoud
      && mixDroppedFromAnchor >= 0.12
      && vocalCloseInAbsoluteLevel
      && vocalNotWildlyDifferentFromAnchor

    // If the backing mix steps down but the vocal absolute level is close to a
    // strong prior section, pull the judged ratio back toward the anchor.
    const rescueAmount = shouldRescue
      ? clamp(0.55 + mixDroppedFromAnchor * 0.65, 0, 0.96)
      : 0

    const rescuedVocalRatio = bestVocalAnchorRatio == null
      ? vocalRatio
      : (vocalRatio * (1 - rescueAmount)) + (bestVocalAnchorRatio * rescueAmount)

    const vocalArrangementBalance = blendVocalRatioAgainstMidBed(
      rescuedVocalRatio,
      vocalBand,
      lowPunch,
      lowMidMask,
      midBody,
      snapEnergy,
    )
    const rawJudgedVocalRatio = vocalArrangementBalance.effectiveRatio
    // v0.147: arrangement-density vocal window.
    // Sparse commercial sections can carry very forward vocals without sounding
    // wrong, while bass + vocal sections should not be punished as "too quiet"
    // just because the non-vocal midrange bed is absent. Instead of moving the
    // target up or down, keep the genre target stable and compress the judged
    // ratio toward it as the arrangement gets sparser. This creates a wider,
    // breathing acceptance zone for exposed vocals without changing dense
    // chorus behaviour.
    const sparseVocalTolerance = vocalArrangementBalance.sparseMidBlend
    // v0.149: vocal level nudge direction fix.
    // The previous attempt nudged the target upward, which made the visible
    // slider move left because the same vocal ratio became further below the
    // target. To move the displayed vocal placement slightly to the right, lower
    // the judgement target a touch instead. This keeps the adaptive sparse
    // arrangement window intact while matching the APT/Billie Jean calibration.
    const vocalJudgementTarget = clamp(vocalTarget - 0.018, 0.24, 0.48)
    const judgedVocalRatio = vocalJudgementTarget + ((rawJudgedVocalRatio - vocalJudgementTarget) * (1 - (sparseVocalTolerance * 0.72)))

    const drumsVsEverything = scoreAroundTarget(drumLevelRatio, drumLevelTarget, 150, 40, 94)
    const vocalEnergyVsSong = vocalBand / Math.max(0.0001, globalEnergy)
    const sectionEnergyVsSong = fullRms / Math.max(0.0001, globalEnergy)
    const vocalBandVsSongPeak = vocalBand / strongestVocalBand
    const vocalRatioVsSongPeak = vocalRatio / strongestVocalRatio
    const vocalBandVsSongMedian = vocalBand / medianVocalBand
    const vocalRatioVsSongMedian = vocalRatio / medianVocalRatio
    const vocalPresenceBand = bandpassRms(channel, sampleRate, startIndex, endIndex, 3200, 0.9)
    const vocalWarmthBand = bandpassRms(channel, sampleRate, startIndex, endIndex, 750, 0.9)
    const cymbalAirBand = bandpassRms(channel, sampleRate, startIndex, endIndex, 8500, 0.75)
    const vocalPresenceShare = vocalPresenceBand / Math.max(0.0001, vocalPresenceBand + vocalWarmthBand + cymbalAirBand)

    // v0.136: Rebalance vocal N/A detection after v0.135 became too conservative.
    // The previous pass avoided false positives, but it only allowed the most obvious
    // vocal section through. This gate now blends three signs of a real vocal anchor:
    // 1) song-relative vocal-band level, 2) vocal-band ratio compared with the song's
    // strongest/median vocal-like sections, and 3) a presence shape that is not mostly
    // cymbal air. This keeps intros/outros/instrumentals as N/A while letting quieter
    // verses and dense choruses score again.
    const relativeVocalScore =
      (vocalBandVsSongPeak * 42)
      + (vocalRatioVsSongPeak * 24)
      + (vocalBandVsSongMedian * 10)
      + (vocalRatioVsSongMedian * 8)
      + (vocalPresenceShare * 18)
      + (sectionEnergyVsSong * 8)

    const hasBalancedVocalEvidence =
      vocalRatio >= 0.088
      && vocalBandVsSongPeak >= 0.22
      && vocalRatioVsSongPeak >= 0.36
      && vocalBandVsSongMedian >= 0.92
      && vocalPresenceShare >= 0.24
      && sectionEnergyVsSong >= 0.18
      && relativeVocalScore >= 38

    const hasQuietVocalEvidence =
      vocalRatio >= 0.082
      && vocalBandVsSongPeak >= 0.18
      && vocalRatioVsSongMedian >= 1.02
      && vocalBandVsSongMedian >= 0.86
      && vocalPresenceShare >= 0.27
      && sectionEnergyVsSong >= 0.12
      && relativeVocalScore >= 34

    const hasDenseSectionVocalEvidence =
      vocalRatio >= 0.122
      && vocalBandVsSongPeak >= 0.20
      && vocalBandVsSongMedian >= 1.02
      && vocalPresenceShare >= 0.25
      && sectionEnergyVsSong >= 0.16

    const nearbyStrongVocalEvidence = Boolean(
      vocalEvidenceScan[i - 1]?.strong
      || vocalEvidenceScan[i + 1]?.strong
      || (vocalEvidenceScan[i - 2]?.strong && vocalEvidenceScan[i - 1]?.soft)
      || (vocalEvidenceScan[i + 2]?.strong && vocalEvidenceScan[i + 1]?.soft),
    )
    const hasContinuityVocalEvidence = Boolean(vocalEvidenceScan[i]?.soft && nearbyStrongVocalEvidence)

    // v0.138: Catch sections that start instrumental but gain vocals halfway through,
    // while rejecting isolated instrumental false positives. A whole-section average can
    // dilute vocals that arrive in the middle/end; checking each half gives those
    // sections a fair shot. Conversely, a lone section with no neighbouring vocal
    // evidence now needs very strong whole-section evidence before it can score.
    const firstHalfEvidence = scanVocalEvidence(startIndex, midpointIndex, true)
    const secondHalfEvidence = scanVocalEvidence(midpointIndex, endIndex, true)
    const localHalfPeakScore = Math.max(firstHalfEvidence.score, secondHalfEvidence.score)
    const localHalfScoreDelta = Math.abs(firstHalfEvidence.score - secondHalfEvidence.score)

    // v0.150: window-based vocal detection and level basis.
    // Whole-section averaging fails when a section begins instrumental and vocals
    // arrive halfway through. Split the section into small windows, find the
    // vocal-active windows, then judge the vocal level from those windows only.
    // This keeps late-entry vocals alive without letting a steady instrumental
    // texture borrow confidence from the whole block.
    const windowCount = Math.max(3, Math.min(8, Math.round(sectionDuration / 3)))
    const windowSize = Math.max(1, Math.floor((endIndex - startIndex) / windowCount))
    const vocalWindows = Array.from({ length: windowCount }, (_, windowIndex) => {
      const windowStart = startIndex + (windowIndex * windowSize)
      const windowEnd = windowIndex === windowCount - 1 ? endIndex : Math.min(endIndex, windowStart + windowSize)
      const evidence = scanVocalEvidence(windowStart, windowEnd, true)
      return { windowStart, windowEnd, evidence }
    })
    const strongestWindowScore = Math.max(0, ...vocalWindows.map((item) => item.evidence.score))
    const weakestWindowScore = Math.min(...vocalWindows.map((item) => item.evidence.score))
    const windowScoreSpread = strongestWindowScore - weakestWindowScore
    // v0.155/v0.156: sustained vocal-streak detector.
    // Treat N/A as "no credible vocal phrase anywhere in this section", not
    // "the whole section average looks vocal". A section that starts
    // instrumental and then gains vocals should score if it contains a local
    // sustained run of vocal-like windows. A steady instrumental texture should
    // fail because it lacks a phrase-like run/entry shape.
    const isVocalLikeWindow = (item: { evidence: ReturnType<typeof scanVocalEvidence> }) => {
      const evidence = item.evidence
      const behaviouralPass = Boolean(
        evidence.centreFocus >= 0.36
        && evidence.vowelShape >= 0.43
        && evidence.coreShare >= 0.56
        && evidence.airShare <= 0.58
        && (
          evidence.phraseMovement >= 0.12
          || evidence.strong
          || (evidence.score >= 34 && evidence.presenceShare >= 0.24)
        )
      )
      return behaviouralPass && (evidence.strong || evidence.soft || evidence.score >= 30)
    }

    const activeVocalWindows = vocalWindows.filter(isVocalLikeWindow)
    const activeVocalWindowShare = activeVocalWindows.reduce((sum, item) => sum + Math.max(1, item.windowEnd - item.windowStart), 0) / Math.max(1, endIndex - startIndex)
    const activeRun = vocalWindows.reduce((bestRun, item) => {
      if (!isVocalLikeWindow(item)) return { current: 0, best: bestRun.best, windows: 0, bestWindows: bestRun.bestWindows }
      const length = Math.max(1, item.windowEnd - item.windowStart)
      const current = bestRun.current + length
      const windows = bestRun.windows + 1
      return {
        current,
        best: Math.max(bestRun.best, current),
        windows,
        bestWindows: Math.max(bestRun.bestWindows, windows),
      }
    }, { current: 0, best: 0, windows: 0, bestWindows: 0 })
    const activeVocalWindowRun = activeRun.best / Math.max(1, endIndex - startIndex)
    const activeVocalWindowRunCount = activeRun.bestWindows
    const activeAveragePhraseMovement = activeVocalWindows.length
      ? activeVocalWindows.reduce((sum, item) => sum + item.evidence.phraseMovement, 0) / activeVocalWindows.length
      : 0
    const activeAverageScore = activeVocalWindows.length
      ? activeVocalWindows.reduce((sum, item) => sum + item.evidence.score, 0) / activeVocalWindows.length
      : 0
    const windowEnergyValues = vocalWindows.map((item) => rms(channel, item.windowStart, item.windowEnd))
    const firstWindowEnergy = windowEnergyValues[0] ?? 0
    const lastWindowEnergy = windowEnergyValues[windowEnergyValues.length - 1] ?? 0
    const fadingEnergyRatio = lastWindowEnergy / Math.max(0.0001, firstWindowEnergy)
    const downwardWindowSteps = windowEnergyValues.slice(1).filter((value, idx) => value < windowEnergyValues[idx] * 0.94).length
    const strongestWindow = vocalWindows.reduce((best, item) => item.evidence.score > best.evidence.score ? item : best, vocalWindows[0])
    const averageInactiveWindowScore = (() => {
      const inactive = vocalWindows.filter((item) => !isVocalLikeWindow(item))
      if (!inactive.length) return weakestWindowScore
      return inactive.reduce((sum, item) => sum + item.evidence.score, 0) / inactive.length
    })()
    const vocalEntryLift = strongestWindowScore - averageInactiveWindowScore
    const hasSustainedVocalStreak = Boolean(
      activeVocalWindowRunCount >= 2
      || activeVocalWindowRun >= 0.18
      || (activeVocalWindows.length >= 1 && strongestWindow.evidence.strong && activeVocalWindowShare >= 0.08)
    )
    const looksLikeLateVocalEntry = Boolean(
      hasSustainedVocalStreak
      && vocalEntryLift >= 4.5
      && windowScoreSpread >= 5
    )
    const looksLikeFullSectionVocal = Boolean(
      activeVocalWindowShare >= 0.36
      && activeVocalWindowRun >= 0.25
      && strongestWindowScore >= 34
      && activeVocalWindows.some((item) => item.evidence.strong || item.evidence.score >= 38)
    )
    // v0.156: sustained chord / fade-out rejection.
    // A single fading guitar/piano chord can look centred, tonal, and formant-ish
    // for every window, which fools a sustained-window detector. Real English
    // singing usually has more syllabic/phrase movement or a clear entrance. If
    // the whole section is a smooth downward fade with weak phrase movement and
    // no protected vocal evidence, treat it as an instrumental outro texture.
    const looksLikeSustainedFadeTexture = Boolean(
      activeVocalWindowShare >= 0.42
      && activeVocalWindowRun >= 0.34
      && activeAveragePhraseMovement < 0.18
      && vocalEntryLift < 6.5
      && fadingEnergyRatio < 0.82
      && downwardWindowSteps >= Math.max(1, Math.floor(windowEnergyValues.length * 0.42))
      && activeAverageScore < 42
      && !vocalWindows.some((item) => item.evidence.strong && item.evidence.phraseMovement >= 0.16)
    )

    const hasWindowedVocalEvidence = Boolean(
      activeVocalWindows.length > 0
      && strongestWindowScore >= 29
      && (looksLikeLateVocalEntry || looksLikeFullSectionVocal)
      && !looksLikeSustainedFadeTexture
    )

    const weightedWindowMetric = (fn: (start: number, end: number) => number, fallback: number) => {
      if (!hasWindowedVocalEvidence) return fallback
      let total = 0
      let weight = 0
      for (const item of activeVocalWindows) {
        const length = Math.max(1, item.windowEnd - item.windowStart)
        total += fn(item.windowStart, item.windowEnd) * length
        weight += length
      }
      return weight > 0 ? total / weight : fallback
    }

    const vocalLevelFullRms = weightedWindowMetric((windowStart, windowEnd) => rms(channel, windowStart, windowEnd), fullRms)
    const vocalLevelBand = weightedWindowMetric((windowStart, windowEnd) => bandpassRms(channel, sampleRate, windowStart, windowEnd, 2400, 0.85), vocalBand)
    const vocalLevelLowPunch = weightedWindowMetric((windowStart, windowEnd) => bandpassRms(channel, sampleRate, windowStart, windowEnd, 75, 0.9), lowPunch)
    const vocalLevelLowMidMask = weightedWindowMetric((windowStart, windowEnd) => bandpassRms(channel, sampleRate, windowStart, windowEnd, 260, 0.85), lowMidMask)
    const vocalLevelMidBody = weightedWindowMetric((windowStart, windowEnd) => bandpassRms(channel, sampleRate, windowStart, windowEnd, 1050, 0.85), midBody)
    const vocalLevelSnapEnergy = weightedWindowMetric((windowStart, windowEnd) => bandpassRms(channel, sampleRate, windowStart, windowEnd, 6500, 0.7), snapEnergy)

    const windowedVocalRatio = vocalLevelBand / Math.max(0.0001, vocalLevelFullRms)
    const windowedVocalArrangementBalance = blendVocalRatioAgainstMidBed(
      windowedVocalRatio,
      vocalLevelBand,
      vocalLevelLowPunch,
      vocalLevelLowMidMask,
      vocalLevelMidBody,
      vocalLevelSnapEnergy,
    )
    const finalSparseVocalTolerance = hasWindowedVocalEvidence
      ? windowedVocalArrangementBalance.sparseMidBlend
      : sparseVocalTolerance
    const finalRawJudgedVocalRatio = hasWindowedVocalEvidence
      ? windowedVocalArrangementBalance.effectiveRatio
      : rawJudgedVocalRatio
    const finalJudgedVocalRatio = vocalJudgementTarget + ((finalRawJudgedVocalRatio - vocalJudgementTarget) * (1 - (finalSparseVocalTolerance * 0.72)))

    // v0.142: partial vocal detection now needs a local entrance/change.
    // A sustained instrumental texture can look softly vocal-ish in both halves,
    // especially when surrounded by vocal sections. Real partial-vocal sections
    // usually show either a strong half-section signature or a noticeable jump
    // from one half to the other when the vocal arrives.
    const hasPartialVocalEvidence = Boolean(
      hasWindowedVocalEvidence
      || (firstHalfEvidence.strong || secondHalfEvidence.strong)
      || (
        (firstHalfEvidence.soft || secondHalfEvidence.soft)
        && nearbyStrongVocalEvidence
        && (localHalfScoreDelta >= 5.5 || localHalfPeakScore >= 31)
      ),
    )
    const hasNeighbouringVocalContext = Boolean(nearbyStrongVocalEvidence || vocalEvidenceScan[i - 1]?.soft || vocalEvidenceScan[i + 1]?.soft)

    // v0.139/v0.140: tighten the last remaining false-positive path.
    // The continuity pass is useful for quieter sung sections, but a bright
    // instrumental between vocal sections can look vocal-ish for the whole
    // block. Require a real local vocal bump before continuity is allowed to
    // turn a section into a scored Vocal card. This keeps half-section vocals
    // working, but stops one sustained guitar/synth texture from borrowing
    // credibility from neighbouring vocal sections.
    // v0.140: make continuity much harder to trigger on a sustained instrumental.
    // A steady guitar/synth lead can have plenty of presence energy across the
    // whole section, so a high local score alone is not enough. For continuity
    // to rescue a section, we now need either a strong half-section vocal
    // signature, or a clear mid-section change that looks like a vocal entering.
    const localHalfHasVocalShape = Boolean(
      firstHalfEvidence.strong
      || secondHalfEvidence.strong
      || (localHalfPeakScore >= 27 && localHalfScoreDelta >= 5.5)
      || (localHalfPeakScore >= 24 && localHalfScoreDelta >= 8 && Math.max(firstHalfEvidence.presenceShare, secondHalfEvidence.presenceShare) >= 0.24)
    )
    const continuityOnlyVocalGuess = Boolean(
      hasContinuityVocalEvidence
      && !hasBalancedVocalEvidence
      && !hasQuietVocalEvidence
      && !hasDenseSectionVocalEvidence
      && !vocalEvidenceScan[i]?.strong
      && !hasPartialVocalEvidence
    )
    const isLikelyInstrumentalContinuityFalsePositive = Boolean(
      continuityOnlyVocalGuess
      && !localHalfHasVocalShape
    )
    const isIsolatedWeakVocalGuess = Boolean(
      !hasNeighbouringVocalContext
      && !hasPartialVocalEvidence
      && !vocalEvidenceScan[i]?.strong
      && relativeVocalScore < 46,
    )

    const hasVocalAnchorCandidate = Boolean(
      // v0.154: make the local English-singing window scan the source of truth.
      // Whole-section and neighbouring-section guesses can still inform level
      // scoring, but they cannot create a Vocal card on their own. This is what
      // stops intros/instrumentals showing a % while allowing half-section vocal
      // entries to score from their active windows.
      hasWindowedVocalEvidence
      && !isIsolatedWeakVocalGuess
      && !isLikelyInstrumentalContinuityFalsePositive,
    )

    const candidateVocalBalanceItem = makeLevelBalanceItem('vocals', 'Vocals', finalJudgedVocalRatio, vocalJudgementTarget)
    const candidateVocalDisplay = Math.abs(candidateVocalBalanceItem.displayPercent ?? candidateVocalBalanceItem.deviationPercent)

    // v0.141: final false-positive guard.
    // A true no-vocal instrumental can still produce a tiny vocal-like reading
    // from guitar/synth presence. When the visible vocal confidence is only a
    // single-digit/very-low value, treat it as no reliable vocal anchor rather
    // than showing a misleading Vocal card. Real vocal sections should have
    // enough confidence to clear this floor, even if their level needs work.
    const instrumentalTextureFalsePositive = Boolean(
      !firstHalfEvidence.strong
      && !secondHalfEvidence.strong
      && localHalfScoreDelta < 5.5
      && localHalfPeakScore < 31
      && !vocalEvidenceScan[i]?.strong
      && (hasContinuityVocalEvidence || hasPartialVocalEvidence)
    )

    const provisionalVocalLevel = hasVocalAnchorCandidate && !instrumentalTextureFalsePositive
      ? scoreVocalLevelFromRatio(finalJudgedVocalRatio, vocalJudgementTarget)
      : null

    // v0.143: final card-level confidence gate.
    // The remaining instrumental false positive was not failing the evidence gate;
    // it was reaching the visible card as a very low vocal score around 9%.
    // Treat ultra-low vocal scores as no reliable vocal anchor unless the section
    // has strong/balanced/full evidence. Partial and continuity evidence alone can
    // be fooled by sustained guitars/synths, so they no longer override this floor.
    const hasProtectedFullVocalEvidence = Boolean(
      vocalEvidenceScan[i]?.strong
      || hasBalancedVocalEvidence
      || hasQuietVocalEvidence
      || hasDenseSectionVocalEvidence
      || firstHalfEvidence.strong
      || secondHalfEvidence.strong
    )

    // v0.158: targeted final-outro instrumental guard.
    // v0.157 tried to reject sustained chords globally and accidentally broke
    // earlier N/A sections. Keep the good v0.156 detector, but add one narrow
    // rule for the final section only: if it is the last section, has no strong
    // protected vocal evidence, and looks like a low-motion fade/sustain texture,
    // treat it as an instrumental outro rather than a vocal card.
    const isFinalSection = i === boundaries.length - 2
    const finalEnergyRatio = lastWindowEnergy / Math.max(0.0001, Math.max(...windowEnergyValues))
    const looksLikeFinalInstrumentalOutro = Boolean(
      isFinalSection
      && !hasProtectedFullVocalEvidence
      && activeVocalWindows.length > 0
      && activeAveragePhraseMovement < 0.24
      && vocalEntryLift < 12
      && finalEnergyRatio < 0.88
      && strongestWindowScore < 46
    )

    const vocalOverride = vocalOverrides[i] ?? 'auto'
    const masteringMode = masteringModes[i] ?? 'auto'
    const forcedVocalLevel = scoreVocalLevelFromRatio(finalJudgedVocalRatio, vocalJudgementTarget)
    const autoVocalAnchor = Boolean(
      provisionalVocalLevel != null
      // v0.155: the local sustained-window detector is now allowed to keep
      // late-entry vocal sections alive even when the visible balance display is
      // close to centre. The hard low-score floor still blocks weak instrumental
      // ghosts, but a credible local phrase no longer gets thrown away just
      // because only half the section contains vocals.
      && !looksLikeFinalInstrumentalOutro
      && provisionalVocalLevel >= 15
      && (
        provisionalVocalLevel >= 18
        || hasProtectedFullVocalEvidence
        || looksLikeLateVocalEntry
        || looksLikeFullSectionVocal
      )
      && (
        candidateVocalDisplay >= 18
        || hasProtectedFullVocalEvidence
        || looksLikeLateVocalEntry
        || looksLikeFullSectionVocal
      ),
    )

    const hasVocalAnchor = vocalOverride === 'instrumental'
      ? false
      : vocalOverride === 'vocal'
        ? true
        : autoVocalAnchor
    const vocalLevel = hasVocalAnchor ? (vocalOverride === 'vocal' ? forcedVocalLevel : provisionalVocalLevel) : null

    const mastering = estimateMasteringMetrics(buffer, startIndex, endIndex, masteringGain)
    const loudnessRole = loudnessTargetForSection(masteringTarget, masteringMode, i, boundaries.length - 1, impact)
    const loudnessTarget = loudnessRole.target
    const loudness = scoreLoudness(mastering.integratedLufs, loudnessTarget)
    const truePeak = scoreTruePeak(mastering.truePeakDb)
    const punch = scorePsr(mastering.psr)
    const masteringScore = Math.round((loudness * 0.42) + (truePeak * 0.25) + (punch * 0.33))
    const masteringBands = [
      makeMasteringBand('loudness', 'Loudness', mastering.integratedLufs, loudnessTarget, loudness, `${mastering.integratedLufs.toFixed(1)} LUFS`, loudnessRole.label),
      makeMasteringBand('truePeak', 'True Peak', mastering.truePeakDb, -0.8, truePeak, `${mastering.truePeakDb.toFixed(2)} dBTP`),
      makeMasteringBand('punch', 'Punch', mastering.psr, 10, punch, `PSR ${mastering.psr.toFixed(1)} dB`),
    ]

    const vocalBalanceItem = hasVocalAnchor
      ? makeLevelBalanceItem('vocals', 'Vocals', finalJudgedVocalRatio, vocalJudgementTarget)
      : {
          key: 'vocals',
          label: 'Vocals',
          range: 'No vocal detected',
          deviationPercent: 0,
          displayPercent: 0,
          status: 'good' as const,
          severity: 'good' as const,
          action: 'No obvious vocal anchor was detected here, so this section is excluded from vocal scoring.',
        }
    const levelBalance = {
      drums: makeLevelBalanceItem('drums', 'Drums', drumLevelRatio, drumLevelTarget),
      kick: makeLevelBalanceItem('kick', 'Kick', kickProxy, 0.26),
      snare: makeLevelBalanceItem('snare', 'Snare', snareProxy, 0.22),
      cymbals: makeLevelBalanceItem('cymbals', 'Cymbals', snapEnergy / Math.max(0.0001, snapEnergy + vocalBand + midBody + lowPunch), 0.24),
      vocals: vocalBalanceItem,
    }
    const metrics = { clarity, impact, tonalBalance, width, drumsVsEverything, vocalLevel, mastering: masteringScore }
    // Match the section score to visible cards, but skip Vocal when a section
    // is likely an intro, outro, instrumental, or breakdown with no vocal anchor.
    const visibleCardScores = [clarity, impact, tonalBalance, width, masteringScore, ...(vocalLevel == null ? [] : [vocalLevel])]
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
        title: clarity >= 72 ? 'Density is landing well' : 'There is a recognisable tonal identity',
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
      vocalLevel == null
        ? {
            title: 'No vocal anchor detected here',
            detail: 'This section looks instrumental or too sparse for vocal scoring, so the vocal card is marked N/A and excluded from the section percentage.',
            priority: 'Optional polish',
            estimatedLift: 'N/A',
            target: 'Vocal',
          }
        : vocalLevel < 80
          ? finalJudgedVocalRatio < vocalJudgementTarget
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
      vocalOverride,
      metricInsights: buildMetricInsights(metrics, recommendations, i === 0, mastering),
      tonalBalanceBands,
      clarityBands,
      levelBalance,
      impactStrip,
      widthBands,
      mastering,
      masteringBands,
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
