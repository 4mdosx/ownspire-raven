import { listDirectory, readTextFile } from '@/backstage/services/file.service'
import { defineTool, optionalString, requireString } from './registry'

/**
 * 文件工具。**这里一行路径判定都没有** —— 全部交给 `file.service`，
 * 它内部过 `backstage/lib/sandbox.ts`。
 *
 * 在工具层复制一份路径检查意味着两套会漂移的判定，而漂移的那一次就是越界。
 * 传绝对路径或 `../` 会被沙箱挡掉，我们只负责把它的错误原样传回去 ——
 * `outside_root` 比这里自己编一句「失败了对吧」有用得多。
 */

defineTool({
  name: 'raven.files.list',
  title: '浏览工作目录',
  description:
    '列出 raven 受管工作目录下的文件与文件夹，按修改时间倒序。用来了解「有哪些文件」—— 不要用它猜路径是否存在，先 list 再 read。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径。留空表示根目录' },
      search: { type: 'string', description: '按文件名或内容搜索' },
    },
  },
  risk: 'read',
  execute: async (args) =>
    listDirectory({
      ...(optionalString(args, 'path') !== undefined ? { path: optionalString(args, 'path')! } : {}),
      ...(optionalString(args, 'search') !== undefined ? { search: optionalString(args, 'search')! } : {}),
      sort: 'mtime',
      order: 'desc',
    }),
})

defineTool({
  name: 'raven.files.read',
  title: '读取文本文件',
  description:
    '读取 raven 工作目录下某个文本文件的全部内容。超过 1 MiB 会被拒绝—— 那种情况改用列表看元信息，不要反复重试。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径' },
    },
    required: ['path'],
  },
  risk: 'read',
  execute: async (args) => {
    const result = await readTextFile({ path: requireString(args, 'path') })
    return { path: result.path, text: result.text, truncated: result.truncated, size: result.size }
  },
})
