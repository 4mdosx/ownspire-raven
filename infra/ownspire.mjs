#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createPrompt, isInteractive } from './lib/prompt.mjs'
import { service as navi } from './services/navi/index.mjs'
import { service as atlas } from './services/atlas/index.mjs'
import { service as raven } from './services/raven/index.mjs'

const services = [navi, atlas, raven]

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(realpathSync(entry)).href
}

function usage() {
  const lines = ['用法', '  node ownspire.mjs', '  node ownspire.mjs <服务> <操作> [参数]', '', '服务']
  for (const service of services) {
    lines.push(`  ${service.id}  ${service.summary}`)
    for (const action of service.actions) {
      const hint = action.usage ? ` ${action.usage}` : ''
      lines.push(`    ${action.id}${hint}  ${action.label}`)
    }
  }
  console.log(lines.join('\n'))
}

async function choose(prompt, title, items) {
  for (;;) {
    console.log(`\n${title}`)
    for (const item of items) console.log(`  ${item.key}) ${item.label}`)
    const answer = (await prompt.ask('\n> ')).trim().toLowerCase()
    const found = items.find((item) => item.key === answer)
    if (found) return found
    console.log('没有这个选项。')
  }
}

async function runInteractive(prompt) {
  console.log('Ownspire')
  console.log('选择要部署的服务，再选择这个服务的运维操作。')
  for (;;) {
    const picked = await choose(prompt, '服务', [
      ...services.map((service, index) => ({
        key: String(index + 1),
        label: `${service.title} — ${service.summary}`,
        service,
      })),
      { key: 'q', label: '退出', quit: true },
    ])
    if (picked.quit) return

    for (;;) {
      const action = await choose(prompt, picked.service.title, [
        ...picked.service.actions.map((item, index) => ({
          key: String(index + 1),
          label: item.label,
          action: item,
        })),
        { key: 'b', label: '返回', back: true },
      ])
      if (action.back) break
      console.log('')
      try {
        const result = await action.action.run({ args: [], prompt, yes: false })
        if (result === null) console.log('已取消。')
      } catch (error) {
        console.error(error instanceof Error ? error.message : error)
      }
    }
  }
}

async function runDirect(argv) {
  const [serviceId, actionId, ...rest] = argv
  if (serviceId === '-h' || serviceId === '--help') {
    usage()
    return
  }
  const service = services.find((item) => item.id === serviceId)
  if (!service) {
    console.error(`没有服务 ${serviceId}。`)
    usage()
    process.exitCode = 1
    return
  }
  if (!actionId) {
    console.error(`${service.id} 需要指定操作。`)
    usage()
    process.exitCode = 1
    return
  }
  const action = service.actions.find((item) => item.id === actionId)
  if (!action) {
    console.error(`${service.id} 没有操作 ${actionId}。`)
    usage()
    process.exitCode = 1
    return
  }

  const yes = rest.includes('--yes')
  const args = rest.filter((item) => item !== '--yes')
  const prompt = isInteractive() ? createPrompt() : null
  try {
    const result = await action.run({ args, prompt, yes })
    if (result === null) console.log('已取消。')
  } finally {
    prompt?.close()
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    if (!isInteractive()) {
      usage()
      process.exitCode = 1
      return
    }
    const prompt = createPrompt()
    try {
      await runInteractive(prompt)
    } finally {
      prompt.close()
    }
    return
  }
  await runDirect(argv)
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
