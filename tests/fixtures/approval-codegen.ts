import type { SpecAcceptanceCase, SpecContract } from '../../src/main/services/spec-contract'

export const sampleDsl = `domain Sales
version 1
entity Order {
  id: uuid
  total: decimal
  dualSigned: boolean
  trace: FR-001
}
state Pending {
  entity: Order
  initial: true
  trace: FR-001
}
state Approved {
  entity: Order
  trace: FR-001
}
event OrderApproved {
  entity: Order
  fields: id, total
  trace: AC-001
}
rule MinimumTotal: Order.total >= 100000 [trace: FR-001]
rule DualSignature: Order.dualSigned == true [trace: FR-001]
command Approve {
  entity: Order
  actor: Finance
  from: Pending
  to: Approved
  emit: OrderApproved
  requires: MinimumTotal, DualSignature
  example: {"total":"125000.00","dualSigned":true}
  trace: FR-001
}
`
const accepted = { state: 'Approved', event: 'OrderApproved' } as const
function approvalCase(id: string, total: string, expect: SpecAcceptanceCase['expect'], dualSigned = true): SpecAcceptanceCase {
  const mappingId = '00000000-0000-0000-0000-000000000001'
  return {
    id, entity: 'Order', command: 'Approve', actor: 'Finance', state: 'Pending',
    input: { id: mappingId, total, dualSigned },
    expect: 'state' in expect ? { ...expect, payload: { id: mappingId, total } } : expect,
  }
}

export function approvalContract(id = 'FR-001', above = '100000.01'): SpecContract {
  const command = { entity: 'Order', command: 'Approve' }
  return {
    version: 3,
    rules: [{
      id,
      condition: '财务审批，金额达到 100000 元且已双签',
      outcome: '通过审批并发布 OrderApproved。低于门槛或未双签时拒绝高额审批命令',
      checks: [
        { ...command, id: 'BR-001', kind: 'numeric', rule: 'MinimumTotal', field: 'total', operator: '>=', threshold: '100000' },
        { ...command, id: 'BR-002', kind: 'boolean', rule: 'DualSignature', field: 'dualSigned', operator: '==', value: true },
        { ...command, id: 'BR-003', kind: 'actor', actor: 'Finance' },
        { ...command, id: 'BR-004', kind: 'state', state: 'Pending' },
      ],
      cases: [
        approvalCase('AT-001', '99999.99', { reject: 'rule', rule: 'MinimumTotal' }),
        approvalCase('AT-002', '100000.00', accepted),
        approvalCase('AT-003', above, accepted),
        approvalCase('AT-004', '100000.00', { reject: 'rule', rule: 'DualSignature' }, false),
        { ...approvalCase('AT-005', '100000.00', { reject: 'actor' }), actor: 'Visitor' },
        { ...approvalCase('AT-006', '100000.00', { reject: 'state' }), state: 'Approved' },
      ],
    }],
  }
}

export function approvalCriticalRules(id = 'FR-001'): string {
  return `## 关键规则与例外
- BR-001 [${id}] [numeric] 金额达到 100000 元
- BR-002 [${id}] [boolean] 未双签的订单不允许审批
- BR-003 [${id}] [actor] 仅财务角色可以审批
- BR-004 [${id}] [state] 仅待审批状态的订单可以审批`
}
