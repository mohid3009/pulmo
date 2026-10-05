export const mmss = (sec: number) => {
  const t = Math.max(0, Math.round(sec))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false })
