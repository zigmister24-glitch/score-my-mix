import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import WaveformPanel, { WaveformHandle } from './components/WaveformPanel'
import { buildSections, decodeAudioFile } from './lib/audioAnalysis'
import { SectionAnalysis } from './lib/types'

const ACCEPTED_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac']
const METRIC_ORDER: Array<keyof SectionAnalysis['metrics']> = ['clarity', 'impact', 'tonalBalance', 'drumsVsEverything', 'vocalLevel', 'width', 'mood']

type LeaderboardEntry = {
  id: string
  score: number
  artist: string
  title: string
  displayName: string
  filename: string
  uploadedAt: string
  format: string
  durationSeconds: number
  normalizedTitle: string
}

function stripExtension(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

function normalizeTitle(name: string) {
  return stripExtension(name)
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\b(master|mix|final|bounce|export|demo|version|v\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function sameSong(a: Pick<LeaderboardEntry, 'normalizedTitle' | 'durationSeconds'>, b: Pick<LeaderboardEntry, 'normalizedTitle' | 'durationSeconds'>) {
  const durationClose =
    !a.durationSeconds ||
    !b.durationSeconds ||
    Math.abs(a.durationSeconds - b.durationSeconds) <= 2
  return a.normalizedTitle === b.normalizedTitle && durationClose
}

function inferTrackIdentity(file: File) {
  const raw = stripExtension(file.name).replace(/[_]+/g, ' ').trim()
  const dashMatch = raw.split(/\s+-\s+/)
  if (dashMatch.length >= 2) {
    const artist = dashMatch[0].trim()
    const title = dashMatch.slice(1).join(' - ').trim()
    return {
      artist,
      title,
      displayName: `${artist} - ${title}`,
    }
  }

  return {
    artist: '',
    title: raw,
    displayName: raw,
  }
}

type LeaderboardResponse = {
  ok: boolean
  error?: string
  status?: 'new_entry' | 'improved' | 'retained'
  allTime?: any[]
  hotStreak?: any[]
  madeAllTime?: boolean
  madeHotStreak?: boolean
  allTimeRank?: number | null
  hotStreakRank?: number | null
}

function mapApiEntry(entry: any): LeaderboardEntry {
  const displayName = entry.display_name || entry.displayName || entry.original_filename || entry.filename || 'Untitled'
  return {
    id: String(entry.id ?? `${displayName}-${entry.uploaded_at ?? ''}`),
    artist: entry.artist ?? '',
    title: entry.title ?? displayName,
    displayName,
    filename: entry.original_filename || entry.filename || '',
    score: Math.round(Number(entry.score ?? 0)),
    uploadedAt: entry.uploaded_at || entry.uploadedAt || new Date().toISOString(),
    format: entry.format ?? '',
    durationSeconds: Math.round(Number(entry.duration_seconds ?? entry.durationSeconds ?? 0)),
    normalizedTitle: String(
      entry.normalized_title ??
      entry.normalizedTitle ??
      normalizeTitle(displayName || entry.original_filename || entry.filename || '')
    ),
  }
}

async function readLeaderboard(): Promise<{
  allTime: LeaderboardEntry[]
  hotStreak: LeaderboardEntry[]
}> {
  try {
    const res = await fetch('/api/leaderboard', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    if (!res.ok) {
      throw new Error('Leaderboard load failed')
    }

    const text = await res.text()
    const data: LeaderboardResponse = text ? JSON.parse(text) : { ok: false, error: 'Empty leaderboard response' }

    if (!data.ok) {
      throw new Error(data.error || 'Leaderboard load failed')
    }

    return {
      allTime: Array.isArray(data.allTime) ? data.allTime.map(mapApiEntry) : [],
      hotStreak: Array.isArray(data.hotStreak) ? data.hotStreak.map(mapApiEntry) : [],
    }
  } catch (error) {
    console.error('Failed to read global leaderboard:', error)
    return { allTime: [], hotStreak: [] }
  }
}

async function submitLeaderboardEntry(entry: LeaderboardEntry): Promise<LeaderboardResponse | null> {
  try {
    const res = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        score: entry.score,
        duration_seconds: entry.durationSeconds,
        original_filename: entry.filename,
        display_name: entry.displayName,
        normalized_title: entry.normalizedTitle,
      }),
    })

    if (!res.ok) {
      throw new Error('Leaderboard submit failed')
    }

    const text = await res.text()
    const data: LeaderboardResponse = text ? JSON.parse(text) : { ok: false, error: 'Empty leaderboard response' }

    if (!data.ok) {
      throw new Error(data.error || 'Leaderboard submit failed')
    }

    return data
  } catch (error) {
    console.error('Failed to submit global leaderboard entry:', error)
    return null
  }
}


