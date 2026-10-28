import { useEffect, useRef, useState } from 'react'
import { energyWeightedWidth } from '../lib/liveWidth'

export default function LiveWidthMeter({buffer, time, playing, getTime}: {
  buffer: AudioBuffer | null; time: number; playing: boolean; getTime: () => number
}) {
  const [width, setWidth] = useState(0)
  const value = useRef(0)
  const clock = useRef(getTime)
  clock.current = getTime
  useEffect(() => {
    if (playing) return
    // Holds the reading at pause; seeking while paused updates to that position.
    value.current = energyWeightedWidth(buffer, time)
    setWidth(value.current)
  }, [buffer, time, playing])
  useEffect(() => {
    if (!playing || !buffer) return
    let frame = 0, last = 0
    const update = (now: number) => {
      if (now - last >= 40) {
        const elapsed = last ? Math.min(.2, (now - last) / 1000) : .04
        last = now
        const target = energyWeightedWidth(buffer, clock.current())
        value.current += (target - value.current) * (1 - Math.exp(-elapsed / .12))
        setWidth(value.current)
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [buffer, playing])
  const left = 50 - width * 50, right = 50 + width * 50
  return <div className="live-width-meter" role="meter" aria-label="Energy-weighted stereo width"
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width * 100)}>
    <span className="live-width-rail" />
    <span className="live-width-fill" style={{left:`${left}%`,width:`${right-left}%`}} />
    <span className="live-width-centre" />
    <span className="live-width-dot" style={{left:`${left}%`}} />
    <span className="live-width-dot" style={{left:`${right}%`}} />
  </div>
}
