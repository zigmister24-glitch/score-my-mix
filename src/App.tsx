import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react'
import WaveformPanel, { WaveformHandle } from './components/WaveformPanel'
import { AnalysisGenreProfile, buildSections, decodeAudioFile, formatTime } from './lib/audioAnalysis'
import { SectionAnalysis } from './lib/types'

declare global {
  interface Window {
    webkitOfflineAudioContext?: typeof OfflineAudioContext
  }
}

const IS_LOCAL_DEV = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

const ACCEPTED_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac']
const GENRE_PROFILES = {
  'Modern Pop': { tonal: { weight: 0, body: 0, core: 0, air: 0 }, tonalWeights: { weight: 0.22, body: 0.22, core: 0.31, air: 0.25 }, vocals: 0 },
  'EDM / Dance': { tonal: { weight: 8, body: -2, core: -2, air: 4 }, tonalWeights: { weight: 0.34, body: 0.16, core: 0.20, air: 0.30 }, vocals: -1 },
  'Rock': { tonal: { weight: 2, body: 5, core: 4, air: -2 }, tonalWeights: { weight: 0.26, body: 0.31, core: 0.30, air: 0.13 }, vocals: 0 },
  'Metal / Nu Metal': { tonal: { weight: 5, body: 3, core: 5, air: 1 }, tonalWeights: { weight: 0.30, body: 0.24, core: 0.32, air: 0.14 }, vocals: 1 },
  'Hip Hop / Rap': { tonal: { weight: 10, body: 2, core: -3, air: 2 }, tonalWeights: { weight: 0.42, body: 0.20, core: 0.23, air: 0.15 }, vocals: 1 },
  'Singer Songwriter': { tonal: { weight: -3, body: 2, core: 5, air: 2 }, tonalWeights: { weight: 0.16, body: 0.28, core: 0.40, air: 0.16 }, vocals: 2 },
  'Cinematic / Trailer': { tonal: { weight: 8, body: 6, core: -2, air: 1 }, tonalWeights: { weight: 0.38, body: 0.34, core: 0.16, air: 0.12 }, vocals: 0 },
  'Scarlett Lullaby': { tonal: { weight: 16, body: 4, core: 2, air: 2 }, vocals: 2 },
} as const satisfies Record<string, AnalysisGenreProfile>

type GenreProfileName = keyof typeof GENRE_PROFILES

const METRIC_ORDER: Array<keyof SectionAnalysis['metrics']> = ['clarity', 'impact', 'tonalBalance', 'vocalLevel', 'width']

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

type TrackIdentityState = {
  normalizedTitle: string
  title: string
  artist: string
  displayName: string
  durationSeconds: number
}

type SavedSectionMapItem = {
  start: number
  end: number
  label?: string
}

