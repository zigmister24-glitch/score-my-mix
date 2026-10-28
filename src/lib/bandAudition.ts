export const AUDITION_BANDS = {
  weight: [20, 120], body: [120, 350], core: [350, 2000],
  presence: [2000, 5000], air: [5000, 12000],
} as const
export type AuditionBand = keyof typeof AUDITION_BANDS

// One graph per player. Crossfade instead of abruptly reconnecting playing audio.
export class BandAudition {
  readonly context: AudioContext
  private source: MediaElementAudioSourceNode
  private dry: GainNode
  private wet: GainNode
  private highpass: BiquadFilterNode
  private lowpass: BiquadFilterNode
  constructor(media: HTMLMediaElement) {
    this.context = new AudioContext()
    this.source = this.context.createMediaElementSource(media)
    this.dry = this.context.createGain()
    this.wet = this.context.createGain()
    this.highpass = this.context.createBiquadFilter()
    this.lowpass = this.context.createBiquadFilter()
    this.highpass.type = 'highpass'; this.lowpass.type = 'lowpass'
    this.highpass.Q.value = this.lowpass.Q.value = Math.SQRT1_2
    this.dry.gain.value = 1; this.wet.gain.value = 0
    this.source.connect(this.dry).connect(this.context.destination)
    this.source.connect(this.highpass).connect(this.lowpass).connect(this.wet).connect(this.context.destination)
  }
  setBand(band: AuditionBand | null) {
    const now = this.context.currentTime
    if (band) {
      const [low, high] = AUDITION_BANDS[band]
      this.highpass.frequency.setValueAtTime(Math.min(low, this.context.sampleRate * .45), now)
      this.lowpass.frequency.setValueAtTime(Math.min(high, this.context.sampleRate * .49), now)
    }
    for (const [param, target] of [[this.dry.gain, band ? 0 : 1], [this.wet.gain, band ? 1 : 0]] as const) {
      param.cancelScheduledValues(now)
      param.setValueAtTime(param.value, now)
      param.linearRampToValueAtTime(target, now + .02)
    }
  }
  dispose() {
    this.source.disconnect(); this.dry.disconnect(); this.wet.disconnect()
    this.highpass.disconnect(); this.lowpass.disconnect()
    void this.context.close()
  }
}
