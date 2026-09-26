import type { MTripTabPanelProps } from '../MTripShell'
import { TabScroller } from './tabChrome'
import MTransportsTab from './MTransportsTab'
import MBookingsTab from './MBookingsTab'
import MCostsTab from './MCostsTab'
import MListsTab from './MListsTab'

/**
 * Routes the active non-plan trip tab to its panel. `tab` is the legacy id the
 * desktop planner uses (transports · buchungen · finanzplan · listen);
 * addon gating already happened in the shell, so only enabled tabs
 * ever reach here.
 */
export default function MTripTabPanel({ planner, shell, tab }: MTripTabPanelProps) {
  switch (tab) {
    case 'transports':
      return <MTransportsTab planner={planner} shell={shell} />
    case 'buchungen':
      return <MBookingsTab planner={planner} shell={shell} />
    case 'finanzplan':
      return <MCostsTab planner={planner} shell={shell} />
    case 'listen':
      return <MListsTab planner={planner} shell={shell} />
    default:
      return <TabScroller>{null}</TabScroller>
  }
}
