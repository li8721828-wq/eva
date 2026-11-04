import type { AgentOutputFontSize } from '../../shared/types/agent'

/** Actual CSS pixels, shared by chat and its settings labels. The application
 * root stays at 14px so typography never rescales workspace geometry. */
export const READING_FONT_SIZES: Record<AgentOutputFontSize, number> = {
  xsmall: 13, small: 14, medium: 15, large: 16, xlarge: 17, '2xlarge': 18, '3xlarge': 20,
}
