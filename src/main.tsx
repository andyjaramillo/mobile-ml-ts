import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from "./App.tsx"
import { NotificationProvider } from './warnings/Notification.tsx'
import VideoFrameProcessor from './OLDVideoFrameProcessor.tsx'
import React from 'react'
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <NotificationProvider>
      <App />
    </NotificationProvider>
  </StrictMode>,
)
