import { createRoot } from 'react-dom/client'
import '@fontsource-variable/nunito'
import '@fontsource-variable/manrope'
import '@fontsource-variable/space-grotesk'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import './styles.css'
import { App } from './ui/App'

createRoot(document.getElementById('root')!).render(<App />)