function metricLabel(name: keyof SectionAnalysis['metrics']) {
  if (name === 'tonalBalance') return 'Tonal balance'
  if (name === 'drumsVsEverything') return 'Drums'
  if (name === 'vocalLevel') return 'Vocals'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function formatLeaderboardDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}


export default function App() {
  const [dragActive, setDragActive] = useState(false)
  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [sections, setSections] = useState<SectionAnalysis[]>([])
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  const [activeMetric, setActiveMetric] = useState<keyof SectionAnalysis['metrics']>('clarity')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [trackPlaying, setTrackPlaying] = useState(false)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [leaderboardLast30, setLeaderboardLast30] = useState<LeaderboardEntry[]>([])
  const [leaderboardMessage, setLeaderboardMessage] = useState('')
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)
  const analysisRef = useRef<HTMLElement | null>(null)
  const waveformApiRef = useRef<WaveformHandle | null>(null)

  const activeSectionIndex = useMemo(
    () => sections.findIndex((section) => section.id === activeSectionId),
    [sections, activeSectionId],
  )

  const activeSection = useMemo(
    () => sections.find((section) => section.id === activeSectionId) ?? null,
    [sections, activeSectionId],
  )

  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl)
    }
  }, [fileUrl])

  useEffect(() => {
    let mounted = true

    async function loadGlobalLeaderboard() {
      setLeaderboardLoading(true)
      const boards = await readLeaderboard()
      if (!mounted) return
      setLeaderboard(boards.allTime)
      setLeaderboardLast30(boards.hotStreak)
      setLeaderboardLoading(false)
    }

    loadGlobalLeaderboard()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!sections.length) return
    const sectionAtTime = sections.find((section, index) => {
      const isLast = index === sections.length - 1
      return currentTime >= section.start && (isLast ? currentTime <= section.end : currentTime < section.end)
    })

    if (sectionAtTime && sectionAtTime.id !== activeSectionId) {
      setActiveSectionId(sectionAtTime.id)
    }
  }, [currentTime, sections, activeSectionId])

  const handleFile = async (file: File) => {
    const supported = ACCEPTED_TYPES.includes(file.type) || /\.(wav|mp3|m4a)$/i.test(file.name)
    if (!supported) {
      setError('WAV, MP3, or M4A are supported. Drop in an audio export and the app will map sections for you.')
      return
    }

    setError('')
    setIsLoading(true)

    try {
      if (fileUrl) URL.revokeObjectURL(fileUrl)
      const nextUrl = URL.createObjectURL(file)
      setFileUrl(nextUrl)
      setFileName(file.name)

      const buffer = await decodeAudioFile(file)
      const nextSections = buildSections(buffer)
      const nextOverallScore = nextSections.length
        ? Math.round(nextSections.reduce((sum, section) => sum + section.score, 0) / nextSections.length)
        : 0
      const identity = inferTrackIdentity(file)
      const durationSeconds = Math.round(buffer.duration || 0)
      if (durationSeconds < 60 || durationSeconds > 600) {
        if (fileUrl) URL.revokeObjectURL(fileUrl)
        URL.revokeObjectURL(nextUrl)
        setFileUrl(null)
        setFileName('')
        setError('Uploads need to be between 1 and 10 minutes long.')
        setIsLoading(false)
        return
      }
      const normalizedTitle = normalizeTitle(identity.title || file.name)
      if (!normalizedTitle || normalizedTitle.length < 2) {
        setError('That filename is too short or unclear for the global leaderboard. Rename it and try again.')
        setIsLoading(false)
        return
      }

      const nowIso = new Date().toISOString()
      const currentEntry: LeaderboardEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        score: nextOverallScore,
        artist: identity.artist,
        title: identity.title,
        displayName: identity.displayName,
        filename: file.name,
        uploadedAt: nowIso,
        format: (file.name.split('.').pop() ?? '').toLowerCase(),
        durationSeconds,
        normalizedTitle,
      }

      const leaderboardResult = await submitLeaderboardEntry(currentEntry)

      if (leaderboardResult) {
        const nextAllTime = Array.isArray(leaderboardResult.allTime)
          ? leaderboardResult.allTime.map(mapApiEntry)
          : []
        const nextHotStreak = Array.isArray(leaderboardResult.hotStreak)
          ? leaderboardResult.hotStreak.map(mapApiEntry)
          : []

        setLeaderboard(nextAllTime)
        setLeaderboardLast30(nextHotStreak)

        const messages: string[] = []
        if (leaderboardResult.madeAllTime) {
          if (leaderboardResult.allTimeRank === 1) messages.push('Top of the Legends 🏆')
          else if (leaderboardResult.status === 'improved') messages.push('Nice. You improved your Mixing Legends score')
          else if (leaderboardResult.status === 'retained') messages.push('Still in the Top 6 Mixing Legends')
          else messages.push('Congrats. You made the Top 6 Mixing Legends')
        }
        if (leaderboardResult.madeHotStreak) {
          if (leaderboardResult.hotStreakRank === 1) messages.push('Hot Streak Leader 🔥')
          else if (leaderboardResult.status === 'improved') messages.push('Nice. You improved your 30 Day Hot Streak score')
          else if (leaderboardResult.status === 'retained') messages.push('Still in the Top 6 30 Day Hot Streak')
          else messages.push('Congrats. You hit the Top 6 30 Day Hot Streak')
        }
        setLeaderboardMessage(messages.join(' • '))
      } else {
        const boards = await readLeaderboard()
        setLeaderboard(boards.allTime)
        setLeaderboardLast30(boards.hotStreak)
        setLeaderboardMessage('Global leaderboard unavailable right now. Your mix still scored locally on this page.')
      }
      setSections(nextSections)
      setActiveSectionId(nextSections[0]?.id ?? null)
      setActiveMetric('clarity')
      setCurrentTime(0)
      setTrackPlaying(false)
    } catch (err) {
      console.error(err)
      setError('Could not analyse that file. Try a WAV, MP3, or M4A export from your DAW or bounce app.')
    } finally {
      setIsLoading(false)
    }
  }

  const onInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    await handleFile(file)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(true)
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    await handleFile(file)
  }

  const overallScore = sections.length
    ? Math.round(sections.reduce((sum, section) => sum + section.score, 0) / sections.length)
    : 0

  const bestSection = sections.length ? [...sections].sort((a, b) => b.score - a.score)[0] : null
  const opportunitySection = sections.length ? [...sections].sort((a, b) => a.score - b.score)[0] : null
  const activeMetricInsight = activeSection ? activeSection.metricInsights[activeMetric] : null

  const recommendationTargetsByMetric: Record<keyof SectionAnalysis['metrics'], string[]> = {
    clarity: ['Overall mix', 'Instruments', 'Mix bus'],
    impact: ['Drums', 'Drum balance', 'Mix bus', 'Overall mix'],
    tonalBalance: ['Tonal balance', 'Overall mix'],
    drumsVsEverything: ['Drums', 'Drum balance'],
    vocalLevel: ['Vocal', 'Vocal level'],
    width: ['Stereo field'],
    mood: ['Overall mix', 'Mix bus', 'Instruments', 'Vocal'],
  }

  const metricRecommendations = useMemo(() => {
    if (!activeSection) return []
    const targets = recommendationTargetsByMetric[activeMetric]
    return activeSection.recommendations.filter((recommendation) => targets.includes(recommendation.target))
  }, [activeSection, activeMetric])

  const highImpactMetricRecommendations = metricRecommendations.filter((recommendation) => recommendation.priority === 'High impact')
  const displayedRecommendations = highImpactMetricRecommendations.length
    ? highImpactMetricRecommendations
    : metricRecommendations.filter((recommendation) => recommendation.priority === 'Worth exploring' || recommendation.priority === 'Optional polish')
  const displayedRecommendationMode = highImpactMetricRecommendations.length ? 'Top recommendations' : 'Worth exploring'

  const makeLocalStripItem = (key: string, label: string, range: string, deviationPercent: number, action: string) => {
    const rounded = Math.round(Math.max(-28, Math.min(28, deviationPercent)))
    const abs = Math.abs(rounded)
    const status = abs <= 10 ? 'good' : rounded < 0 ? 'low' : 'high'
    const severity = abs <= 10 ? 'good' : abs <= 20 ? 'watch' : 'fix'
    return { key, label, range, deviationPercent: rounded, status, severity, action }
  }

  const activeWidthBalance = useMemo(() => {
    if (!activeSection) return []
    if (activeSection.widthBands?.length) return activeSection.widthBands

    const widthTarget = 88
    const sideDeviation = Math.max(-28, Math.min(28, (activeSection.metrics.width - widthTarget) * 0.8))
    const middleDeviation = -sideDeviation
    return [
      makeLocalStripItem('middle', 'Middle', 'Centre image', middleDeviation, middleDeviation > 10 ? 'The mix is leaning centre-heavy. Move guitars, pads, delays, or textures further out before widening the master bus.' : middleDeviation < -10 ? 'The centre may be getting hollow. Keep vocal, kick, bass, and snare firmly centred.' : 'Middle energy feels balanced. Protect the vocal, kick, bass, and snare in the centre.'),
      makeLocalStripItem('side', 'Side', 'Stereo edges', sideDeviation, sideDeviation < -10 ? 'Side energy is low. Add width with double-tracked guitars, stereo pads, or wider FX returns.' : sideDeviation > 10 ? 'Side energy is high. Pull back wide FX or check mono compatibility before adding more width.' : 'Side energy is sitting well. Keep the width moves subtle.'),
      makeLocalStripItem('amount', 'Width amount', 'Overall spread', sideDeviation, sideDeviation < -10 ? 'Overall width is a little narrow. Move supporting guitars, pads, delays, or FX wider first.' : sideDeviation > 10 ? 'Overall width may be too wide. Protect mono compatibility and keep the lead vocal, kick, bass, and snare anchored.' : 'Overall width amount is sitting well. Protect the centre and keep the edges alive.'),
    ]
  }, [activeSection])

  const activeMoodStrips = useMemo(() => {
    if (!activeSection) return []
    const bands = activeSection.tonalBalanceBands ?? []
    const band = (key: string) => bands.find((item) => item.key === key)?.deviationPercent ?? 0
    const weight = band('weight')
    const body = band('body')
    const core = band('core')
    const air = band('air')
    const clarityCrowd = Math.max(0, 88 - activeSection.metrics.clarity)
    const brightness = air * 0.65 - weight * 0.25 + (activeSection.metrics.width - 76) * 0.12
    const energy = (activeSection.metrics.impact - 78) * 0.72 + (activeSection.metrics.drumsVsEverything - 80) * 0.28
    const density = clarityCrowd * 0.48 + body * 0.22 + core * 0.16 - 7
    const warmth = body * 0.48 + weight * 0.16 - air * 0.42
    return [
      makeLocalStripItem('darkBright', 'Dark', '', brightness, 'Brightness is mainly driven by Air/top-end, width, and how much low weight is supporting it.'),
      makeLocalStripItem('calmEnergetic', 'Calm', '', energy, 'Energy is mainly driven by impact, drum confidence, transient motion, and section movement.'),
      makeLocalStripItem('sparseDense', 'Sparse', '', density, 'Density rises when clarity drops or low-mid/mid elements start stacking together.'),
      makeLocalStripItem('warmCold', 'Cold', '', warmth, 'Warmth/coldness is shaped by the low-mids against the top-end air and brightness.'),
    ]
  }, [activeSection])

  const activeTonalBands = useMemo(() => activeSection?.tonalBalanceBands ?? [], [activeSection])

  const tonalActionBand = useMemo(() => {
    if (!activeTonalBands.length) return null

    const severityRank = { fix: 3, watch: 2, good: 1 } as const
    return [...activeTonalBands].sort((a, b) => {
      const severityDelta = severityRank[b.severity] - severityRank[a.severity]
      if (severityDelta) return severityDelta
      return Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent)
    })[0]
  }, [activeTonalBands])


  const activeClarityBands = useMemo(() => activeSection?.clarityBands ?? [], [activeSection])

  const clarityActionBand = useMemo(() => {
    if (!activeClarityBands.length) return null

    const severityRank = { fix: 3, watch: 2, good: 1 } as const
    return [...activeClarityBands].sort((a, b) => {
      const severityDelta = severityRank[b.severity] - severityRank[a.severity]
      if (severityDelta) return severityDelta
      return Math.abs(b.deviationPercent) - Math.abs(a.deviationPercent)
    })[0]
  }, [activeClarityBands])

  const activeLevelBalance = useMemo(() => {
    if (!activeSection?.levelBalance) return null
    if (activeMetric === 'vocalLevel') return activeSection.levelBalance.vocals
    return null
  }, [activeSection, activeMetric])

  const activeImpactBalance = useMemo(() => {
    if (activeMetric !== 'impact') return null
    return activeSection?.impactStrip ?? null
  }, [activeSection, activeMetric])

  const goToSection = (index: number, mode: 'seek' | 'play' = 'seek') => {
    if (index < 0 || index >= sections.length) return
    const next = sections[index]
    setActiveSectionId(next.id)
    if (mode === 'play') waveformApiRef.current?.playSection(next)
    else waveformApiRef.current?.seekToSection(next)
  }

  const selectSection = (id: string, jumpToAnalysis = false, mode: 'seek' | 'play' = 'seek') => {
    const found = sections.find((section) => section.id === id)
    if (!found) return
    setActiveSectionId(id)
    if (mode === 'play') waveformApiRef.current?.playSection(found)
    else waveformApiRef.current?.seekToSection(found)
    if (jumpToAnalysis) {
      analysisRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const scoreTone = (score: number) => {
    if (score >= 95) return 'legend'
    if (score >= 90) return 'elite'
    if (score >= 85) return 'target'
    if (score >= 80) return 'strong'
    return 'standard'
  }

  const scoreIcon = (score: number) => {
    if (score >= 95) return '🤯'
    if (score >= 90) return '🏆'
    if (score >= 85) return '⭐'
    return ''
  }

  const scoreLabel = (score: number) => {
    if (score >= 95) return 'HOLY F@CK!!! Alien Tech Achieved'
    if (score >= 90) return "Certified Weapon"
    if (score >= 86) return "Pro Tier - Chart Ready"
    if (score >= 80) return 'Release Ready'
    if (score >= 75) return "On the Rise"
    if (score >= 70) return "Solid Foundation"
    if (score >= 60) return "Taking Shape"
    return "Rough Mix"
  }

  const selectedSectionScores = activeSection ? Object.values(activeSection.metrics) : []

  const allMetricScores = sections.flatMap((section) => Object.values(section.metrics))

  const sectionSummary = allMetricScores.length
    ? [
        { label: 'over 85%', count: allMetricScores.filter((score) => (score >= 85 && score <90)).length },
        { label: 'over 90%', count: allMetricScores.filter((score) => (score >= 90 && score <95)).length },
        { label: 'over 95%', count: allMetricScores.filter((score) => score >= 95).length },
      ]
    : []

  const consistencyMessage = useMemo(() => {
    if (!sections.length) return ''
    const scores = sections.map((section) => section.score)
    const spread = Math.max(...scores) - Math.min(...scores)
    if (spread <= 4) return 'Strong consistency across sections.'
    if (spread <= 8) return 'Good consistency with a little room to push one section higher.'
    return 'Wider score spread across the track. One more standout section could lift the whole run.'
  }, [sections])

  const leaderboardAllTime = [...leaderboard]
    .sort((a, b) => b.score - a.score || +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
    .slice(0, 6)

  const leaderboardHotStreak = [...leaderboardLast30]
    .sort((a, b) => b.score - a.score || +new Date(b.uploadedAt) - +new Date(a.uploadedAt))
    .slice(0, 6)

  return (
    <div
      className={`app-shell ${dragActive ? 'drag-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      
      <header className="hero compact-hero leaderboard-hero">
        <div className="hero-left-stack">
          <div className="hero-brand hero-brand-compact hero-brand-left">
            <p className="eyebrow">The Music Doctor Presents</p>
            <div className="brand-lockup">
              <h1>Mix Assistant</h1>
              <span className="version-pill">v0.46</span>
            </div>
          </div>

          <label className="upload-card upload-inline upload-inline-compact">
            <input type="file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac" onChange={onInputChange} hidden />
            <span className="upload-title">Click or drag to score your mix.</span>
            <span className="upload-subtitle">Stereo WAV works best, but MP3 and M4A work too. Uploads must be 1 to 10 minutes long. 48k / 24-bit WAV is perfect.</span>
          </label>
        </div>

        <div className="leaderboard-inline-grid leaderboard-inline-grid-top">
          <div className="leaderboard-inline-card">
            <div className="leaderboard-header compact">
              <p className="eyebrow">Top 6 Mixing Legends</p>
              <span className="leaderboard-hint">Best scores ever</span>
            </div>
            {leaderboardAllTime.length ? (
              <div className="leaderboard-inline-list">
                {leaderboardAllTime.map((entry, index) => (
                  <div className={`leaderboard-inline-row ${index === 0 ? 'is-top' : ''}`} key={entry.id}>
                    <span className="leaderboard-inline-main">
                      <strong>{entry.score}%</strong> {formatDuration(entry.durationSeconds)} - {entry.displayName}
                    </span>
                    <span className="leaderboard-inline-date">{formatLeaderboardDate(entry.uploadedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="leaderboard-empty compact">{leaderboardLoading ? 'Scanning the mix universe…' : 'Upload a mix and the board will start tracking your best runs.'}</div>
            )}
          </div>

          <div className="leaderboard-inline-card">
            <div className="leaderboard-header compact">
              <p className="eyebrow">Top 6 last 30 days</p>
              <span className="leaderboard-hint">Current hot streak</span>
            </div>
            {leaderboardHotStreak.length ? (
              <div className="leaderboard-inline-list">
                {leaderboardHotStreak.map((entry, index) => (
                  <div className={`leaderboard-inline-row recent-row ${index === 0 ? 'is-hot' : ''}`} key={`${entry.id}-30`}>
                    <span className="leaderboard-inline-main">
                      <strong>{entry.score}%</strong> {formatDuration(entry.durationSeconds)} - {entry.displayName}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="leaderboard-empty compact">{leaderboardLoading ? 'Scanning the mix universe…' : 'No scores in the last 30 days yet. First upload starts the streak.'}</div>
            )}
          </div>
        </div>
      </header>

      {dragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <h2>Click or drag to score your mix.</h2>
            <p>Stereo WAV works best, but MP3 and M4A work too. Uploads must be 1 to 10 minutes long. 48k / 24-bit WAV is perfect.</p>
          </div>
        </div>
      )}


      {error && <div className="notice error">{error}</div>}
      {isLoading && <div className="notice">Analysing upload, scoring sections, and syncing the global leaderboard…</div>}

      {sections.length > 0 && activeSection && (
        <>
          <section className="panel status-panel">
            <div>
              <p className="eyebrow">Overall Mix Score</p>
              <div className="score-line">
                <h2>{overallScore}% {scoreIcon(overallScore) && <span className="inline-score-icon">{scoreIcon(overallScore)}</span>}</h2>
                <div className="status-pill-row">
                  <span className={`status-pill tone-${scoreTone(overallScore)}`}>
                    {scoreLabel(overallScore)}
                  </span>
                  <div className="status-summary-inline">
                  {sectionSummary.map((item) => (
                    <div className="summary-chip" key={item.label}>
                      <strong>{item.count}</strong>
                      <span>{item.label}</span>
                    </div>
                  ))}
                  </div>
                </div>
              </div>
              <div className="score-bar">
                <div className={`score-bar-fill tone-${scoreTone(overallScore)}`} style={{ width: `${overallScore}%` }} />
              </div>
              <div className="consistency-note">{consistencyMessage}</div>
              {leaderboardMessage ? (
                <div className="leaderboard-message">
                  {leaderboardMessage.split(' • ').map((message) => {
                    const isHot = /Hot Streak/i.test(message)
                    const icon = isHot ? '🔥' : '🏆'
                    return (
                      <div className={`achievement-chip ${isHot ? 'hot' : 'alltime'}`} key={message}>
                        <span className="achievement-icon">{icon}</span>
                        <span>{message}</span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
            <div className="status-side">
              <div className="status-grid compact-grid">
                <button className="status-card success-card click-card top-moment-card" onClick={() => bestSection && selectSection(bestSection.id, true, 'seek')}>
                  <span className="label">Top moment</span>
                  <strong>{bestSection?.label}</strong>
                  <span className="card-note card-note-top"><span className="card-note-icon">{scoreIcon(bestSection?.score ?? 0) || '⭐'}</span>{bestSection?.score}% · What did I do right? Jump straight there.</span>
                </button>
                <button className="status-card muted-card click-card hot-streak-card" onClick={() => opportunitySection && selectSection(opportunitySection.id, true, 'seek')}>
                  <span className="label">Possible Lift</span>
                  <strong>{opportunitySection?.label}</strong>
                  <span className="card-note"><span className="card-note-icon">{scoreIcon(opportunitySection?.score ?? 0) || '↗'}</span>{opportunitySection?.score}% · Worth exploring when you want the next gain.</span>
                </button>
              </div>
            </div>
          </section>

          <WaveformPanel
            ref={waveformApiRef}
            fileUrl={fileUrl}
            fileName={fileName}
            sections={sections}
            activeSectionId={activeSectionId}
            onSelectSection={setActiveSectionId}
            onTimeChange={setCurrentTime}
            onPlayStateChange={setTrackPlaying}
          />

          <section className="content-grid" ref={analysisRef}>
            <article className="panel analysis-panel">
              <div className="panel-header spaced selected-header">
                <div className="selected-nav-group">
                  <button className="nav-button" disabled={activeSectionIndex <= 0} onClick={() => goToSection(activeSectionIndex - 1, trackPlaying ? 'play' : 'seek')}>
                    ← Previous
                  </button>
                  <div className={`selected-score-badge tone-${scoreTone(activeSection.score)}`}>
                    <span>{activeSection.score}%</span>
                    {scoreIcon(activeSection.score) ? <span className="score-badge-icon">{scoreIcon(activeSection.score)}</span> : null}
                  </div>
                </div>
                <div className="selected-center">
                  <p className="eyebrow">Selected section</p>
                  <h2>{activeSection.label}</h2>
                </div>
                <div className="selected-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      if (trackPlaying) waveformApiRef.current?.pause()
                      else waveformApiRef.current?.playSection(activeSection)
                    }}
                    disabled={!fileUrl || !activeSection}
                  >
                    {trackPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button className="nav-button" disabled={activeSectionIndex >= sections.length - 1} onClick={() => goToSection(activeSectionIndex + 1, trackPlaying ? 'play' : 'seek')}>
                    Next →
                  </button>
                </div>
              </div>

              <div className="metric-grid">
                {METRIC_ORDER.map((name) => {
                  const value = activeSection.metrics[name]
                  return (
                    <button
                      key={name}
                      className={`metric-card clickable ${activeMetric === name ? 'active' : ''} ${scoreTone(value)}`}
                      onClick={() => setActiveMetric(name)}
                    >
                      <span>{metricLabel(name)}</span>
                      <strong>{value}% {scoreIcon(value)}</strong>
                      <div className="mini-bar"><div className={`mini-bar-fill tone-${scoreTone(value)}`} style={{ width: `${value}%` }} /></div>
                    </button>
                  )
                })}
              </div>

              {activeMetricInsight && (
                <div className="metric-explainer">
                  <h3>{activeMetricInsight.title}</h3>
                  {activeMetric === 'tonalBalance' && activeTonalBands.length > 0 && (
                    <div className="tonal-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>Tonal balance strip</strong>
                        <div className="tonal-band-list">
                          {activeTonalBands.map((band) => {
                            const position = Math.max(6, Math.min(94, 50 + band.deviationPercent * 2.2))
                            const readout = band.status === 'good' ? 'Good' : `${Math.abs(band.deviationPercent)}% ${band.status}`
                            return (
                              <button
                                className={`tonal-band-row tonal-${band.severity}`}
                                key={band.key}
                                title={band.action}
                              >
                                <span className="tonal-band-name">{band.label}<small>{band.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">First move</span>
                        <strong>{tonalActionBand?.action}</strong>
                        <p>{tonalActionBand?.status === 'good' ? 'No big tonal fire to put out here. Compare against your reference before tweaking.' : `Start with ${tonalActionBand?.label.toLowerCase()} only, then re-upload and check the score before changing another band.`}</p>
                      </div>
                    </div>
                  )}
                  {activeMetric === 'clarity' && activeClarityBands.length > 0 && (
                    <div className="tonal-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>Clarity clash strip</strong>
                        <div className="tonal-band-list">
                          {activeClarityBands.map((band) => {
                            const position = Math.max(6, Math.min(94, 20 + band.deviationPercent * 2.6))
                            const readout = band.status === 'good' ? 'Good' : `${Math.abs(band.deviationPercent)}% clash`
                            return (
                              <button
                                className={`tonal-band-row tonal-${band.severity}`}
                                key={band.key}
                                title={band.action}
                              >
                                <span className="tonal-band-name">{band.label}<small>{band.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">First move</span>
                        <strong>{clarityActionBand?.action}</strong>
                        <p>{clarityActionBand?.status === 'good' ? 'No obvious clarity clash here. Protect this balance while fixing bigger scorecards.' : `Start with ${clarityActionBand?.label.toLowerCase()} only, then re-upload before cutting another band.`}</p>
                      </div>
                    </div>
                  )}
                  {activeLevelBalance && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>{activeLevelBalance.label} level strip</strong>
                        <div className="tonal-band-list">
                          {(() => {
                            const position = Math.max(6, Math.min(94, 50 + activeLevelBalance.deviationPercent * 2.2))
                            const readout = activeLevelBalance.status === 'good' ? 'Good' : `${Math.abs(activeLevelBalance.deviationPercent)}% ${activeLevelBalance.status}`
                            return (
                              <div className={`tonal-band-row tonal-${activeLevelBalance.severity}`}>
                                <span className="tonal-band-name">{activeLevelBalance.label}<small>{activeLevelBalance.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </div>
                            )
                          })()}
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">First move</span>
                        <strong>{activeLevelBalance.action}</strong>
                        <p>{activeLevelBalance.status === 'good' ? 'No obvious fader fire here. Keep this level steady while you fix the bigger scorecards.' : 'Make this simple fader move first, re-upload, and only then chase compression or EQ.'}</p>
                      </div>
                    </div>
                  )}
                  {activeMetric === 'drumsVsEverything' && activeSection.levelBalance && (
                    <div className="drum-substrip-card">
                      <span className="mini-label">Drum detail</span>
                      {[activeSection.levelBalance.kick, activeSection.levelBalance.snare, activeSection.levelBalance.cymbals].map((item) => {
                        const position = Math.max(6, Math.min(94, 50 + item.deviationPercent * 2.2))
                        const readout = item.status === 'good' ? 'Good' : `${Math.abs(item.deviationPercent)}% ${item.status}`
                        return (
                          <div className={`tonal-band-row tonal-${item.severity}`} key={item.key}>
                            <span className="tonal-band-name">{item.label}<small>{item.range}</small></span>
                            <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                            <span className="tonal-readout">{readout}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {activeImpactBalance && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>Impact strip</strong>
                        <div className="tonal-band-list">
                          {(() => {
                            const position = Math.max(6, Math.min(94, 50 + activeImpactBalance.deviationPercent * 2.2))
                            const readout = activeImpactBalance.status === 'good' ? 'Good' : `${Math.abs(activeImpactBalance.deviationPercent)}% ${activeImpactBalance.status === 'low' ? 'flat' : 'overcooked'}`
                            return (
                              <div className={`tonal-band-row tonal-${activeImpactBalance.severity}`}>
                                <span className="tonal-band-name">{activeImpactBalance.label}<small>{activeImpactBalance.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </div>
                            )
                          })()}
                        </div>
                        <div className="ear-check-card">
                          <strong>Quick ear check</strong>
                          <ul>{activeImpactBalance.earCheck.map((item) => <li key={item}>{item}</li>)}</ul>
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">First move</span>
                        <strong>{activeImpactBalance.action}</strong>
                        <p>{activeImpactBalance.status === 'good' ? 'Keep the section punch intact while fixing other scorecards.' : 'Make one contrast or punch move, then re-upload before chasing more loudness.'}</p>
                      </div>
                    </div>
                  )}
                  {activeMetric === 'width' && activeWidthBalance.length > 0 && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>Middle / Side / Width amount strip</strong>
                        <div className="tonal-band-list">
                          {activeWidthBalance.map((item) => {
                            const position = Math.max(6, Math.min(94, 50 + item.deviationPercent * 2.2))
                            const readout = item.status === 'good' ? 'Good' : `${Math.abs(item.deviationPercent)}% ${item.status === 'low' ? 'low' : 'high'}`
                            return (
                              <div className={`tonal-band-row tonal-${item.severity}`} key={item.key} title={item.action}>
                                <span className="tonal-band-name">{item.label}<small>{item.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">First move</span>
                        <strong>{activeWidthBalance.find((item) => item.severity !== 'good')?.action ?? 'Width is sitting well. Protect the centre while keeping the edges alive.'}</strong>
                        <p>{activeWidthBalance.every((item) => item.severity === 'good') ? 'Middle, side, and overall width are all inside the good window. Check mono compatibility rather than pushing wider.' : 'Left means that part is low and usually needs more. Right means it is high and usually needs less.'}</p>
                      </div>
                    </div>
                  )}
                  {activeMetric === 'mood' && activeMoodStrips.length > 0 && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
                        <strong>Mood character strips</strong>
                        <div className="tonal-band-list">
                          {activeMoodStrips.map((item) => {
                            const position = Math.max(6, Math.min(94, 50 + item.deviationPercent * 2.2))
                            const endpointLabels: Record<string, string> = { darkBright: 'Bright', calmEnergetic: 'Energetic', sparseDense: 'Dense', warmCold: 'Warm' }
                            const readout = endpointLabels[item.key] ?? item.label
                            return (
                              <div className={`tonal-band-row tonal-${item.severity}`} key={item.key} title={item.action}>
                                <span className="tonal-band-name">{item.label}<small>{item.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout">{readout}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      <div className="tonal-action-card">
                        <span className="mini-label">Character read</span>
                        <strong>Use this as a feel mirror, not a fix list.</strong>
                        <p>If the song is meant to feel dark but the strip leans Bright or Energetic, check Air, cymbals, density, and transient movement first.</p>
                      </div>
                    </div>
                  )}
                  <div className="metric-detail-copy">
                    <p><strong>What it means:</strong> {activeMetricInsight.meaning}</p>
                    <p><strong>What affects it here:</strong> {activeMetricInsight.influencedBy}</p>
                    <p><strong>Current read:</strong> {activeMetricInsight.currentRead}</p>
                  </div>
                </div>
              )}

              <div className="recommendation-section">
                <div className="recommendation-heading-row">
                  <div className={`highlight-title ${displayedRecommendationMode === 'Top recommendations' ? 'accent-title' : 'explore-title'}`}>
                    {displayedRecommendationMode} - {metricLabel(activeMetric)}
                  </div>
                </div>
                <div className="list-stack recommendation-grid">
                  {displayedRecommendations.map((recommendation) => (
                    <div className="info-card" key={recommendation.title}>
                      <div className="recommendation-top">
                        <span className={`priority priority-${recommendation.priority.toLowerCase().replace(/\s+/g, '-')}`}>{recommendation.priority}</span>
                        <span className="lift">{recommendation.estimatedLift}</span>
                      </div>
                      <strong>{recommendation.title}</strong>
                      <p>{recommendation.detail}</p>
                      <p className="target-tag">Target: {recommendation.target}</p>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </section>
        </>
      )}
    </div>
  )
}
