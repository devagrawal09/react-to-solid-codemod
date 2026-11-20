import { useEffect, useState } from 'react'

export function Clock({ tickMs, label }: { tickMs: number; label: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])

  useEffect(() => {
    document.title = `${label}: ${now.toLocaleTimeString()}`
  }, [label, now])

  useEffect(() => {
    console.log('clock mounted')
  }, [])

  return <time dateTime={now.toISOString()}>{now.toLocaleTimeString()}</time>
}
