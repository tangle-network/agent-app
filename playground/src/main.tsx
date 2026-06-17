import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Token values for the shared design system — pairs with the Tailwind preset
// wired in tailwind.config.js. This is the real consumer setup.
import '@tangle-network/agent-app/styles'
import './index.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
