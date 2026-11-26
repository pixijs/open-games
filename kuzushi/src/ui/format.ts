/** `MM:SS.cc`, the run timer's face. */
export const formatTime = (seconds: number): string => {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  const whole = Math.floor(rest)
  const hundredths = Math.min(99, Math.floor((rest - whole) * 100))
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`
}

/** Two digits, as the boards number things: 01, 02 ... */
export const twoDigits = (value: number): string => String(Math.max(0, Math.round(value))).padStart(2, "0")
