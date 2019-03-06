import { Context } from './context'
import { Message } from './logger'
import { monitor } from './monitoring'

/**
 * Use POST request without content type to:
 * - avoid CORS preflight requests
 * - allow usage of sendBeacon
 *
 * multiple elements are sent separated by \n in order
 * to be parsed correctly without content type header
 */
export class HttpRequest {
  constructor(private endpointUrl: string, private bytesLimit: number) {}

  send(data: string, size: number) {
    if (navigator.sendBeacon && size < this.bytesLimit) {
      navigator.sendBeacon(this.endpointUrl, data)
    } else {
      const request = new XMLHttpRequest()
      request.open('POST', this.endpointUrl, true)
      request.send(data)
    }
  }
}

export class Batch {
  private buffer: string[] = []
  private bufferBytesSize = 0

  constructor(
    private request: HttpRequest,
    private maxSize: number,
    private bytesLimit: number,
    private flushTimeout: number,
    private contextProvider: () => Context
  ) {
    flushOnVisibilityHidden(this)
    this.flushTic()
  }

  add(message: Message) {
    const { processedMessage, messageBytesSize } = this.process(message)
    if (this.willReachedBytesLimitWith(messageBytesSize)) {
      this.flush()
    }
    this.push(processedMessage, messageBytesSize)
    if (this.isFull()) {
      this.flush()
    }
  }

  flush() {
    if (this.buffer.length !== 0) {
      this.request.send(this.buffer.join('\n'), this.bufferBytesSize + this.buffer.length - 1)
      this.buffer = []
      this.bufferBytesSize = 0
    }
  }

  private flushTic() {
    setTimeout(() => {
      this.flush()
      this.flushTic()
    }, this.flushTimeout)
  }

  private process(message: Message) {
    const processedMessage = JSON.stringify({ ...message, ...this.contextProvider() })
    const messageBytesSize = sizeInBytes(processedMessage)
    return { processedMessage, messageBytesSize }
  }

  private push(processedMessage: string, messageBytesSize: number) {
    this.buffer.push(processedMessage)
    this.bufferBytesSize += messageBytesSize
  }

  private willReachedBytesLimitWith(messageBytesSize: number) {
    // n + 1 elements, n bytes of separator
    const separatorsBytesSize = this.buffer.length
    return this.bufferBytesSize + messageBytesSize + separatorsBytesSize >= this.bytesLimit
  }

  private isFull() {
    return this.buffer.length === this.maxSize || this.bufferBytesSize >= this.bytesLimit
  }
}

function sizeInBytes(candidate: string) {
  // tslint:disable-next-line no-bitwise
  return ~-encodeURI(candidate).split(/%..|./).length
}

const beforeFlushOnUnloadHandlers: Array<() => void> = []

export function beforeFlushOnUnload(handler: () => void) {
  beforeFlushOnUnloadHandlers.push(handler)
}

export function flushOnVisibilityHidden(batch: Batch) {
  /**
   * With sendBeacon, requests are guaranteed to be successfully sent during document unload
   */
  if (navigator.sendBeacon) {
    /**
     * beforeunload is called before visibilitychange
     * register first to be sure to be called before flush on beforeunload
     * caveat: unload can still be canceled by another listener
     */
    window.addEventListener(
      'beforeunload',
      monitor(() => {
        beforeFlushOnUnloadHandlers.forEach((handler) => handler())
      })
    )

    /**
     * Only event that guarantee to fire on mobile devices when the page transitions to background state
     * (e.g. when user switches to a different application, goes to homescreen, etc), or is being unloaded.
     */
    document.addEventListener(
      'visibilitychange',
      monitor(() => {
        if (document.visibilityState === 'hidden') {
          batch.flush()
        }
      })
    )
    /**
     * Safari does not support yet to send a request during:
     * - a visibility change during doc unload (cf: https://bugs.webkit.org/show_bug.cgi?id=194897)
     * - a page hide transition (cf: https://bugs.webkit.org/show_bug.cgi?id=188329)
     */
    window.addEventListener('beforeunload', monitor(() => batch.flush()))
  }
}
