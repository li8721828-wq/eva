/** One visual clock, shared by the renderer and its terminal settle window. */
export const CHAT_TEXT_FADE_MS = 500
// Bound live animation nodes for unusually large replies; Markdown still renders.
export const CHAT_TEXT_ANIMATION_MAX_CHARS = 20_000
export const CHAT_TEXT_ANIMATION = {
  animation: 'fadeIn',
  duration: CHAT_TEXT_FADE_MS,
  easing: 'ease-out',
  sep: 'char',
  stagger: 0,
} as const
