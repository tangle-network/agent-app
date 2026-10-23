import { useEffect, useState } from 'react'

export function useDocumentDark(): boolean {
  const read = () => {
    if (typeof document === 'undefined') return false
    const root = document.documentElement
    return root.getAttribute('data-theme') === 'dark' || root.classList.contains('dark')
  }
  const [isDark, setIsDark] = useState(read)
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => setIsDark(read()))
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    setIsDark(read())
    return () => obs.disconnect()
  }, [])
  return isDark
}
