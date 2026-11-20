import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { Clock } from './Clock.tsx'
import { Greeting, LegacyCounter } from './Legacy.tsx'
import { Repos } from './Repos.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Clock tickMs={1000} label="Now" />
      <Greeting name="corpus" />
      <LegacyCounter step={2} />
      <Repos owner="solidjs" tags={['solid', 'signals']} />
    </QueryClientProvider>
  </StrictMode>,
)
