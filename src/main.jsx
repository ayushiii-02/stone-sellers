import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Mount to #root for normal dev
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Expose global function for external HTML use
window.initDestroyClock = (container) => {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}