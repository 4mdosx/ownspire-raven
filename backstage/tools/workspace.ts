import { list as listClipboard } from '@/backstage/services/clipboard.service'
import { getDashboard } from '@/backstage/services/dashboard.service'
import { stats } from '@/backstage/services/file.service'
import { defineTool, optionalNumber, optionalString } from './registry'

/**
 * 工作区与系统状态类工具。全部只读，不涉及沙箱路径判定。
 */

defineTool({
  name: 'raven.clipboard.list',
  title: '读取剪切板',
  description: '读取 raven 的网络剪切板记录，按时间倒序。适合找「我之前复制过的东西」。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '最多返回几条，默认 20' },
      query: { type: 'string', description: '按文本搜索' },
    },
  },
  risk: 'read',
  execute: async (args) =>
    listClipboard({
      limit: optionalNumber(args, 'limit') ?? 20,
      offset: 0,
      ...(optionalString(args, 'query') !== undefined ? { query: optionalString(args, 'query')! } : {}),
    }),
})

defineTool({
  name: 'raven.storage.stats',
  title: '查询用量',
  description: '返回受管根目录的当前用量与配额上限。用来回答「还能放多少东西」。',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  execute: async () => stats(),
})

defineTool({
  name: 'raven.services.dashboard',
  title: '服务状态',
  description: '返回 ownspire 各服务（atlas / navi / raven 等）的健康状态与最近样本。',
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  execute: async () => getDashboard({ force: false }),
})