type SavedSectionMap = {
  sections: SavedSectionMapItem[]
  source?: string
  genre?: GenreProfileName
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

function cleanTagValue(value: string) {
  return value
    .replace(/\0/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normaliseArtistJoin(value: string) {
  return cleanTagValue(value)
    .replace(/\s*\/\s*/g, ' & ')
    .replace(/\s*;\s*/g, ' & ')
}

function decodeSyncSafeInteger(bytes: Uint8Array) {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f)
}

function decodeFrameSize(bytes: Uint8Array, version: number) {
  if (version === 4) return decodeSyncSafeInteger(bytes)
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
}

function decodeId3TextFrame(bytes: Uint8Array) {
  if (!bytes.length) return ''
  const encoding = bytes[0]
  const payload = bytes.slice(1)

  try {
    if (encoding === 1 || encoding === 2) {
      const littleEndian = encoding === 1 && payload[0] === 0xff && payload[1] === 0xfe
      const start = encoding === 1 && (payload[0] === 0xff || payload[0] === 0xfe) ? 2 : 0
      const values: number[] = []
      for (let i = start; i + 1 < payload.length; i += 2) {
        const code = littleEndian ? payload[i] | (payload[i + 1] << 8) : (payload[i] << 8) | payload[i + 1]
        if (code === 0) break
        values.push(code)
      }
      return cleanTagValue(String.fromCharCode(...values))
    }

    const decoder = new TextDecoder(encoding === 3 ? 'utf-8' : 'iso-8859-1')
    return cleanTagValue(decoder.decode(payload))
  } catch {
    return ''
  }
}

async function readMp3Metadata(file: File): Promise<{ title?: string; artist?: string }> {
  if (!/\.mp3$/i.test(file.name) && !/audio\/(mpeg|mp3)/i.test(file.type)) return {}

  const headerBuffer = await file.slice(0, 10).arrayBuffer()
  const header = new Uint8Array(headerBuffer)
  if (header.length < 10 || header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return {}

  const version = header[3]
  const tagSize = decodeSyncSafeInteger(header.slice(6, 10))
  if (!tagSize || tagSize < 10) return {}

  const maxRead = Math.min(file.size, 10 + tagSize, 1024 * 1024)
  const tag = new Uint8Array(await file.slice(0, maxRead).arrayBuffer())
  const result: { title?: string; artist?: string } = {}
  let offset = 10

  if (version === 2) {
    while (offset + 6 <= tag.length) {
      const frameId = String.fromCharCode(tag[offset], tag[offset + 1], tag[offset + 2])
      if (!/^[A-Z0-9]{3}$/.test(frameId)) break

      const frameSize = (tag[offset + 3] << 16) | (tag[offset + 4] << 8) | tag[offset + 5]
      if (!frameSize || offset + 6 + frameSize > tag.length) break

      const frameData = tag.slice(offset + 6, offset + 6 + frameSize)
      if (frameId === 'TT2') result.title = decodeId3TextFrame(frameData)
      if (frameId === 'TP1' || (!result.artist && frameId === 'TP2')) result.artist = normaliseArtistJoin(decodeId3TextFrame(frameData))

      if (result.title && result.artist) break
      offset += 6 + frameSize
    }
  } else {
    while (offset + 10 <= tag.length) {
      const frameId = String.fromCharCode(tag[offset], tag[offset + 1], tag[offset + 2], tag[offset + 3])
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break

      const frameSize = decodeFrameSize(tag.slice(offset + 4, offset + 8), version)
      if (!frameSize || offset + 10 + frameSize > tag.length) break

      const frameData = tag.slice(offset + 10, offset + 10 + frameSize)
      if (frameId === 'TIT2') result.title = decodeId3TextFrame(frameData)
      if (['TPE1', 'TPE2', 'TCOM'].includes(frameId) && !result.artist) {
        result.artist = normaliseArtistJoin(decodeId3TextFrame(frameData))
      }

      if (result.title && result.artist) break
      offset += 10 + frameSize
    }
  }

  return result
}

function buildTrackIdentity(title: string, artist: string, filename: string) {
  const cleanTitleValue = cleanTagValue(title)
  const cleanArtistValue = normaliseArtistJoin(artist)
  const fallback = stripExtension(filename).replace(/[_]+/g, ' ').trim()

  if (cleanTitleValue && cleanArtistValue) {
    return {
      artist: cleanArtistValue,
      title: cleanTitleValue,
      displayName: `${cleanTitleValue} - ${cleanArtistValue}`,
    }
  }

  if (cleanTitleValue) {
    return {
      artist: '',
      title: cleanTitleValue,
      displayName: cleanTitleValue,
    }
  }

  return {
    artist: '',
    title: fallback,
    displayName: fallback,
  }
}

function parseTrackIdentityFromFilename(filename: string) {
  const raw = stripExtension(filename)
    .replace(/[_]+/g, ' ')
    .replace(/\s*\([^)]*(official|video|audio|lyrics?|visuali[sz]er|remaster|hd|4k)[^)]*\)\s*/gi, ' ')
    .replace(/\s*\[[^\]]*(official|video|audio|lyrics?|visuali[sz]er|remaster|hd|4k)[^\]]*\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const dashMatch = raw.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean)
  if (dashMatch.length >= 2) {
    const first = dashMatch[0]
    const second = dashMatch.slice(1).join(' - ')

    // Most downloaders use Artist - Title, but some user exports use Title - Artist.
    // Prefer the side that looks more like multiple artists as the artist name.
    const firstLooksLikeArtist = /(&|,|feat\.?|ft\.?| x | and )/i.test(first)
    const secondLooksLikeArtist = /(&|,|feat\.?|ft\.?| x | and )/i.test(second)

    if (secondLooksLikeArtist && !firstLooksLikeArtist) return buildTrackIdentity(first, second, filename)
    return buildTrackIdentity(second, first, filename)
  }

  return buildTrackIdentity(raw, '', filename)
}

function impactReadout(item: ImpactStrip) {
  const amount = Math.abs(item.deviationPercent)
  if (item.key === 'curiosity') {
    if (item.status === 'low') return `${amount}% passive`
    if (item.status === 'high') return item.range
    return item.range || 'Building'
  }
  if (item.status === 'low') return `${amount}% flat`
  if (item.status === 'high') return amount >= 31 ? `${amount}% huge lift` : `${amount}% big lift`
  return `${amount}% lift`
}

function widthReadout(item: BalanceStripItem) {
  const value = item.deviationPercent
  if (item.key === 'middle') {
    if (value < -20) return 'Centre-light'
    if (value < -10) return 'Slightly centre-light'
    if (value > 20) return 'Dense centre'
    if (value > 10) return 'Strong centre'
    return 'Balanced'
  }
  if (item.key === 'side') {
    if (value < -20) return 'Narrow sides'
    if (value < -10) return 'Controlled width'
    if (value > 26) return 'Very wide'
    if (value > 10) return 'Wide'
    return 'Balanced'
  }
  if (item.key === 'movement') {
    if (value < -20) return 'Static'
    if (value < -10) return 'Subtle move'
    if (value > 26) return 'Big expansion'
    if (value > 10) return 'Opening up'
    return 'Breathing'
  }
  if (value < -20) return 'Focused'
  if (value < -10) return 'Tight'
  if (value > 26) return 'Cinematic'
  if (value > 10) return 'Spacious'
  return 'Open'
}

function sameSong(a: Pick<LeaderboardEntry, 'normalizedTitle' | 'durationSeconds'>, b: Pick<LeaderboardEntry, 'normalizedTitle' | 'durationSeconds'>) {
  const durationClose =
    !a.durationSeconds ||
    !b.durationSeconds ||
    Math.abs(a.durationSeconds - b.durationSeconds) <= 2
  return a.normalizedTitle === b.normalizedTitle && durationClose
}

