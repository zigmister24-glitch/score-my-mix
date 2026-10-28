// RMS mid/side share over a short playback window. Power, not absolute sample
// magnitude, makes prominent sounds contribute much more than quiet layers.
export function energyWeightedWidth(buffer: AudioBuffer | null, time: number): number {
  if (!buffer || buffer.numberOfChannels < 2 || !Number.isFinite(time)) return 0
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1)
  const end = Math.min(buffer.length, Math.max(1, Math.floor(time * buffer.sampleRate)))
  const start = Math.max(0, end - Math.floor(buffer.sampleRate * .2))
  let midPower = 0, sidePower = 0
  for (let i = start; i < end; i++) {
    const mid = (left[i] + right[i]) * .5, side = (left[i] - right[i]) * .5
    midPower += mid * mid; sidePower += side * side
  }
  if ((midPower + sidePower) / Math.max(1, end - start) < 1e-10) return 0
  const mid = Math.sqrt(midPower), side = Math.sqrt(sidePower)
  return side / (mid + side)
}

// Display zoom only: retain the measured percentage while 50% fills the rail.
export function liveWidthDisplay(width: number) {
  const measured = Number.isFinite(width) ? Math.min(1, Math.max(0, width)) : 0
  const spread = Math.min(1, measured / .5)
  return {left:50 - spread * 50, right:50 + spread * 50, percent:measured * 100}
}
