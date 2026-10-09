/**
 * 工具注册入口。**import 这个模块 = 把全部工具注册进注册表。**
 *
 * ⚠️ 新增一个工具文件必须在这里 import，否则它永远不会被注册 ——
 * 而注册表不会报错，只是 `listTools` 里少一个工具。
 * 「少一个工具」比「抛异常」难查得多，所以这行 import 是刻意的显式清单。
 */

import './files'
import './shell'
import './workspace'

export { allTools, findTool, listToolsData, toolNames } from './registry'
export type { ToolContext, ToolExecutor } from './registry'