async function inferTrackIdentity(file: File) {
  const metadata = await readMp3Metadata(file)
  const filenameIdentity = parseTrackIdentityFromFilename(file.name)

  const title = cleanTagValue(metadata.title || '') || filenameIdentity.title
  const artist = normaliseArtistJoin(metadata.artist || '') || filenameIdentity.artist
  return buildTrackIdentity(title, artist, file.name)
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


async function readSectionMap(track: TrackIdentityState, sectionGenre?: GenreProfileName): Promise<SavedSectionMap | null> {
  if (IS_LOCAL_DEV) return null

  try {
    const params = new URLSearchParams({
      normalized_title: track.normalizedTitle,
      duration_seconds: String(track.durationSeconds),
    })
    if (sectionGenre && track.durationSeconds >= 60) params.set('genre', sectionGenre)
    const res = await fetch(`/api/section-map?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error('Section map load failed')
    const data = await res.json()
    if (!data.ok || !data.found || !data.map?.sections?.length) return null
    return data.map
  } catch (error) {
    console.warn('Section map unavailable. Falling back to auto-detect:', error)
    return null
  }
}

async function saveSectionMap(track: TrackIdentityState, sections: SectionAnalysis[], sectionGenre?: GenreProfileName) {
  if (IS_LOCAL_DEV) return { ok: true, local: true }

  const payload = {
    normalized_title: track.normalizedTitle,
    title: track.title,
    artist: track.artist,
    display_name: track.displayName,
    duration_seconds: track.durationSeconds,
    genre: track.durationSeconds >= 60 ? sectionGenre : undefined,
    sections: sections.map((section, index) => {
      const isLastSection = index === sections.length - 1
      const savedEnd = isLastSection
        ? Math.max(section.end, Math.ceil(section.end) - 0.01)
        : section.end

      return {
        start: Number(section.start.toFixed(3)),
        end: Number(savedEnd.toFixed(3)),
        label: section.label,
      }
    }),
  }

  const res = await fetch('/api/section-map', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }))
  if (!res.ok || !data.ok) throw new Error(data.error || 'Section map save failed')
  return data
}

async function deleteSectionMap(track: TrackIdentityState, sectionGenre?: GenreProfileName) {
  if (IS_LOCAL_DEV) return { ok: true, local: true }

  const res = await fetch('/api/section-map', {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      normalized_title: track.normalizedTitle,
      duration_seconds: track.durationSeconds,
      genre: track.durationSeconds >= 60 ? sectionGenre : undefined,
    }),
  })
  const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }))
  if (!res.ok || !data.ok) throw new Error(data.error || 'Section map delete failed')
  return data
}

async function readSongGenre(track: TrackIdentityState): Promise<GenreProfileName | null> {
  if (IS_LOCAL_DEV || track.durationSeconds < 60) return null

  try {
    const params = new URLSearchParams({
      normalized_title: track.normalizedTitle,
      duration_seconds: String(track.durationSeconds),
    })

    const res = await fetch(`/api/song-genre?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    if (!res.ok) throw new Error('Song genre load failed')
    const data = await res.json()
    const genre = data?.genre

    return genre && genre in GENRE_PROFILES ? genre as GenreProfileName : null
  } catch (error) {
    console.warn('Song genre unavailable. Falling back to Modern Pop:', error)
    return null
  }
}

async function saveSongGenre(track: TrackIdentityState, genre: GenreProfileName) {
  if (IS_LOCAL_DEV || track.durationSeconds < 60) return { ok: true, local: true }

  const payload = {
    normalized_title: track.normalizedTitle,
    title: track.title,
    artist: track.artist,
    display_name: track.displayName,
    duration_seconds: track.durationSeconds,
    genre,
  }

  const res = await fetch('/api/song-genre', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }))
  if (!res.ok || !data.ok) {
    console.warn('Song genre endpoint failed:', data)
    return { ok: false, error: data.error || 'Song genre save failed' }
  }
  return data
}

function boundariesFromSectionMap(map: SavedSectionMap, durationSeconds: number) {
  const boundaries = [0]
  for (const section of map.sections) {
    if (Number.isFinite(section.start)) boundaries.push(section.start)
    if (Number.isFinite(section.end)) boundaries.push(section.end)
  }
  boundaries.push(durationSeconds)

  // v0.93: Saved maps can contain a final end such as 03:09.99 so the UI feels
  // natural, but the audio duration may round to the next second on reload.
  // Snap any boundary very close to the end back to the real duration so we do
  // not create a tiny ghost section at the end of the song.
  const snapped = boundaries.map((value) => {
    const numericValue = Math.max(0, Math.min(durationSeconds, Number(value)))
    return durationSeconds - numericValue <= 1.01 ? durationSeconds : numericValue
  })

  return [...new Set(snapped)]
    .sort((a, b) => a - b)
}

function boundariesFromSections(sections: SectionAnalysis[]) {
  if (!sections.length) return []
  return [sections[0].start, ...sections.map((section) => section.end)]
}

