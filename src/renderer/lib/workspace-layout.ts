export const MAIN_MIN_WIDTH = 480
export function workspaceLayout(
  viewport: number,
  collapsed: boolean,
  sidebar: number,
  rail: number,
  terminal: boolean
) {
  const sidebarWidth = collapsed ? 48 : Math.max(240, Math.min(440, sidebar, viewport - MAIN_MIN_WIDTH - 4))
  const available = Math.max(0, viewport - sidebarWidth - 8 - MAIN_MIN_WIDTH)
  const minimum = terminal ? 380 : 300
  const overlay = available < minimum
  return {
    sidebarWidth,
    overlay,
    railWidth: Math.max(
      0,
      Math.min(rail, terminal ? 960 : 640, overlay ? viewport - sidebarWidth - 24 : available)
    ),
  }
}
