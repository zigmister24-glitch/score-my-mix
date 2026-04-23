import { Recommendation, SectionAnalysis, SectionMetrics } from './types'

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

    const impact = clamp(Math.round(50 + (energy / Math.max(0.0001, globalEnergy)) * 24 + Math.min(6, sectionDuration * 0.18)), 40, 94)
    const clarity = clamp(Math.round(76 - Math.abs(zcr - 0.082) * 420), 38, 92)
    const tonalBalance = clamp(Math.round(67 + (globalEnergy - Math.abs(globalEnergy - energy)) * 140), 42, 92)
    const width = clamp(Math.round(52 + stereoWidth * 72), 38, 92)
    const mood = clamp(Math.round(tonalBalance * 0.3 + width * 0.18 + impact * 0.18 + 28), 48, 95)
    const score = Math.round(clarity * 0.29 + impact * 0.2 + tonalBalance * 0.19 + width * 0.14 + mood * 0.18)

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
      clarity < 68
        ? {
            title: 'Low-mid energy could open up slightly',
            detail: 'A gentle tidy-up around 250–350 Hz will likely improve separation in this section.',
            priority: 'High impact',
            estimatedLift: '+5 to +10 clarity',
            target: 'Overall mix',
          }
        : {
            title: 'Presence could step forward a touch',
            detail: 'A subtle lift around 2–4 kHz will likely help this section speak more clearly.',
            priority: 'Worth exploring',
            estimatedLift: '+3 to +6 clarity',
            target: 'Overall mix',
          },
      tonalBalance < 67
        ? {
            title: 'Tonal balance could feel more settled',
            detail: 'This section may lean a little heavy or light in one range. Genre-aware tonal balance tools can give better context here.',
            priority: 'Worth exploring',
            estimatedLift: '+3 to +7 tonal balance',
            target: 'Tonal balance',
          }
        : impact < 68
          ? {
              title: 'Impact could push a little harder',
              detail: 'Letting more transient through on drums or tightening the low end may make this section hit more convincingly.',
              priority: 'Worth exploring',
              estimatedLift: '+4 to +8 impact',
              target: 'Drums',
            }
          : width < 64
            ? {
                title: 'This section could open up slightly',
                detail: 'A little more width or depth contrast may help this moment feel larger without changing the vibe.',
                priority: 'Optional polish',
                estimatedLift: '+2 to +5 width',
                target: 'Stereo field',
              }
            : {
                title: 'Lead focus could edge forward a touch',
                detail: 'If you want this section to feel more immediate, nudging the lead element forward is worth exploring.',
                priority: 'Optional polish',
                estimatedLift: '+2 to +4 focus',
                target: 'Vocal',
              },
    ]

    const metrics = { clarity, impact, tonalBalance, width, mood }
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