async function readLeaderboard(): Promise<{
  allTime: LeaderboardEntry[]
  hotStreak: LeaderboardEntry[]
}> {
  if (IS_LOCAL_DEV) return { allTime: [], hotStreak: [] }

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
  if (IS_LOCAL_DEV) return null

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
        artist: entry.artist,
        title: entry.title,
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
  if (name === 'clarity') return 'Density'
  if (name === 'tonalBalance') return 'Tonal Balance'
  if (name === 'drumsVsEverything') return 'Drums'
  if (name === 'vocalLevel') return 'Vocals'
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function formatLeaderboardDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}


function parseSectionTime(value: string) {
  const cleaned = value.trim()
  if (!cleaned) return null
  const parts = cleaned.split(':').map((part) => part.trim())
  if (parts.some((part) => part === '' || Number.isNaN(Number(part)))) return null
  if (parts.length === 1) return Number(parts[0])
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1])
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])
  return null
}



function interleaveChannels(left: Float32Array, right: Float32Array) {
  const length = left.length + right.length
  const result = new Float32Array(length)
  let outputIndex = 0

  for (let inputIndex = 0; inputIndex < left.length; inputIndex += 1) {
    result[outputIndex++] = left[inputIndex]
    result[outputIndex++] = right[inputIndex]
  }

  return result
}

function writeString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function floatTo16BitPcm(view: DataView, offset: number, input: Float32Array) {
  let writeOffset = offset

  for (let index = 0; index < input.length; index += 1, writeOffset += 2) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    view.setInt16(writeOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
}

function audioBufferToWav(buffer: AudioBuffer) {
  const numberOfChannels = Math.min(buffer.numberOfChannels, 2)
  const sampleRate = buffer.sampleRate
  const bitDepth = 16
  const bytesPerSample = bitDepth / 8
  const blockAlign = numberOfChannels * bytesPerSample

  let samples: Float32Array
  if (numberOfChannels === 2) {
    samples = interleaveChannels(buffer.getChannelData(0), buffer.getChannelData(1))
  } else {
    samples = buffer.getChannelData(0)
  }

  const wavBuffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(wavBuffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)
  floatTo16BitPcm(view, 44, samples)

  return wavBuffer
}

async function renderAirContour(audioBuffer: AudioBuffer, gainDb: number, frequency: number) {
  const OfflineAudio = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OfflineAudio) {
    throw new Error('OfflineAudioContext is not supported in this browser.')
  }

  const offlineContext = new OfflineAudio(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate,
  )

  const source = offlineContext.createBufferSource()
  source.buffer = audioBuffer

  const airShelf = offlineContext.createBiquadFilter()
  airShelf.type = 'highshelf'
  airShelf.frequency.value = frequency
  airShelf.gain.value = gainDb

  source.connect(airShelf)
  airShelf.connect(offlineContext.destination)
  source.start(0)

  return offlineContext.startRendering()
}

