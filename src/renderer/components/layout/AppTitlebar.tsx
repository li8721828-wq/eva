import { Minus, Square, X } from 'lucide-react'
import { APP_VERSION } from '../../../shared/constants'
import evaMark from '@/assets/eva-mark.svg'

export function AppTitlebar() {
  return (
    <header className="app-titlebar">
      <div className="app-titlebar__drag">
        <img src={evaMark} alt="" className="app-titlebar__mark" />
        <span className="app-titlebar__brand">Eva</span>
        <span className="app-titlebar__version">v{APP_VERSION}</span>
      </div>
      <div className="app-titlebar__controls" role="group" aria-label="Window controls">
        <button
          className="app-titlebar__control"
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void window.eva.windowControls.minimize()}
          aria-label="Minimize Eva"
          title="Minimize"
        >
          <Minus size={15} strokeWidth={1.7} />
        </button>
        <button
          className="app-titlebar__control"
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void window.eva.windowControls.toggleMaximize()}
          aria-label="Maximize or restore Eva"
          title="Maximize or restore"
        >
          <Square size={13} strokeWidth={1.7} />
        </button>
        <button
          className="app-titlebar__control app-titlebar__control--close"
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => void window.eva.windowControls.close()}
          aria-label="Close Eva"
          title="Close"
        >
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </header>
  )
}
