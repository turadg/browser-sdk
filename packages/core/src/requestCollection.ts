import { toStackTraceString } from './errorCollection'
import { monitor } from './internalMonitoring'
import { Observable } from './observable'
import { computeStackTrace } from './tracekit'
import { normalizeUrl } from './urlPolyfill'
import { ResourceKind } from './utils'
import { traceFetch, traceXhr, TraceIdentifier } from './spanCollection'

export enum RequestType {
  FETCH = ResourceKind.FETCH,
  XHR = ResourceKind.XHR,
}

export interface RequestStartEvent {
  requestId: number
}

export interface RequestCompleteEvent {
  requestId: number
  type: RequestType
  method: string
  url: string
  status: number
  response?: string
  responseType?: string
  startTime: number
  duration: number
  traceId?: TraceIdentifier
}

interface BrowserXHR extends XMLHttpRequest {
  _datadog_xhr: {
    method: string
    url: string
  }
}

export type RequestObservables = [Observable<RequestStartEvent>, Observable<RequestCompleteEvent>]

let nextRequestId = 1

function getNextRequestId() {
  const result = nextRequestId
  nextRequestId += 1
  return result
}

let requestObservablesSingleton: RequestObservables

export function startRequestCollection() {
  if (!requestObservablesSingleton) {
    requestObservablesSingleton = [new Observable(), new Observable()]
    trackXhr(requestObservablesSingleton)
    trackFetch(requestObservablesSingleton)
  }
  return requestObservablesSingleton
}

export function trackXhr([requestStartObservable, requestCompleteObservable]: RequestObservables) {
  const originalOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = monitor(function(this: BrowserXHR, method: string, url: string) {
    this._datadog_xhr = {
      method,
      url,
    }
    return originalOpen.apply(this, arguments as any)
  })

  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = function(this: BrowserXHR, body: unknown) {
    const startTime = performance.now()
    const requestId = getNextRequestId()
    const traceId = traceXhr(this)

    requestStartObservable.notify({
      requestId,
    })

    let hasBeenReported = false
    const reportXhr = () => {
      if (hasBeenReported) {
        return
      }
      hasBeenReported = true
      requestCompleteObservable.notify({
        requestId,
        startTime,
        duration: performance.now() - startTime,
        method: this._datadog_xhr.method,
        response: this.response as string | undefined,
        status: this.status,
        traceId,
        type: RequestType.XHR,
        url: normalizeUrl(this._datadog_xhr.url),
      })
    }

    const originalOnreadystatechange = this.onreadystatechange

    this.onreadystatechange = function() {
      if (this.readyState === XMLHttpRequest.DONE) {
        monitor(reportXhr)()
      }

      if (originalOnreadystatechange) {
        originalOnreadystatechange.apply(this, arguments as any)
      }
    }

    this.addEventListener('loadend', monitor(reportXhr))

    return originalSend.apply(this, arguments as any)
  }
}

export function trackFetch([requestStartObservable, requestCompleteObservable]: RequestObservables) {
  if (!window.fetch) {
    return
  }
  const originalFetch = window.fetch
  // tslint:disable promise-function-async
  window.fetch = monitor(function(this: WindowOrWorkerGlobalScope['fetch'], input: RequestInfo, init?: RequestInit) {
    const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET'
    const startTime = performance.now()
    const requestId = getNextRequestId()
    const traceResult = traceFetch(init)
    const traceId = traceResult.traceId

    init = traceResult.init

    requestStartObservable.notify({
      requestId,
    })

    const reportFetch = async (response: Response | Error) => {
      const duration = performance.now() - startTime
      const url = normalizeUrl((typeof input === 'object' && input.url) || (input as string))
      if ('stack' in response || response instanceof Error) {
        const stackTrace = computeStackTrace(response)
        requestCompleteObservable.notify({
          duration,
          method,
          requestId,
          startTime,
          url,
          response: toStackTraceString(stackTrace),
          status: 0,
          traceId,
          type: RequestType.FETCH,
        })
      } else if ('status' in response) {
        let text: string
        try {
          text = await response.clone().text()
        } catch (e) {
          text = `Unable to retrieve response: ${e}`
        }
        requestCompleteObservable.notify({
          duration,
          method,
          requestId,
          startTime,
          url,
          response: text,
          responseType: response.type,
          status: response.status,
          traceId,
          type: RequestType.FETCH,
        })
      }
    }
    const responsePromise = originalFetch.call(this, input, init)
    responsePromise.then(monitor(reportFetch), monitor(reportFetch))
    return responsePromise
  })
}

export function isRejected(request: RequestCompleteEvent) {
  return request.status === 0 && request.responseType !== 'opaque'
}

export function isServerError(request: RequestCompleteEvent) {
  return request.status >= 500
}