function safeDownloadName(fileName: string, gainDb: number, frequency: number) {
  const baseName = stripExtension(fileName || 'mix')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  const gainTag = gainDb >= 0 ? `plus-${gainDb.toFixed(1)}` : `minus-${Math.abs(gainDb).toFixed(1)}`
  const freqTag = `${Math.round(frequency / 1000)}k`

  return `${baseName || 'mix'}-air-${gainTag}db-${freqTag}.wav`
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
  const [selectedGenre, setSelectedGenre] = useState<GenreProfileName>('Modern Pop')
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)
  const analysisRef = useRef<HTMLElement | null>(null)
  const waveformApiRef = useRef<WaveformHandle | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const autoSectionsRef = useRef<SectionAnalysis[]>([])
  const [trackIdentity, setTrackIdentity] = useState<TrackIdentityState | null>(null)
  const [sectionMapStatus, setSectionMapStatus] = useState('Auto sections')
  const [sectionMapDirty, setSectionMapDirty] = useState(false)
  const [sectionStartInput, setSectionStartInput] = useState('')
  const [sectionEndInput, setSectionEndInput] = useState('')
  const [airRenderBusy, setAirRenderBusy] = useState(false)
  const [airGainDb, setAirGainDb] = useState(1)
  const [airFreq, setAirFreq] = useState(10000)
  const [hasAudioBuffer, setHasAudioBuffer] = useState(false)

  const activeSectionIndex = useMemo(
    () => sections.findIndex((section) => section.id === activeSectionId),
    [sections, activeSectionId],
  )

  const activeSection = useMemo(
    () => sections.find((section) => section.id === activeSectionId) ?? null,
    [sections, activeSectionId],
  )

  const markSectionTimingDirty = () => {
    setSectionMapDirty(true)
    setSectionMapStatus('Unsaved section timing')
  }

  const currentGenreProfile = (genre = selectedGenre) => GENRE_PROFILES[genre]

  useEffect(() => {
    if (!activeSection) {
      setSectionStartInput('')
      setSectionEndInput('')
      return
    }
    setSectionStartInput(formatTime(activeSection.start))
    setSectionEndInput(formatTime(activeSection.end))
  }, [activeSection?.id, activeSection?.start, activeSection?.end])

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
      audioBufferRef.current = buffer
      setHasAudioBuffer(true)
      const autoSections = buildSections(buffer, undefined, currentGenreProfile())
      autoSectionsRef.current = autoSections
      const identity = await inferTrackIdentity(file)
      const durationSeconds = Math.round(buffer.duration || 0)
      if (durationSeconds < 5 || durationSeconds > 900) {
        if (fileUrl) URL.revokeObjectURL(fileUrl)
        URL.revokeObjectURL(nextUrl)
        setFileUrl(null)
        setFileName('')
        setError('Uploads need to be between 5 seconds and 15 minutes long.')
        setIsLoading(false)
        return
      }
      const normalizedTitle = normalizeTitle(identity.displayName || identity.title || file.name)
      if (!normalizedTitle || normalizedTitle.length < 2) {
        setError('That filename is too short or unclear for the global leaderboard. Rename it and try again.')
        setIsLoading(false)
        return
      }

      const nextTrackIdentity: TrackIdentityState = {
        normalizedTitle,
        title: identity.title,
        artist: identity.artist,
        displayName: identity.displayName,
        durationSeconds,
      }
      setTrackIdentity(nextTrackIdentity)

      const savedGenre = await readSongGenre(nextTrackIdentity)
      const savedMap = await readSectionMap(nextTrackIdentity, savedGenre ?? undefined)
      const loadedGenre = savedGenre
        ?? (savedMap?.genre && savedMap.genre in GENRE_PROFILES ? savedMap.genre : 'Modern Pop')

      setSelectedGenre(loadedGenre)
      const nextSections = savedMap
        ? buildSections(buffer, boundariesFromSectionMap(savedMap, buffer.duration), currentGenreProfile(loadedGenre))
        : buildSections(buffer, undefined, currentGenreProfile(loadedGenre))
      autoSectionsRef.current = buildSections(buffer, undefined, currentGenreProfile(loadedGenre))
      setSectionMapStatus(savedMap ? `Saved ${loadedGenre} map loaded` : `Genre - ${loadedGenre} loaded`)
      setSectionMapDirty(false)

      const nextOverallScore = nextSections.length
        ? Math.round(nextSections.reduce((sum, section) => sum + section.score, 0) / nextSections.length)
        : 0

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

      if (durationSeconds >= 150) {
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
          setLeaderboardMessage('Local Mode: leaderboards and saved maps are disabled. Your mix still scored locally on this page.')
        }
      } else {
        const boards = await readLeaderboard()
        setLeaderboard(boards.allTime)
        setLeaderboardLast30(boards.hotStreak)
        setLeaderboardMessage('Short test clips under 2:30 score locally but are not saved to the leaderboards.')
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


  const handleRenderAir = async () => {
    const sourceBuffer = audioBufferRef.current
    if (!sourceBuffer || airRenderBusy) return

    try {
      setAirRenderBusy(true)
      console.log('Rendering Air Contour', {
        gainDb: airGainDb,
        frequency: airFreq,
        duration: sourceBuffer.duration,
        channels: sourceBuffer.numberOfChannels,
      })

      const rendered = await renderAirContour(sourceBuffer, airGainDb, airFreq)
      const wavBuffer = audioBufferToWav(rendered)
      const blob = new Blob([wavBuffer], { type: 'audio/wav' })
      const url = URL.createObjectURL(blob)

      const link = document.createElement('a')
      link.href = url
      link.download = safeDownloadName(fileName, airGainDb, airFreq)
      document.body.appendChild(link)
      link.click()
      link.remove()

      setTimeout(() => URL.revokeObjectURL(url), 1000)
      alert('Air contour WAV rendered successfully')
    } catch (err) {
      console.error(err)
      alert('Failed to render Air contour WAV. Check the browser console for details.')
    } finally {
      setAirRenderBusy(false)
    }
  }

    const overallScoreExact = sections.length
    ? sections.reduce((sum, section) => sum + section.score, 0) / sections.length
    : 0

  const overallScore = Math.round(overallScoreExact)

  const bestSection = sections.length ? [...sections].sort((a, b) => b.score - a.score)[0] : null
  const opportunitySection = sections.length ? [...sections].sort((a, b) => a.score - b.score)[0] : null
  const activeMetricInsight = activeSection ? activeSection.metricInsights[activeMetric] : null
  const activeSectionUsesCuriosity = activeSection?.impactStrip?.key === 'curiosity'

  const recommendationTargetsByMetric: Record<keyof SectionAnalysis['metrics'], string[]> = {
    clarity: ['Overall mix', 'Instruments', 'Mix bus'],
    impact: ['Drums', 'Drum balance', 'Mix bus', 'Overall mix'],
    tonalBalance: ['Tonal balance', 'Overall mix'],
    drumsVsEverything: ['Drums', 'Drum balance'],
    vocalLevel: ['Vocal', 'Vocal level'],
    width: ['Stereo field'],
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
      makeLocalStripItem('side', 'Side', 'Stereo edges', sideDeviation, sideDeviation < -10 ? 'Side energy is low. Add width with double-tracked guitars, stereo pads, or wider FX returns.' : sideDeviation > 10 ? 'Side energy is wide. That can be excellent when the vocal, kick, bass, and snare still feel anchored in the middle.' : 'Side energy is sitting well. Keep the width moves subtle.'),
      makeLocalStripItem('amount', 'Space', 'Overall spread', sideDeviation, sideDeviation < -10 ? 'Overall width is a little narrow. Move supporting guitars, pads, delays, or FX wider first.' : sideDeviation > 10 ? 'Overall spread is wide. Keep the stereo magic, but strengthen the centre if the section feels hollow.' : 'Overall width amount is sitting well. Protect the centre and keep the edges alive.'),
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


  const autoSaveSectionMap = (nextSections: SectionAnalysis[]) => {
    if (!trackIdentity || !nextSections.length) return
    setSectionMapStatus('Auto-saving section map...')
    saveSectionMap(trackIdentity, nextSections, selectedGenre)
      .then(() => {
        setSectionMapDirty(false)
        setSectionMapStatus('Section map auto-saved')
      })
      .catch((error) => {
        console.error(error)
        setSectionMapStatus('Auto-save failed - changes are still local')
      })
  }

  const rebuildSectionsFromBoundaries = (boundaries: number[], preferredSectionId?: string | null, dirty = true, autoSave = false) => {
    const buffer = audioBufferRef.current
    if (!buffer) return [] as SectionAnalysis[]
    const nextSections = buildSections(buffer, boundaries, currentGenreProfile())
    setSections(nextSections)
    setSectionMapDirty(dirty)
    setSectionMapStatus(dirty ? 'Manual section map edited - auto-saving...' : 'Saved section map loaded')

    const preferred = preferredSectionId ? nextSections.find((section) => section.id === preferredSectionId) : null
    setActiveSectionId(preferred?.id ?? nextSections[0]?.id ?? null)
    if (autoSave) autoSaveSectionMap(nextSections)
    return nextSections
  }

  const updateBoundary = (boundaryIndex: number, time: number) => {
    if (!audioBufferRef.current || boundaryIndex <= 0 || boundaryIndex >= sections.length) return
    const minGap = 3
    const boundaries = boundariesFromSections(sections)
    const previous = boundaries[boundaryIndex - 1] ?? 0
    const next = boundaries[boundaryIndex + 1] ?? audioBufferRef.current.duration
    boundaries[boundaryIndex] = Math.max(previous + minGap, Math.min(next - minGap, time))
    rebuildSectionsFromBoundaries(boundaries, activeSectionId, true, true)
  }

  const addSectionSplit = (sectionId: string) => {
    const section = sections.find((item) => item.id === sectionId)
    if (!section || section.end - section.start < 6) return
    const boundaries = boundariesFromSections(sections)
    const split = section.start + (section.end - section.start) / 2
    boundaries.push(split)
    rebuildSectionsFromBoundaries(boundaries, sectionId, true, true)
  }

  const deleteSection = (sectionId: string) => {
    if (sections.length <= 1) return
    const index = sections.findIndex((section) => section.id === sectionId)
    if (index < 0) return
    const boundaries = boundariesFromSections(sections)
    if (index === 0) boundaries.splice(1, 1)
    else boundaries.splice(index, 1)
    rebuildSectionsFromBoundaries(boundaries, sections[Math.max(0, index - 1)]?.id, true, true)
  }

  const applySelectedSectionTiming = () => {
    if (!audioBufferRef.current || !activeSection || activeSectionIndex < 0) return false
    const start = parseSectionTime(sectionStartInput)
    const end = parseSectionTime(sectionEndInput)
    if (start === null || end === null) {
      setSectionMapStatus('Enter times as mm:ss, for example 01:14')
      return false
    }

    const minGap = 3
    const boundaries = boundariesFromSections(sections)
    const duration = audioBufferRef.current.duration
    const previousLimit = activeSectionIndex === 0 ? 0 : (boundaries[activeSectionIndex - 1] ?? 0) + minGap
    const nextLimit = activeSectionIndex === sections.length - 1 ? duration : (boundaries[activeSectionIndex + 2] ?? duration) - minGap
    const safeStart = activeSectionIndex === 0 ? 0 : Math.max(previousLimit, Math.min(end - minGap, start))
    const safeEnd = activeSectionIndex === sections.length - 1 ? duration : Math.min(nextLimit, Math.max(safeStart + minGap, end))

    if (activeSectionIndex > 0) boundaries[activeSectionIndex] = safeStart
    if (activeSectionIndex < sections.length - 1) boundaries[activeSectionIndex + 1] = safeEnd

    rebuildSectionsFromBoundaries(boundaries, activeSection.id, true, false)
    return true
  }

  const nudgeSelectedSectionTiming = (edge: 'start' | 'end', amount: number) => {
    const current = parseSectionTime(edge === 'start' ? sectionStartInput : sectionEndInput)
    if (current === null) return
    const next = formatTime(Math.max(0, current + amount))
    if (edge === 'start') setSectionStartInput(next)
    else setSectionEndInput(next)
  }

  const saveCurrentSectionMap = async (sectionsToSave = sections) => {
    if (!trackIdentity || !sectionsToSave.length) return
    try {
      setSectionMapStatus('Saving section map...')
      await saveSectionMap(trackIdentity, sectionsToSave, selectedGenre)
      setSectionMapDirty(false)
      setSectionMapStatus('Saved section map')
    } catch (error) {
      console.error(error)
      setSectionMapStatus('Section map save failed - using local edits')
    }
  }

  const saveSelectedSectionTiming = async () => {
    const timingApplied = applySelectedSectionTiming()
    if (!timingApplied || !trackIdentity || !audioBufferRef.current || !activeSection || activeSectionIndex < 0) return

    const start = parseSectionTime(sectionStartInput)
    const end = parseSectionTime(sectionEndInput)
    if (start === null || end === null) return

    const minGap = 3
    const boundaries = boundariesFromSections(sections)
    const duration = audioBufferRef.current.duration
    const previousLimit = activeSectionIndex === 0 ? 0 : (boundaries[activeSectionIndex - 1] ?? 0) + minGap
    const nextLimit = activeSectionIndex === sections.length - 1 ? duration : (boundaries[activeSectionIndex + 2] ?? duration) - minGap
    const safeStart = activeSectionIndex === 0 ? 0 : Math.max(previousLimit, Math.min(end - minGap, start))
    const safeEnd = activeSectionIndex === sections.length - 1 ? duration : Math.min(nextLimit, Math.max(safeStart + minGap, end))

    if (activeSectionIndex > 0) boundaries[activeSectionIndex] = safeStart
    if (activeSectionIndex < sections.length - 1) boundaries[activeSectionIndex + 1] = safeEnd

    const nextSections = buildSections(audioBufferRef.current, boundaries, currentGenreProfile())
    await saveCurrentSectionMap(nextSections)
  }

  const resetSectionMap = async () => {
    const autoSections = autoSectionsRef.current
    if (!autoSections.length) return
    setSections(autoSections)
    setActiveSectionId(autoSections[0]?.id ?? null)
    setSectionMapDirty(false)
    setSectionMapStatus('Reset to auto-detected sections')
    if (trackIdentity) {
      try { await deleteSectionMap(trackIdentity, selectedGenre) } catch (error) { console.warn('Could not delete saved section map:', error) }
    }
  }


  const handleGenreChange = async (nextGenre: GenreProfileName) => {
    setSelectedGenre(nextGenre)
    if (!trackIdentity || !audioBufferRef.current) return

    setSectionMapStatus('Saving genre profile...')
    const genreSaveResult = await saveSongGenre(trackIdentity, nextGenre)

    setSectionMapStatus(genreSaveResult?.ok === false ? 'Genre profile loaded - DB save failed' : 'Loading genre profile...')
    const savedMap = await readSectionMap(trackIdentity, nextGenre)
    const boundaries = savedMap
      ? boundariesFromSectionMap(savedMap, audioBufferRef.current.duration)
      : sections.length
        ? boundariesFromSections(sections)
        : undefined

    const nextSections = buildSections(audioBufferRef.current, boundaries, currentGenreProfile(nextGenre))
    const nextAutoSections = buildSections(audioBufferRef.current, undefined, currentGenreProfile(nextGenre))
    autoSectionsRef.current = nextAutoSections

    setSections(nextSections)
    setActiveSectionId(nextSections[0]?.id ?? null)
    setSectionMapDirty(false)

    if (trackIdentity.durationSeconds >= 60) {
      try {
        await saveSectionMap(trackIdentity, nextSections, nextGenre)
        setSectionMapStatus(`Saved ${nextGenre} genre map`)
      } catch (error) {
        console.warn('Could not save genre map:', error)
        setSectionMapStatus(`${nextGenre} profile loaded - save failed`)
      }
    } else {
      setSectionMapStatus(`${nextGenre} profile loaded locally`)
    }
  }

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
              <span className="version-pill">v0.114</span>
            </div>
          </div>

          <label className="upload-card upload-inline upload-inline-compact">
            <input type="file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/aac" onChange={onInputChange} hidden />
            <span className="upload-title">Click or drag to score your mix.</span>
            <span className="upload-subtitle">Stereo WAV works best, but MP3 and M4A work too. Uploads must be 1 to 15 minutes long. 48k / 24-bit WAV is perfect.</span>
          </label>

          <div className="air-contour-lab">
            <div className="air-contour-copy">
              <span className="air-contour-title">Air Contour Lab</span>
              <span className="air-contour-subtitle">Render a test WAV with a high-shelf air move, then re-upload it to compare scores.</span>
            </div>

            <div className="air-contour-controls">
              <label className="air-contour-control">
                <span>Gain</span>
                <input
                  type="range"
                  min="-10"
                  max="10"
                  step="0.1"
                  value={airGainDb}
                  onChange={(event) => setAirGainDb(Number(event.target.value))}
                />
                <strong>{airGainDb.toFixed(1)} dB</strong>
              </label>

              <label className="air-contour-control">
                <span>Freq</span>
                <input
                  type="range"
                  min="6000"
                  max="14000"
                  step="100"
                  value={airFreq}
                  onChange={(event) => setAirFreq(Number(event.target.value))}
                />
                <strong>{Math.round(airFreq / 100) / 10} kHz</strong>
              </label>

              <button
                className="air-contour-button"
                type="button"
                onClick={handleRenderAir}
                disabled={!hasAudioBuffer || airRenderBusy}
              >
                {airRenderBusy ? 'Rendering…' : 'Render Air'}
              </button>
            </div>
          </div>
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
            <p>Stereo WAV works best, but MP3 and M4A work too. Uploads must be 1 to 15 minutes long. 48k / 24-bit WAV is perfect.</p>
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
                <h2 title={`${overallScoreExact.toFixed(2)}%`} aria-label={`Overall mix score ${overallScoreExact.toFixed(2)} percent`}>{overallScore}% {scoreIcon(overallScore) && <span className="inline-score-icon">{scoreIcon(overallScore)}</span>}</h2>
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
            editable={false}
            onResetMap={resetSectionMap}
            sectionMapStatus={`${sectionMapStatus}${sectionMapDirty ? ' *' : ''}`}
            selectedGenre={selectedGenre}
            genreOptions={Object.keys(GENRE_PROFILES) as GenreProfileName[]}
            onGenreChange={handleGenreChange}
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
                <div className="section-timing-editor inline-section-editor">
                  <div className="section-time-fields centered-time-fields">
                    <label>
                      <span>Start</span>
                      <input
                        value={sectionStartInput}
                        onChange={(event) => {
                          setSectionStartInput(event.target.value)
                          markSectionTimingDirty()
                        }}
                        onKeyDown={(event) => { if (event.key === 'Enter') saveSelectedSectionTiming() }}
                      />
                    </label>
                    <span className="section-time-arrow">→</span>
                    <label>
                      <span>End</span>
                      <input
                        value={sectionEndInput}
                        onChange={(event) => {
                          setSectionEndInput(event.target.value)
                          markSectionTimingDirty()
                        }}
                        onKeyDown={(event) => { if (event.key === 'Enter') saveSelectedSectionTiming() }}
                      />
                    </label>
                  </div>
                  <div className="section-editor-actions stacked-section-actions">
                    {sectionMapDirty ? <button className="nav-button" onClick={saveSelectedSectionTiming} disabled={!activeSection}>Save section</button> : null}
                    <button className="nav-button" onClick={() => activeSection && deleteSection(activeSection.id)} disabled={sections.length <= 1}>Delete section</button>
                    {activeSectionIndex > 0 ? <button className="nav-button" onClick={() => activeSection && addSectionSplit(activeSection.id)}>Insert section</button> : null}
                  </div>
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
                  const label = name === 'impact' && activeSectionUsesCuriosity ? 'Curiosity' : metricLabel(name)
                  return (
                    <button
                      key={name}
                      className={`metric-card clickable ${activeMetric === name ? 'active' : ''} ${scoreTone(value)}`}
                      onClick={() => setActiveMetric(name)}
                    >
                      <span>{label}</span>
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
                        <div className="tonal-band-list">
                          {activeTonalBands.map((band) => {
                            const position = Math.max(6, Math.min(94, 50 + band.deviationPercent * 2.2))
                            const displayValue = Math.abs(band.displayPercent ?? band.deviationPercent)
                            const readout = band.status === 'good' ? 'Good' : `${displayValue}% ${band.status}`
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
                    </div>
                  )}
                  {activeMetric === 'clarity' && activeClarityBands.length > 0 && (
                    <div className="tonal-balance-panel">
                      <div className="tonal-strip-card">
                        <div className="tonal-band-list">
                          {activeClarityBands.map((band) => {
                            const position = Math.max(6, Math.min(94, 50 + band.deviationPercent * 2.2))
                            const displayValue = Math.abs(band.displayPercent ?? band.deviationPercent)
                            const readout = band.status === 'good' ? 'Good' : `${displayValue}% over`
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
                      <div className="clarity-workflow-card">
                        <strong>Density check workflow</strong>
                        <p>Dense synths, pads, bass, and layered sounds can naturally create density. That can be normal, especially when the sound is wide, warm, or intentionally saturated.</p>
                        <p>If Density looks high, check Tonal Balance before cutting EQ. To isolate real masking, test one bus at a time: start with Synths/Pads, then add Guitars, then Drums, and add Vocals last.</p>
                      </div>
                    </div>
                  )}
                  {activeLevelBalance && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
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
                        <div className="tonal-band-list">
                          {(() => {
                            const position = Math.max(6, Math.min(94, 50 + activeImpactBalance.deviationPercent * 2.2))
                            const readout = impactReadout(activeImpactBalance)
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
                    </div>
                  )}
                  {activeMetric === 'width' && activeWidthBalance.length > 0 && (
                    <div className="level-balance-panel">
                      <div className="tonal-strip-card">
                        <div className="tonal-band-list">
                          {activeWidthBalance.map((item) => {
                            const position = Math.max(6, Math.min(94, 50 + item.deviationPercent * 2.2))
                            const readout = widthReadout(item)
                            const infoOnly = item.key !== 'movement'
                            return (
                              <div className={`tonal-band-row tonal-${item.severity} ${infoOnly ? 'profile-info-row' : 'profile-action-row'}`} key={item.key} title={item.action}>
                                <span className="tonal-band-name">{item.label}<small>{item.range}</small></span>
                                <span className="tonal-strip"><span className="tonal-center" /><span className="tonal-dot" style={{ left: `${position}%` }} /></span>
                                <span className="tonal-readout profile-readout">
                                  <span>{readout}</span>
                                  {infoOnly && <small className="info-only-note"><span className="info-icon">i</span> Information only</small>}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="metric-detail-copy">
                    <p><strong>What {activeMetric === 'clarity' ? 'Density' : (activeMetric === 'impact' && activeSectionUsesCuriosity ? 'Curiosity' : metricLabel(activeMetric))} means:</strong> {activeMetricInsight.meaning}</p>
                    <p><strong>What affects it here:</strong> {activeMetricInsight.influencedBy}</p>
                    <p><strong>Current read:</strong> {activeMetricInsight.currentRead}</p>
                  </div>
                </div>
              )}

            </article>
          </section>
        </>
      )}
    </div>
  )
}
