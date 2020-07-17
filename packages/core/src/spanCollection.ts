import { RequestCompleteEvent, startRequestCollection } from '.'
import { UserConfiguration } from './configuration'
import { assign } from './utils'

export interface SpanMetadata {
  [key: string]: string
}

export interface SpanMetrics {
  [key: string]: number
}

export interface Span {
  trace_id: string, 
  span_id: string,
  parent_id: string,
  name: string,
  resource: string,
  error: number
  meta: SpanMetadata,
  metrics: SpanMetrics,
  start: number,
  duration: number,
  service: string,
  type: string
}

export interface TraceMetadata {
  [key: string]: string
}

export interface Trace {
  spans: Span[],
  meta: TraceMetadata
}

interface BrowserWindow extends Window {
  ddtrace?: any
}

/* tslint:disable:no-bitwise */
export class TraceIdentifier {
  private buffer: Uint8Array = new Uint8Array(8)

  constructor () {
    window.crypto.getRandomValues(this.buffer)
    this.buffer[0] = this.buffer[0] & 0x7f // force 63-bit
  }

  toString (radix: number = 10) {
    let high = this.readInt32(0)
    let low = this.readInt32(4)
    let str = ''

    while (1) {
      const mod = (high % radix) * 4294967296 + low

      high = Math.floor(high / radix)
      low = Math.floor(mod / radix)
      str = (mod % radix).toString(radix) + str

      if (!high && !low) { break }
    }

    return str
  }

  toJSON () {
    return this.toString()
  }

  private readInt32 (offset: number) {
    return (this.buffer[offset] * 16777216) +
      (this.buffer[offset + 1] << 16) +
      (this.buffer[offset + 2] << 8) +
      this.buffer[offset + 3]
  }
}
/* tslint:enable:no-bitwise */

export function startSpanCollection(userConfiguration: UserConfiguration) {
  const [, requestCompleteObservable] = startRequestCollection()

  requestCompleteObservable.subscribe((data: RequestCompleteEvent) => {
    finishTrace(data, userConfiguration)
  })
}

/**
 * Get the current traceId generated from dd-trace-js (if any).
 *
 * Note: in order to work, the browser-sdk should be initialized *before* dd-trace-js because both
 * libraries are wrapping fetch() and XHR.  Wrappers are called in reverse order, and the
 * dd-trace-js wrapper needs to be called first so it can generate the new trace.  The browser-sdk
 * wrapper will then pick up the new trace id via this function.
 */
export function getTraceIdFromTracer(): TraceIdentifier {
  // tslint:disable-next-line: no-unsafe-any
  return (window as BrowserWindow).ddtrace.tracer
    .scope()
    .active()
    .context()
    ._traceId // internal trace idenfifier
}

export function traceXhr (xhr: XMLHttpRequest): TraceIdentifier {
  return traceAndInject((traceId: TraceIdentifier) => {
    // TODO: add option to add other allowed domains configured for CORS
    if (origin !== window.location.origin) { return }

    xhr.setRequestHeader('x-datadog-trace-id', traceId.toString(10))
    xhr.setRequestHeader('x-datadog-parent-id', traceId.toString(10))
    xhr.setRequestHeader('x-datadog-origin', 'rum')
    xhr.setRequestHeader('x-datadog-sampling-priority', '1')
    xhr.setRequestHeader('x-datadog-sampled', '1')

    return traceId
  })
}

export function traceFetch (init: any): any {
  return traceAndInject((traceId: TraceIdentifier) => {
    // TODO: add option to add other allowed domains configured for CORS
    if (origin !== window.location.origin) { return init }

    init = init || {} // tslint:disable-line:no-parameter-reassignment
    init.headers = init.headers || {}

    const strId = traceId.toString(10)
    const headers = {
      'x-datadog-origin': 'rum',
      'x-datadog-parent-id': strId,
      'x-datadog-sampled': '1',
      'x-datadog-sampling-priority': '1',
      'x-datadog-trace-id': strId
    }

    if (typeof (init.headers as any).set === 'function') {
      Object.keys(name).forEach(name => {
        (init.headers as any).set(name, (headers as any)[name])
      })
    } else {
      assign(init.headers, headers)
    }

    return { init, traceId }
  })
}

function traceAndInject (inject: (traceId: TraceIdentifier) => any): any {
  // tslint:disable-next-line: no-unsafe-any
  if ('ddtrace' in window && (window as BrowserWindow).ddtrace.tracer.scope().active()) {
    return getTraceIdFromTracer()
  }

  const traceId = new TraceIdentifier()

  return inject(traceId)
}

function finishTrace (requestCompleteEvent: RequestCompleteEvent, userConfiguration: UserConfiguration) {
  if (!requestCompleteEvent.traceId) { return }

  const traceId = requestCompleteEvent.traceId.toString(16)
  const globalMeta: SpanMetadata = {}

  if (userConfiguration.env) { globalMeta.env = userConfiguration.env }
  if (userConfiguration.service) { globalMeta.service = userConfiguration.service }
  if (userConfiguration.version) { globalMeta.version = userConfiguration.version }

  const meta = {
    ...globalMeta,
    'http.method': requestCompleteEvent.method,
    'http.url': requestCompleteEvent.url,
    'span.kind': 'client'
  }

  const metrics = {
    '_dd.agent_psr': 1,
    '_sample_rate': 1,
    '_sampling_priority_v1': 1,
    '_top_level': 1,
    'http.status': requestCompleteEvent.status
  }

  const span = {
    meta,
    metrics,
    traceId,
    duration: requestCompleteEvent.duration,
    error: 0, // How to capture the error?
    name: 'browser.request',
    parentId: '0000000000000000',
    resource: requestCompleteEvent.method,
    service: `${meta}-http-client`,
    spanId: traceId,
    start: requestCompleteEvent.startTime,
    type: 'http'
  }

  // How to flush it to the trace endpoint?
}
