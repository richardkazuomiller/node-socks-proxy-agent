import { SocksClient, SocksProxy, SocksClientOptions } from 'socks'
import { Agent, ClientRequest, RequestOptions } from 'agent-base'
import createDebug from 'debug'
import dns from 'dns'
import net from 'net'
import tls from 'tls'

import { SocksProxyAgentOptions } from '.'

const debug = createDebug('socks-proxy-agent')

async function dnsLookup (host: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    dns.lookup(host, (err, res) => {
      if (err != null) {
        reject(err)
      } else {
        resolve(res)
      }
    })
  })
}

function parseSocksProxy (
  opts: SocksProxyAgentOptions
): { lookup: boolean, proxy: SocksProxy } {
  let port = 0
  let lookup = false
  let type: SocksProxy['type'] = 5

  const host = opts.hostname

  if (!host) {
    throw new TypeError('No "host"')
  }

  if (typeof opts.port === 'number') {
    port = opts.port
  } else if (typeof opts.port === 'string') {
    port = parseInt(opts.port, 10)
  }

  // From RFC 1928, Section 3: https://tools.ietf.org/html/rfc1928#section-3
  // "The SOCKS service is conventionally located on TCP port 1080"
  if (port == null) {
    port = 1080
  }

  // figure out if we want socks v4 or v5, based on the "protocol" used.
  // Defaults to 5.
  if (opts.protocol != null) {
    switch (opts.protocol.replace(':', '')) {
      case 'socks4':
        lookup = true
        // pass through
      case 'socks4a':
        type = 4
        break
      case 'socks5':
        lookup = true
        // pass through
      case 'socks': // no version specified, default to 5h
      case 'socks5h':
        type = 5
        break
      default:
        throw new TypeError(`A "socks" protocol must be specified! Got: ${String(opts.protocol)}`)
    }
  }

  if (typeof opts.type !== 'undefined') {
    if (opts.type === 4 || opts.type === 5) {
      type = opts.type
    } else {
      throw new TypeError(`"type" must be 4 or 5, got: ${String(opts.type)}`)
    }
  }

  const proxy: SocksProxy = {
    host,
    port,
    type
  }

  let userId = opts.userId ?? opts.username
  let password = opts.password
  if (opts.auth != null) {
    const auth = opts.auth.split(':')
    userId = auth[0]
    password = auth[1]
  }
  if (userId != null) {
    Object.defineProperty(proxy, 'userId', {
      value: userId,
      enumerable: false
    })
  }
  if (password != null) {
    Object.defineProperty(proxy, 'password', {
      value: password,
      enumerable: false
    })
  }

  return { lookup, proxy }
}

/**
 * The `SocksProxyAgent`.
 *
 * @api public
 */
export default class SocksProxyAgent extends Agent {
  private readonly lookup: boolean
  private readonly proxy: SocksProxy
  private readonly tlsConnectionOptions: tls.ConnectionOptions

  constructor (input: string | SocksProxyAgentOptions) {
    let opts: SocksProxyAgentOptions
    if (typeof input === 'string') {
      opts = new URL(input)
    } else {
      opts = input
    }
    if (opts == null) {
      throw new TypeError('a SOCKS proxy server `host` and `port` must be specified!')
    }
    super(opts)

    const parsedProxy = parseSocksProxy(opts)
    this.lookup = parsedProxy.lookup
    this.proxy = parsedProxy.proxy
    this.tlsConnectionOptions = opts.tls != null ? opts.tls : {}
  }

  /**
   * Initiates a SOCKS connection to the specified SOCKS proxy server,
   * which in turn connects to the specified remote host and port.
   *
   * @api protected
  */
  async callback (
    req: ClientRequest,
    opts: RequestOptions
  ): Promise<net.Socket> {
    const { lookup, proxy } = this
    let { host, port, timeout } = opts

    if (host == null) {
      throw new Error('No `host` defined!')
    }

    if (lookup) {
      // Client-side DNS resolution for "4" and "5" socks proxy versions.
      host = await dnsLookup(host)
    }

    const socksOpts: SocksClientOptions = {
      proxy,
      destination: { host, port },
      command: 'connect',
      timeout
    }
    debug('Creating socks proxy connection: %o', socksOpts)
    const { socket } = await SocksClient.createConnection(socksOpts)
    debug('Successfully created socks proxy connection')

    if (opts.secureEndpoint) {
      // The proxy is connecting to a TLS server, so upgrade
      // this socket connection to a TLS connection.
      debug('Upgrading socket connection to TLS')
      const servername = opts.servername || opts.host
      return tls.connect({
        ...omit(opts, 'host', 'hostname', 'path', 'port'),
        socket,
        servername,
        ...this.tlsConnectionOptions
      })
    }

    return socket
  }
}

function omit<T extends object, K extends [...Array<keyof T>]> (
  obj: T,
  ...keys: K
): {
    [K2 in Exclude<keyof T, K[number]>]: T[K2];
  } {
  const ret = {} as { [K in keyof typeof obj]: (typeof obj)[K]; }
  let key: keyof typeof obj
  for (key in obj) {
    if (!keys.includes(key)) {
      ret[key] = obj[key]
    }
  }
  return ret
}
