import {
  copy,
  createDirectory,
  listDirectory,
  move,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from '@/backstage/services/file.service'
import {
  booleanArg,
  defineTool,
  optionalBoolean,
  optionalString,
  requireString,
  requireStringArray,
  requireText,
} from './registry'

/**
 * 文件工具（FS Tools）。
 *
 * ## 这里一行路径判定都没有
 *
 * 全部交给 `file.service`，它内部过 `backstage/lib/sandbox.ts`。
 * 在工具层复制一份路径检查意味着两套会漂移的判定，**而漂移的那一次就是越界**。
 * 传绝对路径或 `..` 会被沙箱挡掉，我们只负责把它的错误原样传回去 ——
 * `outside_root` 比这里自己编一句「失败了对吧」有用得多。
 *
 * ## 为什么按「一个工具一件事」拆开
 *
 * 没有 `fs.manage(action=write|move|delete|...)` 这种大工具。原因是失败时
 * 你分不清是哪一半出的问题，而且 `risk` 没法自报—— 一个既读又删的工具，
 * 它的风险等级取决于参数，**而「取决于参数的风险」就是假的授权**。
 * 拆开之后 `raven.files.remove` 的 `risk` 就是白纸黑字的 `destructive`。
 */

const pathField = { type: 'string', description: '相对工作目录的路径' } as const

defineTool({
  name: 'raven.files.list',
  title: '浏览工作目录',
  description:
    '列出 raven 受管工作目录下的文件与文件夹，按修改时间倒序。用来了解「有哪些文件」—— 不要用它猜路径是否存在，先list 再 read。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作目录的路径。留空表示根目录' },
      search: { type: 'string', description: '按文件名或内容搜索' },
    },
  },
  risk: 'read',
  execute: async (args) => {
    const path = optionalString(args, 'path')
    const search = optionalString(args, 'search')
    return listDirectory({
      ...(path !== undefined ? { path } : {}),
      ...(search !== undefined ? { search } : {}),
      sort: 'mtime',
      order: 'desc',
    })
  },
})

defineTool({
  name: 'raven.files.read',
  title: '读取文本文件',
  description:
    '读取 raven 工作目录下某个文本文件的全部内容。超过 1 MiB 会被拒绝 —— 那种情况改用list 看元信息，不要反复重试。',
  inputSchema: {
    type: 'object',
    properties: { path: pathField },
    required: ['path'],
  },
  risk: 'read',
  execute: async (args) => {
    const result = await readTextFile({ path: requireString(args, 'path') })
    return { path: result.path, text: result.text, truncated: result.truncated, size: result.size }
  },
})

defineTool({
  name: 'raven.files.write',
  title: '写入文本文件',
  description:
    '把文本写入 raven 工作目录下的文件，父目录不存在会自动创建。**整体覆盖，不是追加** —— 要追加请自己先read 再拼接。这是破坏性最小的写入口：只影响指定的那一个文件。',
  inputSchema: {
    type: 'object',
    properties: {
      path: pathField,
      text: { type: 'string', description: '完整文件内容。空字符串会写出 0 字节文件' },
      createOnly: {
        type: 'boolean',
        description: 'true = 仅在文件不存在时创建；目标已存在则报错（不会覆盖）',
      },
    },
    required: ['path', 'text'],
  },
  risk: 'write',
  execute: async (args) => {
    const createOnly = booleanArg(args, 'createOnly', false)
    return writeTextFile({
      path: requireString(args, 'path'),
      text: requireText(args, 'text', 2 * 1024 * 1024),
      ...(createOnly ? { createOnly: true } : {}),
    })
  },
})

defineTool({
  name: 'raven.files.mkdir',
  title: '创建目录',
  description: '在 raven 工作目录下创建目录，父目录会一并创建。目标已存在时报错。',
  inputSchema: {
    type: 'object',
    properties: { path: { ...pathField, description: '要创建的目录路径' } },
    required: ['path'],
  },
  risk: 'write',
  execute: async (args) => createDirectory({ path: requireString(args, 'path') }),
})

defineTool({
  name: 'raven.files.move',
  title: '移动 / 改名',
  description:
    '移动文件或目录。**默认不覆盖** —— 目标已存在时报错，要覆盖必须显式传 overwrite: true。跨目录移动与改名用同一个工具，因为底层就是同一个操作。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '源路径' },
      to: { type: 'string', description: '目标路径' },
      overwrite: { type: 'boolean', default: false, description: '目标已存在时是否覆盖。默认 false' },
    },
    required: ['from', 'to'],
  },
  risk: 'write',
  execute: async (args) => {
    const overwrite = booleanArg(args, 'overwrite', false)
    return move({ from: requireString(args, 'from'), to: requireString(args, 'to'), overwrite })
  },
})

defineTool({
  name: 'raven.files.copy',
  title: '复制文件或目录',
  description:
    '复制文件或整个目录。**默认不覆盖**，要覆盖必须显式传 overwrite: true —— 覆盖会删掉目标，所以它是一次真实的删除加一次创建。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '源路径' },
      to: { type: 'string', description: '目标路径' },
      overwrite: { type: 'boolean', default: false, description: '目标已存在时是否覆盖。默认 false' },
    },
    required: ['from', 'to'],
  },
  risk: 'write',
  execute: async (args) => {
    const overwrite = booleanArg(args, 'overwrite', false)
    return copy({ from: requireString(args, 'from'), to: requireString(args, 'to'), overwrite })
  },
})

defineTool({
  name: 'raven.files.rename',
  title: '重命名',
  description:
    '在**同一目录内**改名。这个工具永远不会覆盖目标 —— 看到「目标已存在」就换一个名字，别加 overwrite（那个参数在这里不存在）。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '当前路径' },
      to: { type: 'string', description: '新路径（通常只改文件名部分）' },
    },
    required: ['from', 'to'],
  },
  risk: 'write',
  execute: async (args) => rename({ from: requireString(args, 'from'), to: requireString(args, 'to') }),
})

defineTool({
  name: 'raven.files.remove',
  title: '删除文件或目录',
  description:
    '**永久删除**，不进回收站。删目录会连整个子树一起删。删之前先确认清楚路径 —— 这个操作不可撤销。同一次调用可以传多个 paths，它们会被一起校验、一起删：任何一条不合法则**全部不删**。',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        description: '要删除的路径列表。删除工作目录本身会被拒绝',
        items: { type: 'string' },
      },
    },
    required: ['paths'],
  },
  risk: 'destructive',
  confirmationPhrase: 'delete',
  execute: async (args) => remove({ paths: requireStringArray(args, 'paths') }),
})