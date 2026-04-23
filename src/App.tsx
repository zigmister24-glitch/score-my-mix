import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import WaveformPanel, { WaveformHandle } from './components/WaveformPanel'
import { buildSections, decodeAudioFile } from './lib/audioAnalysis'
import { SectionAnalysis } from './lib/types'

const ACCEPTED_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac']
const METRIC_ORDER: Array<keyof SectionAnalysis['metrics']> = ['clarity', 'impact', 'tonalBalance', 'width', 'mood']

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

    const data: LeaderboardResponse = await res.json()

    if (!res.ok || !data.ok) {
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

    const data: LeaderboardResponse = await res.json()

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Leaderboard submit failed')
    }

    return data
  } catch (error) {
    console.error('Failed to submit global leaderboard entry:', error)
    return null
  }
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
    if (score >= 80) return 'strong'
    return 'standard'
  }

  const scoreIcon = (score: number) => {
    if (score >= 95) return '🤯'
    if (score >= 90) return '🏆'
    if (score >= 80) return '⭐'
    return ''
  }

  const scoreLabel = (score: number) => {
    if (score >= 95) return 'HOLY F@CK!!!'
    if (score >= 90) return "Mean! That mix just grew a pair"
    if (score >= 86) return "Mean bro. That shit's unreal!"
    if (score >= 80) return 'Cuz! That mix kicks arse'
    if (score >= 75) return "Chur bro! That's choice as!"
    if (score >= 70) return "That's a sweet mix ow!"
    if (score >= 60) return "That's not bad for a stink fullar"
    return "C'mon bro... you can do better"
  }

  const selectedSectionScores = activeSection ? Object.values(activeSection.metrics) : []

  const allMetricScores = sections.flatMap((section) => Object.values(section.metrics))

  const sectionSummary = allMetricScores.length
    ? [
        { label: 'over 85%', count: allMetricScores.filter((score) => score >= 85).length },
        { label: 'over 90%', count: allMetricScores.filter((score) => score >= 90).length },
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
              <h1>Score My Mix</h1>
              <span className="version-pill">v0.26</span>
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
                    <span className={`leaderboard-inline-rank ${index === 0 ? 'champion' : ''}`}>{`${index + 1}.`}</span>
                    <span className="leaderboard-inline-main">
                      <strong>{entry.score}%</strong> {formatDuration(entry.durationSeconds)} - {entry.displayName}
                    </span>
                    <span className="leaderboard-inline-date">{formatLeaderboardDate(entry.uploadedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="leaderboard-empty compact">{leaderboardLoading ? 'Loading global leaderboard…' : 'Upload a mix and the board will start tracking your best runs.'}</div>
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
                    <span className={`leaderboard-inline-rank recent ${index === 0 ? 'hot' : ''}`}>{`${index + 1}.`}</span>
                    <span className="leaderboard-inline-main">
                      <strong>{entry.score}%</strong> {formatDuration(entry.durationSeconds)} - {entry.displayName}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="leaderboard-empty compact">{leaderboardLoading ? 'Loading global leaderboard…' : 'No scores in the last 30 days yet. First upload starts the streak.'}</div>
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
      {isLoading && <div className="notice">Analysing upload and building the section map…</div>}

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
                      <span>{name === 'tonalBalance' ? 'Tonal balance' : name}</span>
                      <strong>{value}% {scoreIcon(value)}</strong>
                      <div className="mini-bar"><div className="mini-bar-fill" style={{ width: `${value}%` }} /></div>
                    </button>
                  )
                })}
              </div>

              {activeMetricInsight && (
                <div className="metric-explainer">
                  <h3>{activeMetricInsight.title}</h3>
                  <p><strong>What it means:</strong> {activeMetricInsight.meaning}</p>
                  <p><strong>What affects it here:</strong> {activeMetricInsight.influencedBy}</p>
                  <p><strong>Current read:</strong> {activeMetricInsight.currentRead}</p>
                </div>
              )}

              <div className="analysis-columns tighter-columns">
                <section>
                  <div className="highlight-title">What’s working well</div>
                  <div className="list-stack">
                    {activeSection.strengths.map((strength) => (
                      <div className="info-card positive" key={strength.title}>
                        <strong>{strength.title}</strong>
                        <p>{strength.detail}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="highlight-title accent-title">Top recommendations</div>
                  <div className="list-stack">
                    {activeSection.recommendations.map((recommendation) => (
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
                </section>
              </div>
            </article>
          </section>
        </>
      )}
    </div>
  )
}
