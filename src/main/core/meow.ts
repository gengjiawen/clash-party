import { createServer, type AddressInfo } from 'net'
import { randomUUID } from 'crypto'

// meow (https://github.com/meow-rs/meow-rs) 读 mihomo 的配置、提供同样的 REST API，
// 但外部控制器只有 TCP：没有 unix socket / named pipe，命令行参数也是双横线的
// --ext-ctl / --secret。这里集中放和 mihomo 不同的几处。

export interface MeowController {
  // 传给 --ext-ctl 的监听地址
  listen: string
  // 连接用的 host:port，IPv6 带方括号
  address: string
  secret: string
}

function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

// --ext-ctl 会替换配置里的 external-controller：用户自己开了外部控制器（Web 面板要用）时
// 沿用它的地址和 secret，否则用一个随机的回环端口和随机 secret。
export async function resolveMeowController(
  externalController?: string,
  secret?: string
): Promise<MeowController> {
  const configured = externalController?.trim()
  if (configured) {
    const listen = configured.startsWith(':') ? `0.0.0.0${configured}` : configured
    let address = listen
    if (address.startsWith('0.0.0.0:')) address = address.replace('0.0.0.0:', '127.0.0.1:')
    if (address.startsWith('[::]:')) address = address.replace('[::]:', '[::1]:')
    return { listen, address, secret: secret ?? '' }
  }
  const listen = `127.0.0.1:${await pickFreeLoopbackPort()}`
  return { listen, address: listen, secret: randomUUID() }
}

// meow 的 auto-route: true 只把 fake-ip 网段路由进虚拟网卡，接管全部流量的是 auto-route: global。
// 虚拟网卡开关要的是后者：Clash Party 还会把系统 DNS 指向公共 DNS，
// 只路由 fake-ip 网段时这些 DNS 请求根本进不了网卡，也就拿不到 fake-ip。
export function toMeowConfig(config: Partial<IMihomoConfig>): Record<string, unknown> {
  if (config.tun?.['auto-route'] !== true) return { ...config }
  return { ...config, tun: { ...config.tun, 'auto-route': 'global' } }
}
