import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.tsx'
import VideoProcessor from './videoProcessor.tsx'
import { NotificationProvider } from './warnings/Notification.tsx'
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <NotificationProvider>
      {/* <App /> */}
      <VideoProcessor/>
    </NotificationProvider>
  </StrictMode>,
)
