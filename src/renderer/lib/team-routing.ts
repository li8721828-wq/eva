/**
 * Team orchestration has a real planning and coordination cost. Keep simple
 * questions and focused edits with the assigned agent unless the request
 * clearly benefits from independent specialists.
 */
export function shouldUseExpertTeam(input: string): boolean {
  const task = input.trim()
  if (!task) return false

  // Capability questions should remain with the assigned Agent.
  const capabilityQuestion = /\u4f60\u53ef\u4ee5.{0,12}(?:agent|\u667a\u80fd\u4f53)|(?:can|do)\s+you.{0,16}(?:team|agent)/i
  if (capabilityQuestion.test(task)) return false

  const explicitTeamRequest = /(?:启动|组织|安排|调用|使用|交给|让).{0,12}(?:团队|多\s*(?:agent|智能体)|multi[-\s]?agent)|(?:use|start|organize|delegate to).{0,16}(?:team|multi[-\s]?agent)/i
  if (explicitTeamRequest.test(task)) return true

  const broadScope = /(?:全项目|整个项目|跨模块|跨服务|多文件|端到端|全面(?:分析|重构|改造)|大规模|架构(?:设计|调整|重构)|迁移|重构)|(?:whole|entire)\s+(?:project|codebase)|cross[-\s]?(?:module|service)|multi[-\s]?file|end[-\s]?to[-\s]?end|large[-\s]?scale|architecture|migration|refactor/i
  if (broadScope.test(task)) return true

  const parallelWorkflow = /(?:调研|研究|分析|设计).{0,30}(?:并且|并|同时).{0,30}(?:实现|修改|开发|测试|验证|审查)|(?:实现|修改|开发).{0,30}(?:并且|并|同时).{0,30}(?:测试|验证|审查|调研)/
  return parallelWorkflow.test(task)
}
