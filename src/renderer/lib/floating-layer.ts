import { createContext } from 'react'

export const FloatingDepth = createContext(0)
interface Layer {
  depth: number
  element: HTMLElement
  trigger?: HTMLElement | null
  modal?: boolean
  dismissOnOutside?: boolean
  dismiss: () => void
}
const layers: Layer[] = []
export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[tabindex]')
  ).filter((el) => el.tabIndex >= 0 && !el.matches(':disabled,[inert]') && el.getClientRects().length > 0)
}
function topLayer() {
  return layers.reduce<Layer | undefined>(
    (top, layer) => (!top || layer.depth >= top.depth ? layer : top),
    undefined
  )
}
function onKeyDown(event: KeyboardEvent) {
  const top = topLayer()
  if (!top) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    top.dismiss()
  } else if (event.key === 'Tab' && top.modal) {
    const items = focusableElements(top.element)
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (!items.length || (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1)) {
      event.preventDefault()
      ;(event.shiftKey ? items.at(-1) : items[0])?.focus()
      if (!items.length) top.element.focus()
    }
  }
}
function onPointerDown(event: PointerEvent) {
  if ((event.target as Element).closest('[data-floating-notification]')) return
  const top = topLayer()
  if (!top || top.dismissOnOutside === false || top.element.contains(event.target as Node) || top.trigger?.contains(event.target as Node))
    return
  // One gesture dismisses one layer, including clicks on a parent dialog's backdrop.
  event.preventDefault()
  event.stopImmediatePropagation()
  top.dismiss()
}
function onFocusIn(event: FocusEvent) {
  if ((event.target as Element).closest('[data-floating-notification]')) return
  const modal = layers
    .filter((layer) => layer.modal)
    .reduce<Layer | undefined>((top, layer) => (!top || layer.depth >= top.depth ? layer : top), undefined)
  if (
    !modal ||
    layers.some(
      (layer, index) =>
        (layer === modal ||
          layer.depth > modal.depth ||
          (layer.depth === modal.depth && index > layers.indexOf(modal))) &&
        layer.element.contains(event.target as Node)
    )
  )
    return
  ;(focusableElements(modal.element)[0] ?? modal.element).focus()
}
export function registerFloatingLayer(layer: Layer): () => void {
  if (!layers.length) {
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn)
  }
  layers.push(layer)
  return () => {
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
    if (!layers.length) {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }
}
