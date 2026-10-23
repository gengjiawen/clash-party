import { describe, it, expect } from 'vitest'
import { meowControllerChanged, resolveMeowController, toMeowConfig } from './meow'

describe('resolveMeowController', () => {
  it('reuses the configured external controller and secret', async () => {
    await expect(resolveMeowController('127.0.0.1:9090', 'abc')).resolves.toEqual({
      listen: '127.0.0.1:9090',
      address: '127.0.0.1:9090',
      secret: 'abc',
      configured: true
    })
  })

  it('connects to loopback when the controller listens on every interface', async () => {
    await expect(resolveMeowController(':9090')).resolves.toEqual({
      listen: '0.0.0.0:9090',
      address: '127.0.0.1:9090',
      secret: '',
      configured: true
    })
    await expect(resolveMeowController('[::]:9090', 's')).resolves.toEqual({
      listen: '[::]:9090',
      address: '[::1]:9090',
      secret: 's',
      configured: true
    })
  })

  it('picks a random loopback port and secret when no controller is configured', async () => {
    const a = await resolveMeowController('')
    const b = await resolveMeowController(undefined, 'ignored')
    expect(a.listen).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(a.address).toBe(a.listen)
    expect(a.configured).toBe(false)
    expect(a.secret).not.toBe('')
    expect(b.secret).not.toBe('ignored')
    expect(b.secret).not.toBe(a.secret)
  })
})

describe('meowControllerChanged', () => {
  it('detects a new address or secret for a configured controller', async () => {
    const controller = await resolveMeowController(':9090', 'abc')
    expect(meowControllerChanged(controller, ':9090', 'abc')).toBe(false)
    expect(meowControllerChanged(controller, ' :9090 ', 'abc')).toBe(false)
    expect(meowControllerChanged(controller, '0.0.0.0:9090', 'abc')).toBe(false)
    expect(meowControllerChanged(controller, ':9091', 'abc')).toBe(true)
    expect(meowControllerChanged(controller, ':9090', 'xyz')).toBe(true)
    expect(meowControllerChanged(controller, '', 'abc')).toBe(true)
  })

  it('only changes a random controller when one gets configured', async () => {
    const controller = await resolveMeowController('')
    expect(meowControllerChanged(controller, '', 'new-secret')).toBe(false)
    expect(meowControllerChanged(controller, undefined)).toBe(false)
    expect(meowControllerChanged(controller, '127.0.0.1:9090', 'abc')).toBe(true)
  })
})

describe('toMeowConfig', () => {
  it('maps auto-route: true to global', () => {
    const config = { tun: { enable: true, 'auto-route': true } } as Partial<IMihomoConfig>
    expect(toMeowConfig(config)).toEqual({ tun: { enable: true, 'auto-route': 'global' } })
    expect(config.tun?.['auto-route']).toBe(true)
  })

  it('leaves other configs untouched', () => {
    const off = { tun: { enable: true, 'auto-route': false } } as Partial<IMihomoConfig>
    expect(toMeowConfig(off)).toEqual(off)
    expect(toMeowConfig({ 'mixed-port': 7890 })).toEqual({ 'mixed-port': 7890 })
  })
})
