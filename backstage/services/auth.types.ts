import { z } from 'zod'

/**
 * PIN 的输入契约。
 *
 * 校验放在这里而不是散在各个 route 里，是为了让「什么是合法 PIN」只有一个定义。
 * 前端的输入框数量、提交前的本地校验、服务端的最终判定，全部由 `PIN_LENGTH` 派生 ——
 * 改长度只改这一处。
 */

export const PIN_LENGTH = 4

export const PinSchema = z
  .string()
  .regex(new RegExp(`^\\d{${PIN_LENGTH}}$`), `PIN 需为 ${PIN_LENGTH} 位数字`)

/** 首次设置：PIN + 确认。两次不一致是**服务端**判的，不靠前端提示。 */
export const SetupPinSchema = z
  .object({
    pin: PinSchema,
    confirmPin: PinSchema,
  })
  .refine((value) => value.pin === value.confirmPin, {
    message: '两次输入的 PIN 不一致',
    path: ['confirmPin'],
  })

/** 解锁：只要 PIN。 */
export const UnlockPinSchema = z.object({
  pin: PinSchema,
})

/** 改 PIN：必须先验当前 PIN，否则拿到会话的人就能永久把自己锁在外面（或反过来放别人进）。 */
export const UpdatePinSchema = z
  .object({
    currentPin: PinSchema,
    pin: PinSchema,
    confirmPin: PinSchema,
  })
  .refine((value) => value.pin === value.confirmPin, {
    message: '两次输入的 PIN 不一致',
    path: ['confirmPin'],
  })

export type SetupPinInput = z.infer<typeof SetupPinSchema>
export type UnlockPinInput = z.infer<typeof UnlockPinSchema>
export type UpdatePinInput = z.infer<typeof UpdatePinSchema>

/** 字段级错误，形状对齐 zod 的 `flatten().fieldErrors`。 */
export type PinFieldErrors = Record<string, string[] | undefined>
