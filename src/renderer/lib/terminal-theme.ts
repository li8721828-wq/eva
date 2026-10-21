import type { ITheme } from '@xterm/xterm'
import type { Theme } from '@/stores/use-app-store'

const light: ITheme = {
  background: '#f8f9fc',
  foreground: '#243348',
  cursor: '#6259d8',
  cursorAccent: '#ffffff',
  selectionBackground: '#6259d82e',
  black: '#243348',
  red: '#a83f4b',
  green: '#20734f',
  yellow: '#8f5107',
  blue: '#3f6096',
  magenta: '#7354a7',
  cyan: '#256d83',
  white: '#334155',
  brightBlack: '#526176',
  brightRed: '#c95764',
  brightGreen: '#32865d',
  brightYellow: '#ad690f',
  brightBlue: '#5274a8',
  brightMagenta: '#8969bd',
  brightCyan: '#13738d',
  brightWhite: '#1f2937',
}
export function terminalTheme(theme: Theme): ITheme {
  if (theme === 'light') return light
  return {
    background: theme === 'starlight' ? '#122031' : '#191e29',
    foreground: '#eef2f7',
    cursor: theme === 'starlight' ? '#70b8d3' : '#8999ff',
    cursorAccent: '#191e29',
    selectionBackground: '#a99eff40',
    black: '#a1a9b8',
    red: '#f28b96',
    green: '#85d6aa',
    yellow: '#ebc57c',
    blue: '#9bbdf2',
    magenta: '#c9a6ef',
    cyan: '#83cbdc',
    white: '#e0e5ee',
    brightBlack: '#aeb9cb',
    brightRed: '#ffa4ae',
    brightGreen: '#a1ecc0',
    brightYellow: '#ffdc93',
    brightBlue: '#b3cfff',
    brightMagenta: '#dec0ff',
    brightCyan: '#9fe5f4',
    brightWhite: '#ffffff',
  }
}
