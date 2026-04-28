import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { SectionAnalysis } from '../lib/types'
import { formatTime } from '../lib/audioAnalysis'

interface WaveformPanelProps {
  fileUrl: string | null
  fileName: string
  sections: SectionAnalysis[]
  activeSectionId: string | null
  onSelectSection: (id: string) => void
  onTimeChange?: (time: number) => void
  onPlayStateChange?: (playing: boolean) => void
}

export interface WaveformHandle {
  seekToSection: (section: SectionAnalysis) => void
  playSection: (section: SectionAnalysis) => void
  toggleTrack: () => Promise<void>
  pause: () => void
}

const scoreIcon = (score: number) => {
  if (score >= 95) return '🤯'
  if (score >= 90) return '🏆'
  if (score >= 85) return '⭐'
  return ''
}

const chipTone = (score: number) => {
  if (score >= 95) return 'tone-legend'
  if (score >= 90) return 'tone-elite'
  if (score >= 85) return 'tone-target'
  if (score >= 80) return 'tone-strong'
  return 'tone-standard'
}

const WaveformPanel = forwardRef<WaveformHandle, WaveformPanelProps>(function WaveformPanel({
  fileUrl,
  fileName,
  sections,
  activeSectionId,
  onSelectSection,
  onTimeChange,
  onPlayStateChange,
}: WaveformPanelProps, ref) {
  const waveformRef = useRef<HTMLDivElement | null>(null)
  const waveSurferRef = useRef<WaveSurfer | null>(null)
  const sectionPlaybackRef = useRef<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    if (!waveformRef.current || !fileUrl) return

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#2b3654',
      progressColor: '#8b5cf6',
      cursorColor: '#ffffff',
      barWidth: 2,
      barGap: 1,
      barRadius: 6,
      height: 120,
      normalize: true,
    })

    waveSurferRef.current = ws
    void ws.load(fileUrl)

    ws.on('ready', () => {
      setDuration(ws.getDuration())
    })

    ws.on('timeupdate', (time) => {
      setCurrentTime(time)
      onTimeChange?.(time)
      if (sectionPlaybackRef.current) {
        const currentSection = sections.find((section) => section.id === sectionPlaybackRef.current)
        if (currentSection && time >= currentSection.end) {
          ws.pause()
          sectionPlaybackRef.current = null
        }
      }
    })

    ws.on('play', () => {
      setIsPlaying(true)
      onPlayStateChange?.(true)
    })
    ws.on('pause', () => {
      setIsPlaying(false)
      onPlayStateChange?.(false)
    })
    ws.on('finish', () => {
      setIsPlaying(false)
      onPlayStateChange?.(false)
      sectionPlaybackRef.current = null
    })

    return () => {
      ws.destroy()
      waveSurferRef.current = null
      setIsPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      sectionPlaybackRef.current = null
    }
  }, [fileUrl, onPlayStateChange, onTimeChange, sections])

  const togglePlayback = async () => {
    if (!waveSurferRef.current) return
    sectionPlaybackRef.current = null
    await waveSurferRef.current.playPause()
  }

  const movePlayheadToSection = (section: SectionAnalysis) => {
    if (!waveSurferRef.current || duration === 0) return
    const safeStart = Math.min(section.end, section.start + 0.01)
    setCurrentTime(safeStart)
    onTimeChange?.(safeStart)
    waveSurferRef.current.seekTo(safeStart / duration)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName.toLowerCase()
      const isTyping = target?.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select' || tagName === 'button'
      if (isTyping) return
      event.preventDefault()
      void togglePlayback()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [duration])

  useImperativeHandle(ref, () => ({
    seekToSection(section: SectionAnalysis) {
      if (!waveSurferRef.current || duration === 0) return
      sectionPlaybackRef.current = null
      onSelectSection(section.id)
      movePlayheadToSection(section)
    },
    playSection(section: SectionAnalysis) {
      if (!waveSurferRef.current || duration === 0) return
      onSelectSection(section.id)
      sectionPlaybackRef.current = section.id
      movePlayheadToSection(section)
      setTimeout(() => { void waveSurferRef.current?.play() }, 0)
    },
    toggleTrack: togglePlayback,
    pause() {
      waveSurferRef.current?.pause()
      sectionPlaybackRef.current = null
    },
  }), [duration, onSelectSection, onTimeChange])

  const jumpToSection = (section: SectionAnalysis) => {
    onSelectSection(section.id)
    if (!waveSurferRef.current || duration === 0) return
    sectionPlaybackRef.current = null
    movePlayheadToSection(section)
  }

  return (
    <section className="panel waveform-panel">
      <div className="panel-header spaced">
        <div>
          <p className="eyebrow">Track map</p>
          <h2>{fileName || 'Uploaded audio'}</h2>
        </div>
        <div className="audio-controls">
          <button className="primary-button" onClick={togglePlayback} disabled={!fileUrl}>
            {isPlaying ? 'Pause track' : 'Play track'}
          </button>
          <div className="time-readout">
            {formatTime(currentTime)} / {formatTime(duration)}
          </div>
        </div>
      </div>

      <div className="waveform-frame">
        <div ref={waveformRef} />
        <div className="section-overlay">
          {sections.map((section) => {
            const left = `${(section.start / Math.max(1, duration)) * 100}%`
            const width = `${((section.end - section.start) / Math.max(1, duration)) * 100}%`
            const isActive = section.id === activeSectionId
            return (
              <button
                key={section.id}
                className={`section-chip ${isActive ? 'active' : ''} level-${section.highlightLevel} ${chipTone(section.score)}`}
                style={{ left, width, borderColor: isActive ? section.color : undefined }}
                onClick={() => jumpToSection(section)}
              >
                <span className="chip-top" style={{ background: section.highlightLevel > 0 ? section.color : 'transparent' }} />
                <span className="chip-label">{section.label}</span>
                <span className="chip-score">{section.score}% {scoreIcon(section.score)}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
})

export default WaveformPanel
